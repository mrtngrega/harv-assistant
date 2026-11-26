import type { ApprovalRequest } from '@harv/shared';
import type { Tab } from './chatStore.ts';
import type { Moon } from './presence.ts';
import { countdown } from './format.ts';
import { heldWaiting, isHeld } from './turns.ts';

/**
 * Harv's face on the desktop (pass C, C2; the app's pill, src-tauri/src/pill.rs): what it shows while
 * Harv's own window isn't in front. Pure, so it's tested; desktop.ts feeds it and sends the result.
 * Nothing at rest. What needs the user wins (amber, a dot after a few seconds), then a fresh notice
 * (its line for NOTICE_MS, amber for a warning: docs/PLAN.md §6ad), then a plan limit, then the work,
 * then an unseen warning's amber dot. Desktop control has its own pill and wins over all this.
 */

export type PillMode = 'work' | 'waiting' | 'dot' | 'asleep' | 'notice';

export interface PillState {
  mode: PillMode;
  text: string;
  chat: string;
  /** Other chats in the same kind of state. */
  more: number;
  moon: Moon | null;
  still: boolean;
  /** The chat a click opens (not sent to the app). */
  tabId: string;
}

/** A wait shows as the full pill this long, then shrinks to the dot. */
export const WAIT_FULL_MS = 8_000;
/** A notice's line stays this long. */
export const NOTICE_MS = 6_000;

/** A notice for the pill: the newest one, and whether a warning still waits unseen. */
export interface PillNotice {
  line: string;
  level: 'normal' | 'warning' | 'urgent';
  at: number;
  tabId?: string;
  /** Others waiting behind it. */
  more: number;
}

export interface PillInput {
  /** Harv's window is in front (visible and focused): the hammock and the status line say it all. */
  front: boolean;
  tabs: Tab[];
  approvals: ApprovalRequest[];
  paused: boolean;
  /** Epoch ms when the plan limit resets (the pill counts down to it). */
  pausedUntil?: number;
  /** The last tool's moon per chat in this turn. */
  moons: Map<string, Moon | null>;
  /** The newest notice that waits unseen (docs/PLAN.md §6ad). */
  notice?: PillNotice;
  /** A warning or urgent notice still waits unseen: an amber dot once its line is over. */
  unseenWarning?: boolean;
  /** The hold key (Ctrl+Alt+Space) is recording, or Whisper is hearing it (voice plan V1b). */
  listening?: 'recording' | 'hearing';
  still: boolean;
  now: number;
}

/** When a chat started waiting for the user: its first held line since the user's last message, or its card. */
function waitingSince(tab: Tab, approvals: ApprovalRequest[], now: number): number {
  const card = approvals.find((a) => a.tabId === tab.id);
  let at = card ? card.at : now;
  for (let i = tab.lines.length - 1; i >= 0 && tab.lines[i]!.kind !== 'you'; i--) {
    const line = tab.lines[i]!;
    if (isHeld(line)) at = Math.min(at, line.at ?? now);
  }
  return at;
}

export function pillState(i: PillInput): PillState | null {
  if (i.front) return null;
  const base = { still: i.still, moon: null };
  // Push-to-talk from anywhere: the pill is the only sign the microphone is open.
  if (i.listening)
    return {
      ...base,
      mode: 'notice',
      text: i.listening === 'recording' ? 'listening… let go to send' : 'hearing you…',
      chat: '',
      more: 0,
      tabId: '',
    };
  const waiting = i.tabs.filter((t) => i.approvals.some((a) => a.tabId === t.id) || (!t.busy && heldWaiting(t.lines) > 0));
  if (waiting.length) {
    const since = Math.min(...waiting.map((t) => waitingSince(t, i.approvals, i.now)));
    const first = waiting[0]!;
    const card = i.approvals.find((a) => a.tabId === first.id);
    const text =
      card?.kind === 'question' ? 'has a question for you' : card?.kind === 'plan' ? 'a plan waits for your OK' : 'waiting for your yes';
    return {
      ...base,
      mode: i.now - since >= WAIT_FULL_MS ? 'dot' : 'waiting',
      text,
      chat: first.title,
      more: waiting.length - 1,
      tabId: first.id,
    };
  }
  const n = i.notice;
  if (n && i.now - n.at < NOTICE_MS)
    return {
      ...base,
      mode: n.level === 'normal' ? 'notice' : 'waiting',
      text: n.line,
      chat: '',
      more: n.more,
      tabId: n.tabId ?? '',
    };
  const busy = i.tabs.filter((t) => t.busy).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  if (i.paused && (busy.length || i.tabs.some((t) => t.queued?.length))) {
    const tab = busy[0] ?? i.tabs.find((t) => t.queued?.length)!;
    return {
      ...base,
      mode: 'asleep',
      text: i.pausedUntil ? `plan limit · back in ${countdown(i.pausedUntil, i.now)}` : 'plan limit',
      chat: tab.title,
      more: 0,
      tabId: tab.id,
    };
  }
  if (busy.length) {
    const tab = busy[0]!;
    return {
      ...base,
      mode: 'work',
      text: tab.activity ?? 'thinking…',
      chat: tab.title,
      more: busy.length - 1,
      moon: i.moons.get(tab.id) ?? null,
      tabId: tab.id,
    };
  }
  if (n && i.unseenWarning) return { ...base, mode: 'dot', text: n.line, chat: '', more: n.more, tabId: n.tabId ?? '' };
  return null;
}

/** What the app gets (no tab id): the same object twice in a row is not sent again. */
export const pillKey = (p: PillState | null) => (p ? JSON.stringify({ ...p, tabId: undefined }) : '');

/** When the pill must be worked out again without any event: a wait shrinking to the dot, a note ending. */
export function nextChange(p: PillState | null, i: PillInput): number | null {
  // A notice's line ends first (it shows in the waiting look too, with no chat behind it).
  if (i.notice && i.now - i.notice.at < NOTICE_MS) return i.notice.at + NOTICE_MS;
  if (p?.mode === 'waiting') {
    const tab = i.tabs.find((t) => t.id === p.tabId);
    return tab ? waitingSince(tab, i.approvals, i.now) + WAIT_FULL_MS : null;
  }
  // The countdown's next minute.
  if (p?.mode === 'asleep' && i.pausedUntil) return i.now + ((((i.pausedUntil - i.now) % 60_000) + 60_000) % 60_000) + 50;
  return null;
}

/** One step of the pill's demo: when (ms from the start) and what it shows; `control` = desktop control's pill. */
export type PillDemoStep = { at: number } & ({ face: Omit<PillState, 'tabId' | 'still'> } | { control: string } | { end: true });

const demoFace = (mode: PillMode, text: string, moon: Moon | null = null, more = 0) => ({
  face: { mode, text, chat: 'Pill demo', more, moon },
});

/** scripts/pill-demo.mjs: every state once (~50 s), each saying what it means. Nothing real behind it. */
export const PILL_DEMO: PillDemoStep[] = [
  { at: 0, ...demoFace('work', 'thinking… (his eyes scan)') },
  { at: 5_000, ...demoFace('work', 'Read · lit dot = tool in use', 'files') },
  { at: 9_500, ...demoFace('work', 'PowerShell · +2 more chats work', 'shell', 2) },
  { at: 14_000, ...demoFace('work', 'WebSearch · the web moon', 'web') },
  { at: 18_500, ...demoFace('waiting', 'waiting for your yes · click me') },
  { at: 25_000, ...demoFace('dot', 'still waiting: the amber dot') },
  { at: 31_000, ...demoFace('asleep', 'plan limit · back in 1h 12m') },
  { at: 37_000, ...demoFace('notice', 'replied (a reply just ended)') },
  { at: 42_000, control: 'Demo: desktop control · STOP ends it' },
  { at: 50_000, end: true },
];
