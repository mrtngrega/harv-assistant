import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@harv/shared';
import type { Line, Tab } from './chatStore.ts';
import { nextChange, NOTICE_MS, pillKey, pillState, WAIT_FULL_MS, type PillInput } from './pill.ts';
import { HELD_PREFIX } from './turns.ts';

const line = (kind: Line['kind'], text: string, at: number) => ({ id: `${kind}${at}`, kind, text, at }) as Line;
const tab = (id: string, extra: Partial<Tab> = {}) =>
  ({ id, title: id.toUpperCase(), lines: [], busy: false, currentId: null, ...extra }) as Tab;
const now = 100_000;
const input = (extra: Partial<PillInput>): PillInput => ({
  front: false,
  tabs: [],
  approvals: [],
  paused: false,
  moons: new Map(),
  still: false,
  now,
  ...extra,
});

describe('Harv’s face on the desktop (pass C, C2)', () => {
  it('shows nothing at rest, and nothing while Harv’s window is in front', () => {
    expect(pillState(input({ tabs: [tab('a')] }))).toBeNull();
    expect(pillState(input({ front: true, tabs: [tab('a', { busy: true })] }))).toBeNull();
  });

  it('says it listens while the hold key records, over everything else, and only away from the window', () => {
    const held = tab('h', { lines: [line('you', 'go', 1), line('notice', `${HELD_PREFIX} #1 x.`, now - 1_000)] });
    expect(pillState(input({ tabs: [held], listening: 'recording' }))).toMatchObject({ mode: 'notice', text: 'listening… let go to send' });
    expect(pillState(input({ listening: 'hearing' }))).toMatchObject({ mode: 'notice', text: 'hearing you…' });
    expect(pillState(input({ front: true, listening: 'recording' }))).toBeNull();
  });

  it('shows the newest working chat with its moon and how many others work', () => {
    const tabs = [tab('a', { busy: true, startedAt: 1, activity: 'Read' }), tab('b', { busy: true, startedAt: 5, activity: 'PowerShell' })];
    const p = pillState(input({ tabs, moons: new Map([['b', 'shell']]) }));
    expect(p).toMatchObject({ mode: 'work', text: 'PowerShell', chat: 'B', more: 1, moon: 'shell', tabId: 'b' });
  });

  it('a held yes wins over work, amber, then shrinks to the dot', () => {
    const held = tab('h', { lines: [line('you', 'go', 1), line('notice', `${HELD_PREFIX} #1 x.`, now - 1_000)] });
    const p = pillState(input({ tabs: [tab('a', { busy: true }), held] }));
    expect(p).toMatchObject({ mode: 'waiting', text: 'waiting for your yes', chat: 'H', tabId: 'h', more: 0 });
    expect(nextChange(p, input({ tabs: [held] }))).toBe(now - 1_000 + WAIT_FULL_MS);
    expect(pillState(input({ tabs: [held], now: now + WAIT_FULL_MS }))?.mode).toBe('dot');
  });

  it('a question card waits too, worded for it', () => {
    const approvals = [{ kind: 'question', tabId: 'q', at: now } as ApprovalRequest];
    expect(pillState(input({ tabs: [tab('q', { busy: true })], approvals }))).toMatchObject({
      mode: 'waiting',
      text: 'has a question for you',
    });
  });

  it('falls asleep at a plan limit while work is cut off or queued', () => {
    const p = pillState(input({ paused: true, pausedUntil: now + 72 * 60_000 - 20_000, tabs: [tab('a', { busy: true })] }));
    expect(p).toMatchObject({ mode: 'asleep', text: 'plan limit · back in 1h 12m' });
    expect(pillState(input({ paused: true, tabs: [tab('a')] }))).toBeNull();
    // The pill updates at the countdown's next minute.
    const until = now + 72 * 60_000 - 20_000;
    const asleep = pillState(input({ paused: true, pausedUntil: until, tabs: [tab('a', { busy: true })] }));
    expect(nextChange(asleep, input({ paused: true, pausedUntil: until }))).toBe(now + 40_000 + 50);
  });

  it("says a notice's line for a few seconds, then nothing for a normal one (docs/PLAN.md §6ad)", () => {
    const notice = { line: 'replied in A', level: 'normal' as const, at: now - 1_000, tabId: 'a', more: 0 };
    const p = pillState(input({ tabs: [tab('a')], notice }));
    expect(p).toMatchObject({ mode: 'notice', text: 'replied in A', tabId: 'a' });
    expect(nextChange(p, input({ notice }))).toBe(notice.at + NOTICE_MS);
    expect(pillState(input({ tabs: [tab('a')], notice, now: notice.at + NOTICE_MS }))).toBeNull();
  });

  it('says a warning in amber, over the work, then keeps an amber dot until it is seen', () => {
    const notice = { line: 'Plan at 90% of the session', level: 'warning' as const, at: now - 1_000, more: 2 };
    const busy = [tab('a', { busy: true })];
    const said = pillState(input({ tabs: busy, notice, unseenWarning: true }));
    expect(said).toMatchObject({ mode: 'waiting', text: notice.line, more: 2 });
    // Worked out again when the line ends, though no chat waits behind it.
    expect(nextChange(said, input({ tabs: busy, notice, unseenWarning: true }))).toBe(notice.at + NOTICE_MS);
    const later = notice.at + NOTICE_MS;
    // The work shows again once the line is over; with nothing running, the dot.
    expect(pillState(input({ tabs: busy, notice, unseenWarning: true, now: later }))?.mode).toBe('work');
    expect(pillState(input({ tabs: [tab('a')], notice, unseenWarning: true, now: later }))).toMatchObject({ mode: 'dot' });
  });

  it('sends the same state only once (the tab id isn’t part of it)', () => {
    const a = pillState(input({ tabs: [tab('a', { busy: true })] }));
    expect(pillKey(a)).toBe(pillKey({ ...a!, tabId: 'other' }));
    expect(pillKey(null)).toBe('');
  });
});
