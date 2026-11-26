import { isUrgentAlert, type UsageWarning, type WatchdogAlert } from '@harv/shared';
import { createStore } from './createStore.ts';

/**
 * Harv's own notices, said through his presence (docs/PLAN.md §6ad): in the app a bubble hangs
 * from his face, outside it the desktop pill says the line (Windows). Three levels:
 * - urgent (a threat, protection off, overheating, the plan limit): chime, stays, and a system
 *   notification outside the app;
 * - warning (a waiting yes, question or plan, usage 75/90 %, a busy program, an error, a sync
 *   conflict): chime, amber, stays until clicked;
 * - normal (a reply in another chat, a scheduled task, a project synced): tick, gone after ~6 s.
 * This file is the pure part (levels, the queue, Recent) plus the store; `noticeFeed.ts` turns
 * server messages into notices.
 */

export type NoticeLevel = 'normal' | 'warning' | 'urgent';

export interface NoticeAction {
  label: string;
  run?: () => void;
}

export interface Notice {
  /** The same key again is the same thing: merged into one line ("replied ×3"), no second sound. */
  key: string;
  level: NoticeLevel;
  icon: string;
  line: string;
  detail?: string;
  /** The first one is the main action; a notice always closes after one. */
  actions?: NoticeAction[];
  /** The chat it's about, opened by a click on the pill. */
  tabId?: string;
  /** Replies merged into one line: the chats, in order. */
  chats?: { id: string; title: string }[];
}

export interface QueuedNotice extends Notice {
  id: number;
  at: number;
  count: number;
}

export interface RecentNotice {
  id: number;
  at: number;
  notice: Notice;
  /** It came while Harv's window wasn't in front, and Recent hasn't been opened since. */
  away: boolean;
}

/** A normal notice goes by itself after this. */
export const SAY_MS = 6000;
/** The same thing doesn't sound again within this. */
export const QUIET_REPEAT_MS = 60_000;
/** Recent keeps at most this many. */
export const RECENT_MAX = 60;

const RANK: Record<NoticeLevel, number> = { urgent: 2, warning: 1, normal: 0 };

/** The watchdog's kinds: a threat, protection off and heat are urgent; busy programs a warning. */
export const watchdogLevel = (alert: Pick<WatchdogAlert, 'kind' | 'severity'>): NoticeLevel =>
  isUrgentAlert(alert) ? 'urgent' : 'warning';

/** Plan usage: the limit itself (100 %) is urgent, the 75/90 % marks a warning. */
export const usageLevel = (w: Pick<UsageWarning, 'percent'>): NoticeLevel => (w.percent >= 100 ? 'urgent' : 'warning');

/** A project note: one that needs the user (didn't pull, a conflict, git failed) is a warning. */
export const projectLevel = (text: string): NoticeLevel =>
  /didn['’]t|couldn['’]t|conflict|left it for you|failed|not pushed|aren['’]t pushed/i.test(text) ? 'warning' : 'normal';

/** Replies merged into one line say how many. */
export const lineOf = (n: QueuedNotice | Notice) => {
  const count = 'count' in n ? n.count : 1;
  return n.key.startsWith('reply') && count > 1 ? `replied ×${count}` : n.line;
};

/**
 * One more notice in the queue: the same key again is merged into its line (and makes no sound);
 * otherwise it goes in by level, urgent first, oldest first within a level.
 */
export function enqueue(queue: QueuedNotice[], n: Notice, id: number, at: number): { queue: QueuedNotice[]; merged: boolean } {
  const hit = queue.find((q) => q.key === n.key);
  const byLevel = (a: QueuedNotice, b: QueuedNotice) => RANK[b.level] - RANK[a.level] || a.id - b.id;
  if (hit) {
    // The newer line wins ("Plan at 90%" over a waiting "Plan at 82%"), and so does the higher level
    // (the full review, U19); merged replies still read "replied ×N" through lineOf.
    const chats = n.chats ? [...(hit.chats ?? []), ...n.chats.filter((c) => !hit.chats?.some((h) => h.id === c.id))] : hit.chats;
    const level = RANK[n.level] > RANK[hit.level] ? n.level : hit.level;
    const next = { ...hit, line: n.line, level, count: hit.count + 1, at, chats, detail: n.detail ?? hit.detail };
    return { queue: queue.map((q) => (q === hit ? next : q)).sort(byLevel), merged: true };
  }
  const next = [...queue, { ...n, id, at, count: 1 }];
  next.sort(byLevel);
  return { queue: next, merged: false };
}

/** A pause that ends this much later than the one already announced is a new limit (the week after the session). */
export const NEW_PAUSE_MS = 2 * 60 * 60 * 1000;

/**
 * Should this plan-limit pause be announced? Once per pause (the user's report, 16 Nov: "limit
 * reached" came once or twice an hour until the reset). The meter re-sends the pause on every look,
 * its reset time wobbles by seconds between /usage and live events, and a stale reading re-pauses
 * 5 minutes at a time; a page reload forgot what was said. `said` is the end of the pause already
 * announced (kept across reloads), cleared when Harv resumes.
 */
export const shouldAnnouncePause = (until: number, said: number | null): boolean => said === null || until - said > NEW_PAUSE_MS;

/** Recent: today's notices, newest first, at most RECENT_MAX; yesterday's drop off. */
export function addRecent(list: RecentNotice[], item: RecentNotice, now = item.at): RecentNotice[] {
  const today = new Date(now).toDateString();
  return [item, ...list].filter((r) => new Date(r.at).toDateString() === today).slice(0, RECENT_MAX);
}

/** Should this notice sound? Not when the same thing sounded within QUIET_REPEAT_MS. */
export function shouldSound(lastSounded: Map<string, number>, key: string, now: number): boolean {
  const last = lastSounded.get(key);
  return last === undefined || now - last >= QUIET_REPEAT_MS;
}

// ---- The store ----

interface NoticeState {
  queue: QueuedNotice[];
  recent: RecentNotice[];
  /** The bubble's detail is open. */
  open: boolean;
  /** Recent is open (in the app). */
  recentOpen: boolean;
}

const store = createStore<NoticeState>({ queue: [], recent: [], open: false, recentOpen: false });
export const useNotices = store.use;
export const getNotices = store.get;
export const subscribeNotices = store.subscribe;

let seq = 0;

/** Adds a notice; returns whether it was merged into one already waiting (merged ones make no sound). */
export function pushNotice(n: Notice, away: boolean, now = Date.now()): { item: QueuedNotice; merged: boolean } {
  const id = ++seq;
  const { queue, merged } = enqueue(store.get().queue, n, id, now);
  store.set((s) => ({ ...s, queue, recent: addRecent(s.recent, { id, at: now, notice: n, away }, now) }));
  return { item: queue.find((q) => q.key === n.key)!, merged };
}

/** The notice is done with (closed, acted on, or faded). */
export function dismissNotice(id: number) {
  store.set((s) => ({ ...s, queue: s.queue.filter((q) => q.id !== id), open: false }));
}

/**
 * Notices whose reason is gone (the user answered a held step or a card): out of the queue, so the
 * bubble and the pill's dot go; Recent keeps them. The open detail closes only if it was one of them.
 */
export function dropNotices(gone: (key: string) => boolean) {
  const { queue } = store.get();
  if (!queue.some((q) => gone(q.key))) return;
  store.set((s) => ({ ...s, queue: s.queue.filter((q) => !gone(q.key)), open: s.open && !gone(s.queue[0]?.key ?? '') }));
}

/** Everything waiting is seen at once (the pill was clicked: Harv comes up on the first one). */
export function takeAll(): QueuedNotice[] {
  const { queue } = store.get();
  store.set((s) => ({ ...s, queue: [], open: false }));
  return queue;
}

export const setNoticeOpen = (open: boolean) => store.set((s) => ({ ...s, open }));

/** Opens a notice from Recent again: it goes to the front of the bubble with its detail open. */
export function reopen(r: RecentNotice) {
  const id = ++seq;
  store.set((s) => ({
    ...s,
    queue: [{ ...r.notice, id, at: Date.now(), count: 1 }, ...s.queue.filter((q) => q.key !== r.notice.key)],
    open: true,
    recentOpen: false,
  }));
}

/** Opening Recent marks everything seen ("while you were away" is only the top line of the first look). */
export function setRecentOpen(open: boolean) {
  store.set((s) => ({ ...s, recentOpen: open, recent: open ? s.recent : s.recent.map((r) => (r.away ? { ...r, away: false } : r)) }));
}

/** Notices that came while the user was away and aren't seen yet. */
export const awayCount = (recent: RecentNotice[]) => recent.filter((r) => r.away).length;

/** Where the bubble hangs (px from the top of the chat area): under Harv's face when the hammock shows, else near the top. */
const hang = createStore<number>(0);
export const useHang = hang.use;
export const setHang = (px: number) => hang.set(px);
