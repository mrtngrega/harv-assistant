import { describe, expect, it } from 'vitest';
import {
  addRecent,
  dropNotices,
  getNotices,
  pushNotice,
  enqueue,
  lineOf,
  projectLevel,
  shouldAnnouncePause,
  shouldSound,
  NEW_PAUSE_MS,
  usageLevel,
  watchdogLevel,
  QUIET_REPEAT_MS,
  RECENT_MAX,
  type Notice,
  type QueuedNotice,
} from './notices.ts';

const n = (key: string, level: Notice['level'], extra: Partial<Notice> = {}): Notice => ({ key, level, icon: '·', line: key, ...extra });

describe('notice levels (docs/PLAN.md §6ad)', () => {
  it('makes a threat, protection off and heat urgent, a busy program a warning', () => {
    expect(watchdogLevel({ kind: 'threat', severity: 'warn' })).toBe('urgent');
    expect(watchdogLevel({ kind: 'protection-off', severity: 'warn' })).toBe('urgent');
    expect(watchdogLevel({ kind: 'heat', severity: 'warn' })).toBe('urgent');
    expect(watchdogLevel({ kind: 'cpu-hog', severity: 'warn' })).toBe('warning');
    expect(watchdogLevel({ kind: 'suspicious', severity: 'critical' })).toBe('urgent');
  });

  it('makes the plan limit urgent and the 75/90 % marks a warning', () => {
    expect(usageLevel({ percent: 90 })).toBe('warning');
    expect(usageLevel({ percent: 100 })).toBe('urgent');
  });

  it('makes a project note that needs the user a warning', () => {
    expect(projectLevel('Pulled the other device\'s new work into "garden_app".')).toBe('normal');
    expect(projectLevel('"x" has commits here that aren\'t pushed yet, so Harv didn\'t pull')).toBe('warning');
    expect(projectLevel('"x" has new commits both here and on the other device; Harv left it for you to merge.')).toBe('warning');
  });
});

describe('the queue', () => {
  it('puts urgent first, then warnings, then normal ones, oldest first within a level', () => {
    let q: QueuedNotice[] = [];
    q = enqueue(q, n('reply', 'normal'), 1, 1).queue;
    q = enqueue(q, n('usage:session', 'warning'), 2, 2).queue;
    q = enqueue(q, n('threat', 'urgent'), 3, 3).queue;
    q = enqueue(q, n('held:a', 'warning'), 4, 4).queue;
    expect(q.map((x) => x.key)).toEqual(['threat', 'usage:session', 'held:a', 'reply']);
  });

  it('merges the same thing into one line, with each chat once, and says it merged', () => {
    let q: QueuedNotice[] = [];
    q = enqueue(q, n('reply', 'normal', { line: 'replied in A', chats: [{ id: 'a', title: 'A' }] }), 1, 1).queue;
    const second = enqueue(q, n('reply', 'normal', { line: 'replied in B', chats: [{ id: 'b', title: 'B' }] }), 2, 2);
    expect(second.merged).toBe(true);
    q = enqueue(second.queue, n('reply', 'normal', { chats: [{ id: 'a', title: 'A' }] }), 3, 3).queue;
    expect(q).toHaveLength(1);
    expect(q[0]!.count).toBe(3);
    expect(q[0]!.chats?.map((c) => c.id)).toEqual(['a', 'b']);
    expect(lineOf(q[0]!)).toBe('replied ×3');
  });

  it('takes the newer line and the higher level when merging (the full review, U19)', () => {
    let q: QueuedNotice[] = [];
    q = enqueue(q, n('held:a', 'warning'), 1, 1).queue;
    q = enqueue(q, n('usage:session', 'warning', { line: 'Plan at 82% of the session' }), 2, 2).queue;
    q = enqueue(q, n('usage:session', 'warning', { line: 'Plan at 90% of the session' }), 3, 3).queue;
    expect(q.find((x) => x.key === 'usage:session')?.line).toBe('Plan at 90% of the session');
    q = enqueue(q, n('usage:session', 'urgent', { line: 'Plan limit reached (session)' }), 4, 4).queue;
    expect(q[0]).toMatchObject({ key: 'usage:session', level: 'urgent', line: 'Plan limit reached (session)', count: 3 });
    // A lower level never takes an urgent one down.
    q = enqueue(q, n('usage:session', 'warning', { line: 'Plan at 95% of the session' }), 5, 5).queue;
    expect(q[0]!.level).toBe('urgent');
  });
});

describe("the plan-limit pause (the user's report, 16 Nov)", () => {
  const at = Date.parse('2026-11-17T15:00:00Z');
  it('is said once per pause, not again when its reset time wobbles or a stale reading re-pauses', () => {
    expect(shouldAnnouncePause(at, null)).toBe(true);
    expect(shouldAnnouncePause(at, at)).toBe(false);
    expect(shouldAnnouncePause(at + 900, at)).toBe(false);
    expect(shouldAnnouncePause(at + 25 * 60_000, at)).toBe(false);
  });

  it('is said again for a different limit (the week after the session)', () => {
    expect(shouldAnnouncePause(at + NEW_PAUSE_MS + 1, at)).toBe(true);
    expect(shouldAnnouncePause(at + 3 * 24 * 3600_000, at)).toBe(true);
  });
});

describe('Recent', () => {
  it('keeps today newest first, and drops yesterday', () => {
    const today = new Date(2026, 10, 15, 12).getTime();
    const yesterday = new Date(2026, 10, 14, 23).getTime();
    let list = addRecent([], { id: 1, at: yesterday, notice: n('old', 'normal'), away: false });
    list = addRecent(list, { id: 2, at: today, notice: n('new', 'normal'), away: true });
    expect(list.map((r) => r.notice.key)).toEqual(['new']);
  });

  it(`keeps at most ${RECENT_MAX}`, () => {
    let list: ReturnType<typeof addRecent> = [];
    const at = new Date(2026, 10, 15, 12).getTime();
    for (let i = 0; i < RECENT_MAX + 5; i++) list = addRecent(list, { id: i, at: at + i, notice: n(`k${i}`, 'normal'), away: false });
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]!.notice.key).toBe(`k${RECENT_MAX + 4}`);
  });
});

describe('sound', () => {
  it('stays quiet for the same thing within a minute', () => {
    const last = new Map([['usage:session', 1000]]);
    expect(shouldSound(last, 'usage:session', 1000 + QUIET_REPEAT_MS - 1)).toBe(false);
    expect(shouldSound(last, 'usage:session', 1000 + QUIET_REPEAT_MS)).toBe(true);
    expect(shouldSound(last, 'reply', 1000)).toBe(true);
  });
});

describe('answered notices go (the user report note, 18 Nov)', () => {
  it('drops the matching ones from the queue and keeps them in Recent', () => {
    pushNotice(n('held:a', 'warning'), false);
    pushNotice(n('held:b', 'warning'), false);
    pushNotice(n('reply', 'normal'), false);
    dropNotices((key) => key === 'held:a');
    expect(getNotices().queue.map((q) => q.key)).toEqual(['held:b', 'reply']);
    expect(getNotices().recent.some((r) => r.notice.key === 'held:a')).toBe(true);
  });
});
