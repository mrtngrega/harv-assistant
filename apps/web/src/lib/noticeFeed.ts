import type { UsageWarning, WatchdogAlert } from '@harv/shared';
import { chat, getChatState, subscribeChat } from './chatStore.ts';
import { resetTime } from './format.ts';
import { onServerMessage } from './socket.ts';
import { playSound, soundFor } from './sound.ts';
import { heldWaiting } from './turns.ts';
import { getPlatform, getSettings, updateSettings } from './useHarvSocket.ts';
import {
  dropNotices,
  projectLevel,
  pushNotice,
  shouldAnnouncePause,
  shouldSound,
  usageLevel,
  watchdogLevel,
  type Notice,
} from './notices.ts';

/**
 * Server messages → Harv's notices (docs/PLAN.md §6ad): which ones, at what level, with which
 * actions; whether they sound; and the system notification that's left (urgent ones outside the
 * app; every notice on Linux, which has no pill).
 */

/** "Heads up: 90% of your Claude session (5-hour) limit is used. It resets at 18:40." */
export function warningText(w: UsageWarning): string {
  const what = w.kind === 'session' ? 'session (5-hour) limit' : 'weekly limit';
  const reset = w.resetsAt ? ` It resets ${w.kind === 'session' ? 'at' : 'on'} ${resetTime(w.resetsAt)}.` : '';
  return `Heads up: ${w.percent}% of your Claude ${what} is used.${reset}`;
}

/** Opens a chat that asks Harv about a warning (this one uses the plan, so only when the user asks). */
export function askHarvAbout(alert: WatchdogAlert) {
  chat.newTab();
  chat.send(`My PC watchdog just warned me: "${alert.title}". ${alert.detail} What is this, and should I do something about it?`);
}

const titleOf = (tabId: string) => getChatState().tabs.find((t) => t.id === tabId)?.title ?? 'a chat';
const openChat = (tabId: string) => () => chat.setActive(tabId);

/** Harv's window is in front and visible: the user sees the app. */
export const inFront = () => typeof document !== 'undefined' && !document.hidden && document.hasFocus();

/** The chat on screen right now (a reply there needs no notice: it's in front of the user). */
const onScreen = (tabId: string) => inFront() && getChatState().activeId === tabId;

/** What the app's system notification is, set by desktop.ts (nothing in a browser). */
let systemNotify: (title: string, body: string) => void = () => {};
export const setSystemNotify = (fn: typeof systemNotify) => (systemNotify = fn);

/** Is a full-screen app in front (a game, a film)? Set by desktop.ts; no sound then. */
let fullscreenNow: () => Promise<boolean> = async () => false;
export const setFullscreenCheck = (fn: typeof fullscreenNow) => (fullscreenNow = fn);

const lastSounded = new Map<string, number>();
/** The end of the pause already said (the meter sends its state often); kept across page reloads. */
const PAUSE_KEY = 'harv.pauseNoticed';
function pauseSaid(): number | null {
  try {
    const v = Number(localStorage.getItem(PAUSE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function setPauseSaid(until: number | null) {
  try {
    if (until === null) localStorage.removeItem(PAUSE_KEY);
    else localStorage.setItem(PAUSE_KEY, String(until));
  } catch {
    // No storage: the in-memory check below still keeps one window quiet.
  }
}
let pausedNoticed: number | null = pauseSaid();

/** One notice arrives: into the bubble and Recent, a sound, and outside the app maybe a system notification. */
export function notice(n: Notice) {
  const now = Date.now();
  const away = !inFront();
  const { merged } = pushNotice(n, away, now);
  const { noticeSound, noticeVolume } = getSettings();
  if (!merged && noticeSound && shouldSound(lastSounded, n.key, now)) {
    lastSounded.set(n.key, now);
    void fullscreenNow().then((full) => full || playSound(soundFor(n.level), noticeVolume));
  }
  // Outside the app: Windows has the pill, so only urgent ones also go to the system; Linux has no pill.
  if (away && (n.level === 'urgent' || getPlatform() === 'linux')) systemNotify(n.line, n.detail ?? '');
}

function watchdogNotice(alert: WatchdogAlert): Notice {
  const app = alert.app?.toLowerCase();
  return {
    key: `watchdog:${alert.kind}:${app ?? alert.id}`,
    level: watchdogLevel(alert),
    icon: alert.kind === 'threat' || alert.kind === 'protection-off' ? '▲' : '◉',
    line: alert.title,
    detail: alert.detail,
    actions: [
      { label: 'Ask Harv', run: () => askHarvAbout(alert) },
      ...(app
        ? [
            {
              label: `Don’t warn about ${alert.app}`,
              run: () => updateSettings({ watchdogIgnored: [...getSettings().watchdogIgnored, app] }),
            },
          ]
        : []),
      { label: 'OK' },
    ],
  };
}

/** Starts listening (once, from App). The phone keeps its own layout: no notices there. */
export function startNotices() {
  // Answered (the user's reply to a held step, typed or the Yes/No buttons): its "waiting for your
  // yes" notice goes (the user's report note, 2026-11-18). The state changes often; this is cheap.
  subscribeChat(() => {
    const { tabs } = getChatState();
    dropNotices((key) => {
      if (!key.startsWith('held:')) return false;
      const tab = tabs.find((t) => t.id === key.slice(5));
      return !tab || heldWaiting(tab.lines) === 0;
    });
  });
  onServerMessage((msg) => {
    switch (msg.type) {
      case 'approval.resolved':
        dropNotices((key) => key === `approval:${msg.id}`);
        break;
      case 'usage.warning': {
        const w = msg.warning;
        chat.noticeInActive(warningText(w));
        notice({
          key: `usage:${w.kind}`,
          level: usageLevel(w),
          icon: '◔',
          line:
            w.percent >= 100
              ? `Plan limit reached (${w.kind === 'session' ? 'session' : 'week'})`
              : `Plan at ${w.percent}% of the ${w.kind === 'session' ? 'session' : 'week'}`,
          detail: warningText(w),
          actions: [{ label: 'OK' }],
        });
        break;
      }
      case 'watchdog.alert':
        notice(watchdogNotice(msg.alert));
        break;
      case 'usage.update': {
        // The plan limit reached: Harv pauses until the reset (said once per pause).
        const until = msg.usage.pausedUntil ?? null;
        if (until === null) {
          if (pausedNoticed !== null) setPauseSaid((pausedNoticed = null));
          break;
        }
        if (shouldAnnouncePause(until, pausedNoticed)) {
          setPauseSaid((pausedNoticed = until));
          notice({
            key: 'usage:limit',
            level: 'urgent',
            icon: '◔',
            line: `Plan limit reached · back at ${resetTime(until)}`,
            detail: 'Harv pauses until the plan resets; queued messages go out then.',
            actions: [{ label: 'OK' }],
          });
        }
        break;
      }
      case 'approval.request': {
        const a = msg.approval;
        notice({
          key: `approval:${a.id}`,
          level: 'warning',
          icon: '!',
          line: `Waiting for you: ${a.summary}`,
          detail: `In “${titleOf(a.tabId)}”.`,
          tabId: a.tabId,
          actions: [{ label: 'Open the chat', run: openChat(a.tabId) }, { label: 'Later' }],
        });
        break;
      }
      case 'chat.done': {
        const { tabId } = msg;
        const tab = getChatState().tabs.find((t) => t.id === tabId);
        const title = titleOf(tabId);
        if (msg.error) {
          notice({
            key: `error:${tabId}`,
            level: 'warning',
            icon: '!',
            line: `Harv hit an error in ${title}`,
            detail: msg.error,
            tabId,
            actions: [{ label: 'Open the chat', run: openChat(tabId) }, { label: 'OK' }],
          });
        } else if (tab && heldWaiting(tab.lines) > 0) {
          // He finished the rest and holds a step for the user's yes (persona rule 17).
          notice({
            key: `held:${tabId}`,
            level: 'warning',
            icon: '!',
            line: `Waiting for your yes in ${title}`,
            detail: 'Harv did the rest and holds a step until you say yes in that chat.',
            tabId,
            actions: [{ label: 'Open the chat', run: openChat(tabId) }, { label: 'Later' }],
          });
        } else if (msg.ok && !msg.stopped && !onScreen(tabId)) {
          notice({
            key: 'reply',
            level: 'normal',
            icon: '↩',
            line: `replied in ${title}`,
            tabId,
            chats: [{ id: tabId, title }],
            actions: [{ label: 'Open the chat', run: openChat(tabId) }],
          });
        }
        break;
      }
      case 'project.notice':
        notice({
          key: `project:${msg.message}`,
          level: projectLevel(msg.message),
          icon: '⇅',
          line: msg.message,
          actions: [{ label: 'OK' }],
        });
        break;
      case 'schedule.ran':
        notice({
          key: `schedule:${msg.task.id}`,
          level: 'normal',
          icon: '⏰',
          line: `Running “${msg.task.title}”${msg.late ? ' (late)' : ''}`,
          detail: msg.late ? 'It was due while Harv was off; it runs in its chat now.' : 'It runs in its chat.',
          tabId: msg.task.tabId,
          actions: [{ label: 'Open the chat', run: openChat(msg.task.tabId) }, { label: 'OK' }],
        });
        break;
    }
  });
}
