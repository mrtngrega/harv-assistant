import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ChatUsage, EffortLevel, HarvUsage, PlanMeter, RouteSource } from '@harv/shared';


const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS routes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL,
    at         INTEGER NOT NULL,
    model      TEXT NOT NULL,
    effort     TEXT NOT NULL,
    source     TEXT NOT NULL,
    reason     TEXT NOT NULL,
    category   TEXT,
    difficulty INTEGER,
    stakes     TEXT,
    feedback   TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER
  );
  CREATE INDEX IF NOT EXISTS routes_by_chat ON routes(chat_id, id);
`;

const METER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meter_log (at INTEGER NOT NULL, kind TEXT NOT NULL, percent REAL NOT NULL, resets_at INTEGER);
  CREATE INDEX IF NOT EXISTS meter_log_by_kind ON meter_log(kind, at);
`;
const DAY_MS = 24 * 60 * 60 * 1000;
const METER_LOG_EVERY_MS = 30 * 60 * 1000;
const METER_LOG_KEEP_MS = 30 * DAY_MS;
/** The cost guide reads this many days back. */
const GUIDE_DAYS = 14;
/** A meter window counts for the rate only with at least this much of Harv's own spend in it (1% steps are coarse). */
const MIN_WINDOW_USD = 0.5;
/** And only once there are this many such windows. */
const MIN_WINDOWS = 2;

/** The q-quantile of some numbers (linear between neighbours). */
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (i - lo);
}

/** What replies cost here (`RouteStore.costGuide`), for Harv's usage estimates (the user's report note, 2026-11-25). */
export interface CostGuide {
  /** How many % of the 5-hour session one notional dollar moved the meter (undefined until enough windows). */
  sessionPerUsd?: number;
  /** The same for the weekly all-models meter. */
  weeklyPerUsd?: number;
  /** How many session windows the rate came from. */
  windows: number;
  /** A reply's notional cost by model·effort: the median and the dear end (90th percentile), in USD. */
  perReply: { pick: string; replies: number; median: number; p90: number }[];
}

export interface RouteEntry {
  chatId: string;
  model: string;
  effort: EffortLevel;
  source: RouteSource;
  reason: string;
  category?: string;
  difficulty?: number;
  stakes?: string;
}

/**
 * The router's log: every turn's model·effort and why, whether the user asked to
 * try harder, and the tokens it used. Tunes the table and feeds Harv's own usage stats.
 */
export class RouteStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // The first M6 databases lack the token columns.
    const columns = this.db.prepare('PRAGMA table_info(routes)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'input_tokens')) {
      this.db.exec('ALTER TABLE routes ADD COLUMN input_tokens INTEGER; ALTER TABLE routes ADD COLUMN output_tokens INTEGER;');
    }
    // Sync (M10b): rows both devices share, and which came from the other one (its turns count in Harv's stats here too).
    if (!columns.some((c) => c.name === 'uid')) {
      this.db.exec('ALTER TABLE routes ADD COLUMN uid TEXT; ALTER TABLE routes ADD COLUMN remote INTEGER NOT NULL DEFAULT 0;');
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS routes_by_uid ON routes(uid)');
    // Each turn's notional cost (2026-11-26), and the meter's readings, for the cost guide.
    if (!columns.some((c) => c.name === 'cost_usd')) this.db.exec('ALTER TABLE routes ADD COLUMN cost_usd REAL');
    this.db.exec(METER_SCHEMA);
    const missing = this.db.prepare('SELECT id FROM routes WHERE uid IS NULL').all() as { id: number }[];
    if (missing.length) {
      const set = this.db.prepare('UPDATE routes SET uid = ? WHERE id = ?');
      this.db.exec('BEGIN');
      for (const { id } of missing) set.run(randomUUID(), id);
      this.db.exec('COMMIT');
    }
  }

  close(): void {
    this.db.close();
  }

  /** This device's latest row for a chat (the other device's turns in the same chat don't count). */
  private lastId(chatId: string): number | undefined {
    return (
      (
        this.db.prepare('SELECT MAX(id) AS id FROM routes WHERE chat_id = ? AND remote = 0').get(chatId) as
          { id: number | null } | undefined
      )?.id ?? undefined
    );
  }

  add(e: RouteEntry): void {
    this.db
      .prepare(
        'INSERT INTO routes (chat_id, at, model, effort, source, reason, category, difficulty, stakes, uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        e.chatId,
        Date.now(),
        e.model,
        e.effort,
        e.source,
        e.reason,
        e.category ?? null,
        e.difficulty ?? null,
        e.stakes ?? null,
        randomUUID(),
      );
  }

  /** Feedback on a chat's latest decision ("harder" = the user asked for more). */
  markLast(chatId: string, feedback: string): void {
    const id = this.lastId(chatId);
    this.db.prepare('UPDATE routes SET feedback = ? WHERE id = ?').run(feedback, id ?? null);
  }

  /** How often the user asked to try harder on this kind of task (same category and difficulty) since `sinceMs`. */
  harderStats(category: string, difficulty: number, sinceMs: number): { turns: number; harder: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS turns, SUM(feedback = 'harder') AS harder FROM routes
         WHERE lower(category) = lower(?) AND difficulty = ? AND at >= ? AND source IN ('classifier', 'followup', 'rule')`,
      )
      .get(category, difficulty, sinceMs) as { turns: number; harder: number | null };
    return { turns: row.turns, harder: row.harder ?? 0 };
  }

  /** The tokens a chat's latest turn used. */
  finishLast(chatId: string, usage: ChatUsage): void {
    const id = this.lastId(chatId);
    this.db
      .prepare('UPDATE routes SET input_tokens = ?, output_tokens = ?, cost_usd = ? WHERE id = ?')
      .run(usage.inputTokens, usage.outputTokens, usage.costUsd ?? null, id ?? null);
  }

  /**
   * A `/usage` reading of the session and weekly meters, kept for the cost guide: a new row when a
   * value or its reset changed, else at most every 30 minutes; 30 days kept.
   */
  logMeter(meters: PlanMeter[], at = Date.now()): void {
    const last = this.db.prepare('SELECT at, percent, resets_at AS resetsAt FROM meter_log WHERE kind = ? ORDER BY at DESC LIMIT 1');
    const add = this.db.prepare('INSERT INTO meter_log (at, kind, percent, resets_at) VALUES (?, ?, ?, ?)');
    for (const m of meters) {
      if (m.kind !== 'session' && m.kind !== 'weekly_all') continue;
      const prev = last.get(m.kind) as { at: number; percent: number; resetsAt: number | null } | undefined;
      const same = prev && prev.percent === m.percent && prev.resetsAt === (m.resetsAt ?? null);
      if (same && at - prev.at < METER_LOG_EVERY_MS) continue;
      add.run(at, m.kind, m.percent, m.resetsAt ?? null);
    }
    this.db.prepare('DELETE FROM meter_log WHERE at < ?').run(at - METER_LOG_KEEP_MS);
  }

  /**
   * What replies cost here, from the last two weeks: each reply's notional cost by model·effort, and how
   * many % of the session (and of the week) one dollar of it moved the meter. The meter counts every use
   * of the plan (Claude Code sessions too, the other computer's are in these rows), so other use only
   * makes a window look dearer: the lower quartile of the windows is taken, not the mean.
   */
  costGuide(now = Date.now()): CostGuide {
    const since = now - GUIDE_DAYS * DAY_MS;
    const costs = this.db.prepare('SELECT SUM(cost_usd) AS usd FROM routes WHERE at >= ? AND at <= ? AND cost_usd IS NOT NULL');
    const rate = (kind: string, windowOf: (r: { at: number; resetsAt: number | null }) => string) => {
      const rows = this.db
        .prepare('SELECT at, percent, resets_at AS resetsAt FROM meter_log WHERE kind = ? AND at >= ? ORDER BY at')
        .all(kind, since) as { at: number; percent: number; resetsAt: number | null }[];
      const windows = new Map<string, { at: number; percent: number }[]>();
      for (const r of rows) windows.set(windowOf(r), [...(windows.get(windowOf(r)) ?? []), r]);
      const ratios: number[] = [];
      for (const w of windows.values()) {
        if (w.length < 2) continue;
        const moved = w.at(-1)!.percent - w[0]!.percent;
        const usd = (costs.get(w[0]!.at, w.at(-1)!.at) as { usd: number | null }).usd ?? 0;
        if (moved >= 1 && usd >= MIN_WINDOW_USD) ratios.push(moved / usd);
      }
      return ratios.length >= MIN_WINDOWS ? { perUsd: quantile(ratios, 0.25), windows: ratios.length } : undefined;
    };
    const session = rate('session', (r) => String(r.resetsAt));
    const weekly = rate('weekly_all', (r) => `${r.resetsAt}:${Math.floor(r.at / DAY_MS)}`);
    const byModel = new Map<string, number[]>();
    const rows = this.db.prepare('SELECT model, effort, cost_usd AS usd FROM routes WHERE at >= ? AND cost_usd > 0').all(since) as {
      model: string;
      effort: string;
      usd: number;
    }[];
    for (const r of rows) byModel.set(`${r.model}·${r.effort}`, [...(byModel.get(`${r.model}·${r.effort}`) ?? []), r.usd]);
    const perReply = [...byModel]
      .filter(([, xs]) => xs.length >= 3)
      .map(([pick, xs]) => ({ pick, replies: xs.length, median: quantile(xs, 0.5), p90: quantile(xs, 0.9) }))
      .sort((a, b) => b.replies - a.replies);
    return { sessionPerUsd: session?.perUsd, weeklyPerUsd: weekly?.perUsd, windows: session?.windows ?? 0, perReply };
  }

  /** Harv's own usage: today's turns and tokens, and the last week's routing split. */
  summary(now = new Date()): HarvUsage {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const today = this.db
      .prepare('SELECT COUNT(*) AS turns, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM routes WHERE at >= ?')
      .get(midnight) as { turns: number; input: number | null; output: number | null };
    return {
      turnsToday: today.turns,
      inputTokensToday: today.input ?? 0,
      outputTokensToday: today.output ?? 0,
      split: this.split(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    };
  }

  /** How many turns ran on each model·effort (the routing split). */
  split(sinceMs = 0): { model: string; effort: EffortLevel; turns: number; harder: number }[] {
    return (
      this.db
        .prepare(
          `SELECT model, effort, COUNT(*) AS turns, SUM(feedback = 'harder') AS harder
         FROM routes WHERE at >= ? GROUP BY model, effort ORDER BY turns DESC`,
        )
        .all(sinceMs) as { model: string; effort: EffortLevel; turns: number; harder: number | null }[]
    ).map((r) => ({ ...r, harder: r.harder ?? 0 }));
  }
}
