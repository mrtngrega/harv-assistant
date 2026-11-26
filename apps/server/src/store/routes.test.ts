import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanMeter } from '@harv/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteStore } from './routes.ts';

const dirs: string[] = [];
const open: RouteStore[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'harv-routes-'));
  dirs.push(dir);
  const s = new RouteStore(join(dir, 'harv.db'));
  open.push(s);
  return s;
}
afterEach(() => {
  vi.useRealTimers();
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const H = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-20T08:00:00Z');
const session = (percent: number, resetsAt: number): PlanMeter => ({
  kind: 'session',
  label: 'Session',
  percent,
  resetsAt,
  severity: 'normal',
});

/** One reply at `at` on model·effort costing `usd`. */
function reply(s: RouteStore, at: number, usd: number, model = 'sonnet', effort: 'medium' | 'high' = 'medium') {
  vi.setSystemTime(at);
  s.add({ chatId: `c${at}`, model, effort, source: 'classifier', reason: 'test' });
  s.finishLast(`c${at}`, { inputTokens: 1000, outputTokens: 100, durationMs: 1000, costUsd: usd });
}

// The user's report note (2026-11-25): "i want harv to guess the token/plan usage of a task or plan accurately".
describe('the cost guide', () => {
  it('logs a meter reading only when it changed or every 30 minutes', () => {
    const s = store();
    s.logMeter([session(10, T0 + 5 * H)], T0);
    s.logMeter([session(10, T0 + 5 * H)], T0 + 10 * 60_000);
    s.logMeter([session(11, T0 + 5 * H)], T0 + 11 * 60_000);
    s.logMeter([session(11, T0 + 5 * H)], T0 + 45 * 60_000);
    const rows = (s as unknown as { db: { prepare: (q: string) => { all: () => unknown[] } } }).db.prepare('SELECT * FROM meter_log').all();
    expect(rows).toHaveLength(3);
  });

  it('turns meter movement and logged costs into % per dollar, and costs per reply by model', () => {
    vi.useFakeTimers();
    const s = store();
    // Two session windows: $2 moved the meter 10%, then $1 moved it 6%.
    for (const [start, moved, usd] of [
      [T0, 10, 2],
      [T0 + 6 * H, 6, 1],
    ] as const) {
      const resets = start + 5 * H;
      s.logMeter([session(20, resets)], start);
      for (let i = 0; i < 4; i++) reply(s, start + (i + 1) * 10 * 60_000, usd / 4);
      s.logMeter([session(20 + moved, resets)], start + H);
    }
    for (let i = 0; i < 3; i++) reply(s, T0 + 20 * H + i * 60_000, 0.6, 'opus');
    const g = s.costGuide(T0 + 24 * H);
    expect(g.windows).toBe(2);
    // Lower quartile of 5 and 6 %/$: other use of the plan only makes windows look dearer.
    expect(g.sessionPerUsd).toBeCloseTo(5.25);
    expect(g.perReply[0]).toMatchObject({ pick: 'sonnet·medium', replies: 8 });
    expect(g.perReply.find((r) => r.pick === 'opus·medium')?.median).toBeCloseTo(0.6);
  });

  it('gives no rate until there are enough windows with real spend', () => {
    vi.useFakeTimers();
    const s = store();
    s.logMeter([session(20, T0 + 5 * H)], T0);
    reply(s, T0 + 60_000, 0.1);
    s.logMeter([session(25, T0 + 5 * H)], T0 + H);
    const g = s.costGuide(T0 + 2 * H);
    expect(g.sessionPerUsd).toBeUndefined();
    expect(g.perReply).toEqual([]);
  });

});
