import { DatabaseSync } from 'node:sqlite';
import type { ActionEntry, ActionStatus, Tier } from '@harv/shared';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS actions (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL,
    at         INTEGER NOT NULL,
    tool       TEXT NOT NULL,
    tier       TEXT NOT NULL,
    summary    TEXT NOT NULL,
    reason     TEXT NOT NULL,
    input      TEXT NOT NULL,
    status     TEXT NOT NULL,
    backup_dir TEXT,
    backups    TEXT NOT NULL DEFAULT '[]',
    result     TEXT
  );
  CREATE INDEX IF NOT EXISTS actions_by_time ON actions(at);
  CREATE TABLE IF NOT EXISTS held (
    chat_id TEXT NOT NULL,
    n       INTEGER NOT NULL,
    key     TEXT NOT NULL,
    summary TEXT NOT NULL,
    at      INTEGER NOT NULL,
    PRIMARY KEY (chat_id, n)
  );
`;

/** An ask-first call waiting for the user's yes in a chat (safety/gate.ts `hold`); kept so a restart doesn't forget it. */
export interface HeldRow {
  n: number;
  key: string;
  summary: string;
  at: number;
}

type Row = {
  id: string;
  chat_id: string;
  at: number;
  tool: string;
  tier: Tier;
  summary: string;
  reason: string;
  status: ActionStatus;
  backup_dir: string | null;
  backups: string;
  result: string | null;
};

const toEntry = (r: Row): ActionEntry => ({
  id: r.id,
  tabId: r.chat_id,
  at: r.at,
  tool: r.tool,
  tier: r.tier,
  summary: r.summary,
  reason: r.reason,
  status: r.status,
  backups: JSON.parse(r.backups) as string[],
  canUndo: r.status === 'done' && r.backup_dir !== null,
  ...(r.result ? { result: r.result } : {}),
});

/** The full action log: every tool call Harv makes, with its tier, outcome and backup. */
export class ActionStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  add(a: Omit<ActionEntry, 'canUndo' | 'backups' | 'result'> & { input: unknown }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO actions (id, chat_id, at, tool, tier, summary, reason, input, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.tabId, a.at, a.tool, a.tier, a.summary, a.reason, JSON.stringify(a.input), a.status);
  }

  update(id: string, fields: { status?: ActionStatus; result?: string; backupDir?: string; backups?: string[]; input?: unknown }): void {
    const columns: [string, string | undefined][] = [
      ['status', fields.status],
      ['result', fields.result],
      ['backup_dir', fields.backupDir],
      ['backups', fields.backups && JSON.stringify(fields.backups)],
      ['input', fields.input !== undefined ? JSON.stringify(fields.input) : undefined],
    ];
    const set = columns.filter((c): c is [string, string] => c[1] !== undefined);
    if (set.length === 0) return;
    this.db
      .prepare(`UPDATE actions SET ${set.map(([name]) => `${name} = ?`).join(', ')} WHERE id = ?`)
      .run(...set.map(([, value]) => value), id);
  }

  get(id: string): ActionEntry | null {
    const row = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  backupDir(id: string): string | null {
    return (
      (this.db.prepare('SELECT backup_dir FROM actions WHERE id = ?').get(id) as { backup_dir: string | null } | undefined)?.backup_dir ??
      null
    );
  }

  /** The action a backup folder belongs to (Settings › Safety › Backups shows what it was and offers Restore). */
  byBackupDir(dir: string): ActionEntry | null {
    const row = this.db.prepare('SELECT * FROM actions WHERE backup_dir = ? ORDER BY at DESC LIMIT 1').get(dir) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /** Backups that were cleaned up: their actions keep their log line but lose Undo. */
  forgetBackups(dirs: string[]): void {
    const stmt = this.db.prepare('UPDATE actions SET backup_dir = NULL WHERE backup_dir = ?');
    for (const dir of dirs) stmt.run(dir);
  }

  /** Newest first; green (read-only) calls are left out unless asked for. */
  recent(limit = 50, includeGreen = false): ActionEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM actions ${includeGreen ? '' : "WHERE tier != 'green'"} ORDER BY at DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map(toEntry);
  }

  /** Replaces what waits for the user's yes in a chat (an empty list clears it). Grants are never kept: a yes must be fresh. */
  setHeld(chatId: string, items: HeldRow[]): void {
    this.db.prepare('DELETE FROM held WHERE chat_id = ?').run(chatId);
    const stmt = this.db.prepare('INSERT INTO held (chat_id, n, key, summary, at) VALUES (?, ?, ?, ?, ?)');
    for (const i of items) stmt.run(chatId, i.n, i.key, i.summary, i.at);
  }

  /**
   * A deleted chat: what it held goes, and its actions keep only their one-line summary (the commands
   * and written text stayed readable in harv.db: the full review, D18). Backups and Undo don't use the input.
   */
  forgetChat(chatId: string): void {
    this.db.prepare('DELETE FROM held WHERE chat_id = ?').run(chatId);
    this.db.prepare("UPDATE actions SET input = '{}', result = NULL WHERE chat_id = ?").run(chatId);
  }

  /** Everything still held, per chat (read once at start). */
  allHeld(): Map<string, HeldRow[]> {
    const rows = this.db.prepare('SELECT chat_id, n, key, summary, at FROM held ORDER BY chat_id, n').all() as unknown as (HeldRow & {
      chat_id: string;
    })[];
    const out = new Map<string, HeldRow[]>();
    for (const { chat_id, ...item } of rows) out.set(chat_id, [...(out.get(chat_id) ?? []), item]);
    return out;
  }

  /** Actions still pending or running when Harv stopped can't finish any more. */
  markInterrupted(): void {
    this.db
      .prepare("UPDATE actions SET status = 'failed', result = 'Harv restarted before it finished.' WHERE status IN ('pending', 'running')")
      .run();
  }
}
