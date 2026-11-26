import { query, type SDKRateLimitInfo, type SDKUsageReport } from '@anthropic-ai/claude-agent-sdk';
import type { HarvUsage, PlanMeter, PlanUsage, UsageWarning } from '@harv/shared';
import { buildOptions, SUBSCRIPTION_KEY_SOURCES } from '../agent/options.ts';

type Limits = NonNullable<NonNullable<SDKUsageReport['rate_limits']>['limits']>;

/** How often the meter refreshes on its own: often while the user is chatting, rarely when idle. */
const ACTIVE_POLL_MS = 2 * 60 * 1000;
const IDLE_POLL_MS = 10 * 60 * 1000;
/** A turn in this window counts as chatting. */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
/** The quickest a turn's end can trigger another `/usage` (each one starts a Claude Code process for ~1 s). */
const MIN_GAP_MS = 20 * 1000;
/** A reading older than this is re-read when the dashboard comes to the front. */
const STALE_MS = 60 * 1000;
/** Re-check this long after a reset time, so the server has rolled the window over. */
const RESET_SLACK_MS = 15 * 1000;
/** When a limit hits without a known reset time, look again after this long. */
const UNKNOWN_RESET_RETRY_MS = 5 * 60 * 1000;
/**
 * While paused, the wall clock is checked at least this often. One long timer isn't enough: a
 * suspended laptop's timers stop with it (Linux's monotonic clock), and on 2026-11-25 the notebook
 * slept 66 min through a reset and stayed paused an hour after it.
 */
const PAUSE_CHECK_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function label(row: Limits[number]): string {
  if (row.kind === 'session') return 'Session';
  if (row.kind === 'weekly_all') return 'Weekly · all models';
  const scope = row.scope?.model?.display_name ?? row.scope?.surface?.display_name;
  if (row.group === 'weekly') return `Weekly · ${scope ?? row.kind}`;
  return scope ? `${row.group} · ${scope}` : row.kind;
}

/** The plan's meters from a `/usage` report; null when the report has none. */
export function toMeters(report: SDKUsageReport | undefined): { meters: PlanMeter[]; extraUsageOn: boolean } | null {
  const limits = report?.rate_limits?.limits;
  if (!limits) return null;
  const meters = limits.map((row) => ({
    kind: row.kind,
    label: label(row),
    percent: Math.max(0, Math.min(100, row.percent)),
    resetsAt: row.resets_at ? Date.parse(row.resets_at) : null,
    severity: row.severity,
  }));
  return { meters, extraUsageOn: report.rate_limits?.extra_usage?.is_enabled === true };
}

/** Which meter a live `rate_limit_event` is about. */
function meterFor(meters: PlanMeter[], type: SDKRateLimitInfo['rateLimitType']): PlanMeter | undefined {
  switch (type) {
    case 'five_hour':
      return meters.find((m) => m.kind === 'session');
    case 'seven_day':
      return meters.find((m) => m.kind === 'weekly_all');
    case 'seven_day_opus':
      return meters.find((m) => m.kind === 'weekly_scoped' && /opus/i.test(m.label));
    case 'seven_day_sonnet':
      return meters.find((m) => m.kind === 'weekly_scoped' && /sonnet/i.test(m.label));
    default:
      return undefined;
  }
}

/** Accepts either a 0–1 fraction or a 0–100 percentage. */
export const asPercent = (utilization: number) => (utilization <= 1 ? utilization * 100 : utilization);

/**
 * Runs `/usage` in a throwaway session. It's a local Claude Code command: no
 * model call and no tokens (checked live: cost 0, 0 tokens, ~1 s).
 */
async function fetchReport(): Promise<SDKUsageReport | undefined> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  const q = query({
    prompt: '/usage',
    options: { ...buildOptions('haiku', 'low', abort), tools: [], maxTurns: 1, persistSession: false, includePartialMessages: false },
  });
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init' && !SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) return undefined;
      if (msg.type === 'assistant' && msg.usage_report) return msg.usage_report;
      if (msg.type === 'result') return undefined;
    }
    return undefined;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

export interface MeterEvents {
  onChange: (usage: PlanUsage) => void;
  /** A paused limit has reset: queued work can go. */
  onResume: () => void;
  /** A meter crossed one of the warning thresholds (once per threshold per window). */
  onWarning?: (warning: UsageWarning) => void;
  /** A fresh `/usage` reading (not a live event's estimate): logged for the cost guide. */
  onReading?: (meters: PlanMeter[]) => void;
}

/** Percentages that trigger a "getting close" warning; empty lists turn warnings off. */
export interface WarnThresholds {
  session: number[];
  weekly: number[];
}

export const DEFAULT_WARN: WarnThresholds = { session: [75, 90, 95], weekly: [75, 90] };

/**
 * The thresholds a meter has newly crossed: the highest one only, so a jump
 * from 70% to 96% gives one warning, not three. `warned` remembers which marks
 * were already announced, and is updated.
 */
export function newWarning(m: PlanMeter, thresholds: WarnThresholds, warned: Set<string>): UsageWarning | null {
  const kind = m.kind === 'session' ? 'session' : m.kind === 'weekly_all' ? 'weekly' : null;
  if (!kind || m.percent >= 100) return null;
  // Not keyed on the reset time: /usage and live events report it slightly differently,
  // which used to repeat a warning. A window counts as new once usage falls well below
  // the lowest mark (a real reset); small wobbles around a mark stay quiet.
  const marks = thresholds[kind];
  if (marks.length > 0 && m.percent < Math.min(...marks) - 10) {
    for (const t of marks) warned.delete(`${kind}:${t}`);
  }
  const crossed = marks.filter((t) => m.percent >= t && !warned.has(`${kind}:${t}`));
  if (crossed.length === 0) return null;
  for (const t of crossed) warned.add(`${kind}:${t}`);
  return { kind, label: m.label, percent: Math.round(m.percent), threshold: Math.max(...crossed), resetsAt: m.resetsAt };
}

/**
 * Claude plan usage: session and weekly meters from `/usage`, kept current by the
 * live rate-limit events, and the pause while a limit is hit.
 */
export class UsageMeter {
  private meters: PlanMeter[] = [];
  private fetchedAt: number | null = null;
  private extraUsageOn = false;
  private pausedUntil: number | null = null;
  private lastFetch = 0;
  private fetching: Promise<void> | null = null;
  private poll: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private lastActivity = 0;
  /** Warnings already given ("session:<reset>:90"). */
  private warned = new Set<string>();
  /** Meters seen at least once since Harv started. Marks already passed at first sight stay silent. */
  private seen = new Set<string>();
  queued = 0;

  constructor(
    private events: MeterEvents,
    private harv: () => HarvUsage,
    private fetch: () => Promise<SDKUsageReport | undefined> = fetchReport,
    private thresholds: () => WarnThresholds = () => DEFAULT_WARN,
  ) {}

  start(): void {
    void this.refresh();
    this.schedule();
  }

  /** The next refresh on its own: in 2 minutes while the user is chatting, else 10. */
  private schedule() {
    if (this.poll) clearTimeout(this.poll);
    const active = Date.now() - this.lastActivity < ACTIVE_WINDOW_MS;
    this.poll = setTimeout(
      () => {
        void this.refresh();
        this.schedule();
      },
      active ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    );
    this.poll.unref?.();
  }

  /** A turn began: the user is chatting, so check more often. */
  turnStarted(): void {
    const wasIdle = Date.now() - this.lastActivity >= ACTIVE_WINDOW_MS;
    this.lastActivity = Date.now();
    if (wasIdle && this.poll) this.schedule();
  }

  stop(): void {
    for (const t of [this.poll, this.soon, this.resumeTimer]) if (t) clearTimeout(t);
  }

  get paused(): boolean {
    return this.pausedUntil !== null;
  }

  /** The 5-hour session meter (usage/budget.ts warns and stops near its end). */
  sessionMeter(): PlanMeter | undefined {
    return this.meters.find((m) => m.kind === 'session');
  }

  /** Weekly usage across all models, for the router's plan-aware trimming. */
  weeklyPercent(): number | undefined {
    return this.meters.find((m) => m.kind === 'weekly_all')?.percent;
  }

  snapshot(): PlanUsage {
    return {
      meters: this.meters,
      fetchedAt: this.fetchedAt,
      extraUsageOn: this.extraUsageOn,
      pausedUntil: this.pausedUntil,
      queued: this.queued,
      harv: this.harv(),
    };
  }

  publish(): void {
    this.events.onChange(this.snapshot());
  }

  /** After a turn: refresh soon, but not more than every 20 seconds. */
  turnFinished(): void {
    this.lastActivity = Date.now();
    if (this.soon) return;
    const wait = Math.max(3000, this.lastFetch + MIN_GAP_MS - Date.now());
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.refresh();
    }, wait);
    // Harv's own counts change with every turn.
    this.publish();
  }

  /**
   * The dashboard came to the front. Usage spent elsewhere (a Claude Code session, the
   * other computer) isn't seen until the next poll, up to 10 minutes when idle: look now
   * unless the last look is under a minute old. `/usage` costs no tokens.
   */
  refreshIfStale(): Promise<void> {
    if (this.fetching) return this.fetching;
    if (Date.now() - this.lastFetch < STALE_MS) return Promise.resolve();
    return this.refresh();
  }

  refresh(): Promise<void> {
    this.fetching ??= (async () => {
      this.lastFetch = Date.now();
      try {
        const parsed = toMeters(await this.fetch());
        if (parsed) {
          this.meters = parsed.meters;
          this.extraUsageOn = parsed.extraUsageOn;
          this.fetchedAt = Date.now();
          this.events.onReading?.(this.meters);
          this.checkLimits();
          this.checkWarnings();
        }
      } catch {
        // Keep the last reading; the next poll tries again.
      } finally {
        this.fetching = null;
      }
      this.publish();
    })();
    return this.fetching;
  }

  /** A live `rate_limit_event` from a chat session. */
  rateLimit(info: SDKRateLimitInfo): void {
    // Paid credits wanted for one model is no plan limit (it once paused Harv until 1 December).
    if (info.errorCode === 'credits_required') return;
    const meter = meterFor(this.meters, info.rateLimitType);
    if (meter) {
      if (info.utilization !== undefined) meter.percent = Math.min(100, asPercent(info.utilization));
      if (info.resetsAt) meter.resetsAt = info.resetsAt * 1000;
    }
    // A per-model limit (Opus, Sonnet, Fable…) only takes that model out (fullModels); the plan-wide
    // ones pause Harv (the full review, D15: a full Fable meter paused every chat for days).
    const perModel = meter?.kind === 'weekly_scoped' || /^seven_day_\w+$/.test(String(info.rateLimitType ?? ''));
    if (info.status === 'rejected' && perModel) {
      if (meter) meter.percent = 100;
    } else if (info.status === 'rejected') this.pause(info.resetsAt ? info.resetsAt * 1000 : (meter?.resetsAt ?? null));
    else this.checkWarnings();
    this.publish();
  }

  /** Tells the dashboard when a meter gets close to its limit. */
  private checkWarnings() {
    const thresholds = this.thresholds();
    for (const m of this.meters) {
      const warning = newWarning(m, thresholds, this.warned);
      // First reading since start (e.g. after a restart): the marks below it were announced
      // earlier, or passed while Harv was off. Remember them, but don't announce them again.
      if (!this.seen.has(m.kind)) {
        this.seen.add(m.kind);
        continue;
      }
      if (warning) this.events.onWarning?.(warning);
    }
  }

  /** The other device showed this warning ("session:90"): it isn't shown here too. */
  markWarned(key: string): void {
    this.warned.add(key);
  }

  /** A limit was hit. Until `until` (epoch ms), messages queue instead of being sent. */
  pause(until: number | null): void {
    // An unknown reset, or one already past (the server hasn't rolled over yet): look again in a few minutes.
    const at = until !== null && until > Date.now() ? until : Date.now() + UNKNOWN_RESET_RETRY_MS;
    if (this.pausedUntil !== null && this.pausedUntil >= at) return;
    this.pausedUntil = at;
    this.armResume();
    this.publish();
  }

  /** Waits for the reset in short steps against the wall clock (PAUSE_CHECK_MS), then tries to resume. */
  private armResume() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    if (this.pausedUntil === null) return;
    const wait = this.pausedUntil + RESET_SLACK_MS - Date.now();
    if (wait <= 0) void this.tryResume();
    else this.resumeTimer = setTimeout(() => this.armResume(), Math.min(wait, PAUSE_CHECK_MS));
  }

  private async tryResume() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.pausedUntil = null;
    await this.refresh();
    // refresh() re-pauses if a meter is still full.
    if (!this.paused) this.events.onResume();
  }

  /**
   * Models whose own weekly meter is full ("Weekly · Fable" at 100%): the other models still answer,
   * so a turn routed to one of these runs on another (manager.ts), and Harv isn't paused.
   */
  fullModels(): { model: string; resetsAt?: number; credits?: true }[] {
    const full: { model: string; resetsAt?: number; credits?: true }[] = this.meters
      .filter((m) => m.kind === 'weekly_scoped' && m.percent >= 100)
      .map((m) => ({ model: /fable|opus|sonnet|haiku/i.exec(m.label)?.[0]?.toLowerCase() ?? '', resetsAt: m.resetsAt ?? undefined }))
      .filter((m) => m.model);
    const now = Date.now();
    for (const [model, until] of this.noCredits) {
      if (until <= now) this.noCredits.delete(model);
      else if (!full.some((f) => f.model === model)) full.push({ model, credits: true });
    }
    return full;
  }

  /** Models that want paid usage credits, until when (epoch ms): out like a full model, never a pause. */
  private noCredits = new Map<string, number>();

  /**
   * A `credits_required` refusal (Fable, 2026-11-17): that model is out until Claude's date (or a day),
   * and Harv keeps running on the others. Never a pause: the rest of the plan is fine.
   */
  modelNeedsCredits(model: string, until?: number): void {
    this.noCredits.set(model, until && until > Date.now() ? until : Date.now() + DAY_MS);
  }

  /** A full plan-wide meter (the session or the weekly all-models one) means the next send would be refused: pause until it resets. */
  private checkLimits() {
    const full = this.meters.filter((m) => (m.kind === 'session' || m.kind === 'weekly_all') && m.percent >= 100);
    if (full.length === 0) return;
    const resets = full.map((m) => m.resetsAt ?? 0);
    this.pause(Math.max(...resets) || null);
  }
}
