import type { PlanMeter, PlanUsage } from '@harv/shared';
import { describe, expect, it } from 'vitest';
import { costGuideText, sessionNote, stopNote, usageText, windowOf } from './budget.ts';

const at = (percent: number, resetsAt: number | null = Date.UTC(2026, 10, 11, 2, 10)): PlanMeter => ({
  kind: 'session',
  label: 'Session',
  percent,
  resetsAt,
  severity: 'normal',
});

// The user's rule (2026-11-10): near the session's end Harv warns and stops cleanly, never picks cheaper models.
describe('the end of the session', () => {
  it('says nothing below 75% or with no meter', () => {
    expect(sessionNote(undefined)).toBe('');
    expect(sessionNote(at(74))).toBe('');
    expect(stopNote(at(89))).toBe('');
  });

  it('warns about big tasks from 75%, with the reset time, keeping the models', () => {
    const note = sessionNote(at(80));
    expect(note).toMatch(/80% used, resets at \d\d:\d\d/);
    expect(note).toMatch(/may not fit/);
    expect(note).toMatch(/stop cleanly at 90%/);
    expect(note).toMatch(/Same models and effort/);
  });

  it('from 90% starts no bigger work and stops a running reply cleanly', () => {
    expect(sessionNote(at(92))).toMatch(/won't fit.*suggest waiting for the reset/);
    expect(stopNote(at(90))).toMatch(/Stop cleanly now: finish only the step you're on/);
    expect(stopNote(at(90, null))).toContain('reached 90% used. Stop');
  });

  it('leaves a full meter to the pause', () => {
    expect(sessionNote(at(100))).toBe('');
  });

  it('keys a window by its reset time', () => {
    expect(windowOf(at(90, 5))).toBe('5');
    expect(windowOf(at(90, null))).toBe('unknown');
  });
});

// The phone chat couldn't say when the weekly limit resets (2026-11-13): plan_usage answers it.
describe('plan_usage', () => {
  const now = Date.UTC(2026, 10, 14, 12, 0);
  const usage = (meters: PlanMeter[]): PlanUsage => ({
    meters,
    fetchedAt: now - 60_000,
    extraUsageOn: false,
    pausedUntil: null,
    queued: 0,
    harv: undefined as never,
  });

  it('gives every meter with its reset and how far off it is', () => {
    const weekly = { ...at(81, now + (2 * 24 + 20) * 3600_000), kind: 'weekly_all', label: 'Weekly · all models' };
    const out = usageText(usage([at(12, now + 90 * 60_000), weekly]), now);
    expect(out).toContain('Session: 12% used');
    expect(out).toContain('(in 1h 30m)');
    expect(out).toContain('Weekly · all models: 81% used');
    expect(out).toContain('(in 2d 20h)');
    expect(out).toContain('Extra usage is off');
  });

  it('says when there is no reading yet', () => {
    expect(usageText(usage([]), now)).toMatch(/No plan usage reading yet/);
  });
});

// The user's report note (2026-11-25): estimates of a task's plan usage come from measured costs.
describe('the cost guide in plan_usage', () => {
  const perReply = [
    { pick: 'sonnet·high', replies: 40, median: 0.2, p90: 0.8 },
    { pick: 'opus·medium', replies: 12, median: 0.5, p90: 1.5 },
  ];
  it('gives each model a typical reply in % of the session, and how to estimate', () => {
    const text = costGuideText({ sessionPerUsd: 4, weeklyPerUsd: 0.5, windows: 6, perReply });
    expect(text).toContain('sonnet·high ≈ 0.8% of the session (dear ones up to 3%');
    expect(text).toContain('opus·medium ≈ 2%');
    expect(text).toContain('1% of the 5-hour session ≈ $0.25');
    expect(text).toMatch(/Give a range/);
  });
  it('falls back to dollars, then to saying there is no data yet', () => {
    const dollars = costGuideText({ windows: 0, perReply });
    expect(dollars).toContain('sonnet·high ≈ $0.20');
    expect(dollars).toMatch(/rough guess/);
    expect(costGuideText({ windows: 0, perReply: [] })).toMatch(/not enough replies/);
  });
});
