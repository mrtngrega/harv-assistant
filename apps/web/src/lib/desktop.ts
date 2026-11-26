import { invoke, isTauri } from '@tauri-apps/api/core';
import { setFullscreenCheck, setSystemNotify } from './noticeFeed.ts';
import { getNotices, lineOf, setNoticeOpen, subscribeNotices } from './notices.ts';

/** The pill's view of the notices: the newest waiting one, and whether a warning is among them. */
function pillNotice() {
  const { queue } = getNotices();
  if (!queue.length) return {};
  const newest = queue.reduce((a, b) => (b.at > a.at ? b : a));
  return {
    notice: { line: lineOf(newest), level: newest.level, at: newest.at, tabId: newest.tabId, more: queue.length - 1 },
    unseenWarning: queue.some((q) => q.level !== 'normal'),
  };
}
import { chat, getChatState, subscribeChat } from './chatStore.ts';
import { nextChange, PILL_DEMO, pillKey, pillState, type PillState } from './pill.ts';
import { moonOf, type Moon } from './presence.ts';
import { getSafety, subscribeSafety } from './safetyStore.ts';
import { onServerMessage } from './socket.ts';
import { getTalk, subscribeTalk } from './talk.ts';
import { getConnection, getSettings, getUsage, subscribeConnection, subscribeUsage } from './useHarvSocket.ts';

/**
 * The bridge to Harv's desktop app (apps/desktop, docs/PLAN.md §6p). In a browser it does nothing;
 * in the app the dashboard draws its own title bar, feeds the tray icon Harv's status, and turns
 * what needs the user into system notifications when the window isn't in front.
 */
export const inApp = isTauri();

export interface AppSettings {
  hotkey: string;
  autostart: boolean;
  /** False on Wayland: the hotkey is then a KDE shortcut that runs `harv`. */
  hotkeyWorks: boolean;
  version: string;
}

export interface UpdateInfo {
  behind: number;
  dirty: boolean;
  error: string | null;
}

export const desktop = {
  window(action: 'drag' | 'minimize' | 'maximize' | 'close') {
    void invoke('window_action', { action });
  },
  settings: () => invoke<AppSettings>('app_settings'),
  setSettings: (patch: { hotkey?: string; autostart?: boolean }) => invoke<AppSettings>('set_app_settings', patch),
  checkUpdates: () => invoke<UpdateInfo>('check_updates'),
  applyUpdate: () => invoke<UpdateInfo>('apply_update'),
  /** The system's own picker (one picker can't take files and folders at once). */
  pickPaths: (folders: boolean) => invoke<{ path: string; folder: boolean }[]>('pick_paths', { folders }),
  /** A see-through window, frosted (Acrylic, Windows only) when `blur`; or the solid one. */
  seeThrough(on: boolean, blur: boolean) {
    void invoke('set_see_through', { on, blur }).catch(() => {});
  },
};

/** "KeyH" → "H", "Digit1" → "1"; other codes (F5, Space, ArrowUp) stay as they are. */
const keyName = (code: string) => code.replace(/^Key|^Digit/, '');

/** A key combination from a keydown, in the form the app's hotkey takes ("Ctrl+Alt+H"); null until a real key joins the modifiers. */
export function comboOf(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  if (/^(Control|Alt|Shift|Meta|OS)/.test(e.code)) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  // A hotkey without Ctrl, Alt or Super would fire while typing.
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;
  return [...mods, keyName(e.code)].join('+');
}

const notify = (title: string, body: string) => void invoke('notify', { title, body }).catch(() => {});

if (inApp) {
  // The tray icon shows Harv's status; "offline" while the dashboard can't reach the server.
  let shown = '';
  const showStatus = () => {
    const { connected, status } = getConnection();
    const next = connected ? status : 'offline';
    if (next === shown) return;
    shown = next;
    void invoke('set_status', { status: next }).catch(() => {});
  };
  subscribeConnection(showStatus);
  showStatus();

  const tabTitle = (tabId: string) => getChatState().tabs.find((t) => t.id === tabId)?.title ?? 'Harv';
  // Which notices still become a system notification is the notice feed's call (docs/PLAN.md §6ad).
  setSystemNotify(notify);
  setFullscreenCheck(() => invoke<boolean>('fullscreen_now').catch(() => false));

  // Desktop control: the app's pill floats over every window while a chat uses the mouse and
  // keyboard (docs/PLAN.md §6t item 1), and its STOP stops that chat.
  let pill = '';
  const showPill = () => {
    const { desktop: control } = getSafety();
    // `at`: where it acts, so the pill sits on that monitor.
    const key = control ? JSON.stringify([control.tabId, control.action, control.at]) : '';
    if (key === pill) return;
    pill = key;
    const args = control
      ? { action: control.action, chat: tabTitle(control.tabId), at: control.at ?? null }
      : { action: null, chat: null, at: null };
    void invoke('desktop_pill', args).catch(() => {});
  };
  subscribeSafety(showPill);
  window.addEventListener('harv-pill-stop', () => {
    const control = getSafety().desktop;
    if (control) chat.stop(control.tabId);
  });

  // Harv's face on the desktop while his window isn't in front (pass C, C2; lib/pill.ts decides what).
  const moons = new Map<string, Moon | null>();
  let face: PillState | null = null;
  // Never matches a real key: the first update always goes out (a reloaded dashboard clears a pill left on screen).
  const UNSENT = 'unsent';
  let sentFace = UNSENT;
  let timer: number | undefined;
  const front = () => document.visibilityState === 'visible' && document.hasFocus();
  let demoing = false;
  const updateFace = () => {
    if (demoing) return;
    const usage = getUsage();
    const input = {
      front: front(),
      tabs: getChatState().tabs,
      approvals: getSafety().approvals,
      paused: getConnection().status === 'paused',
      pausedUntil: usage?.pausedUntil ?? undefined,
      moons,
      ...pillNotice(),
      ...(getTalk().by === 'key' && getTalk().stage !== 'off' ? { listening: getTalk().stage as 'recording' | 'hearing' } : {}),
      still: !getSettings().motion,
      now: Date.now(),
    };
    // On Linux a KWin script the app loads places the pill and hides it while Harv's window is in sight
    // (apps/desktop/src-tauri/src/pill_kwin.js, docs/PLAN.md §6af).
    face = pillState(input);
    const key = pillKey(face);
    if (key !== sentFace) {
      sentFace = key;
      const state = face ? { ...face, tabId: undefined } : null;
      void invoke('harv_pill', { state }).catch(() => {});
    }
    // A wait shrinking to the dot, a notice's line ending: worked out again then.
    window.clearTimeout(timer);
    const next = nextChange(face, input);
    if (next !== null) timer = window.setTimeout(updateFace, Math.max(50, next - Date.now()));
  };
  // Chat state changes with every streamed word: worked out at most a few times a second.
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    window.setTimeout(() => {
      queued = false;
      updateFace();
    }, 250);
  };
  subscribeChat(soon);
  subscribeSafety(soon);
  subscribeConnection(soon);
  subscribeUsage(soon);
  subscribeNotices(soon);
  subscribeTalk(updateFace);
  // Sends the current state even if unchanged: the app may have missed or reordered one (a stale pill stayed up).
  const resend = () => {
    if (demoing) return;
    sentFace = UNSENT;
    updateFace();
  };
  window.setInterval(resend, 20_000);
  window.addEventListener('focus', updateFace);
  window.addEventListener('blur', updateFace);
  document.addEventListener('visibilitychange', updateFace);
  onServerMessage((msg) => {
    if (msg.type === 'chat.started') moons.set(msg.tabId, null);
    else if (msg.type === 'chat.tool') moons.set(msg.tabId, moonOf(msg.name, msg.detail));
    else if (msg.type === 'chat.done') {
      moons.delete(msg.tabId);
    } else return;
    soon();
  });
  // scripts/pill-demo.mjs: every state once, shown even with Harv's window in front; then back to the real state.
  const playDemo = () => {
    if (demoing) return;
    demoing = true;
    window.clearTimeout(timer);
    for (const step of PILL_DEMO)
      window.setTimeout(() => {
        if ('face' in step) void invoke('harv_pill', { state: { ...step.face, still: !getSettings().motion, demo: true } }).catch(() => {});
        else if ('control' in step) void invoke('desktop_pill', { action: step.control, chat: 'Pill demo', at: null }).catch(() => {});
        else {
          // The app runs commands side by side: control off first, then (after it settled) the real state, sent for sure.
          void invoke('desktop_pill', { action: null, chat: null, at: null })
            .catch(() => {})
            .then(() => {
              demoing = false;
              resend();
            });
        }
      }, step.at);
  };
  onServerMessage((msg) => {
    if (msg.type === 'pill.demo') playDemo();
  });

  // A click on the face pill: the app brought the window up; open that chat (a notice about none:
  // its bubble waits in the window, opened).
  window.addEventListener('harv-pill-open', () => {
    if (!face) return;
    if (face.tabId) {
      chat.setActive(face.tabId);
      chat.setView(face.tabId, 'chat');
    }
    if (getNotices().queue.length) setNoticeOpen(true);
  });
}

/** A file or folder dropped on the app from File Explorer, by its path (src-tauri/src/main.rs `native_drop`). */
export interface DroppedItem {
  path: string;
  folder: boolean;
}

/**
 * Drops from File Explorer: the app's window takes them before the page sees one, and tells the
 * dashboard their paths (folders too). `onDrag` says when a drag is over the window. Unsubscribes.
 */
export function onNativeDrop(onDrop: (items: DroppedItem[]) => void, onDrag?: (over: boolean) => void): () => void {
  const drop = (e: Event) => onDrop((e as CustomEvent<{ items: DroppedItem[] }>).detail.items);
  const drag = (e: Event) => onDrag?.((e as CustomEvent<{ over: boolean }>).detail.over);
  window.addEventListener('harv-native-drop', drop);
  window.addEventListener('harv-native-drag', drag);
  return () => {
    window.removeEventListener('harv-native-drop', drop);
    window.removeEventListener('harv-native-drag', drag);
  };
}
