import type {
  BackgroundTask,
  Attachment,
  ChatServerMessage,
  ClientMessage,
  ChatSnapshot,
  ChatView,
  EffortLevel,
  HistoryItem,
  LineKind,
  ModelChoice,
  QueuedMessage,
  SharedUi,
  SlashCommandInfo,
  ToolKind,
  UiState,
} from '@harv/shared';
import { isTauri } from '@tauri-apps/api/core';
import { newChatTask, terminalId } from '@harv/shared';
import { createStore } from './createStore.ts';
import { addAttachment, dropDrafts, replaceDrafts, setDraftText } from './drafts.ts';
import { onServerMessage, sendMessage } from './socket.ts';
import { loadJson, saveJson } from './storage.ts';
import { activityOf } from './turns.ts';

export type { LineKind };

export interface Line {
  id: string;
  kind: LineKind;
  text: string;
  /** "sonnet·medium" on Harv's replies; how long it thought ("12s") on thinking lines. */
  tag?: string;
  /** Why that model·effort was picked (shown on hover). */
  reason?: string;
  /** Names of files attached to the user's message. */
  files?: string[];
  /** On tool lines: the action log id. */
  ref?: string;
  /** When it was written (epoch ms). */
  at: number;
  streaming?: boolean;
  /** Only this window has it (command help, a heads-up, "not connected"): kept over a reconnect (the full review, U31). */
  local?: boolean;
}

export interface Tab {
  id: string;
  title: string;
  lines: Line[];
  busy: boolean;
  /** The Harv line deltas currently stream into. */
  currentId: string | null;
  tag?: string;
  reason?: string;
  /** The conversation's context size (live, from each message's own usage). */
  context?: number;
  /** The server has this chat (it came from there, or a message was sent): otherwise it's a blank tab only the dashboard knows. */
  stored?: boolean;
  /** The project this chat works on (project mode), if any. */
  projectId?: string;
  /** Messages typed while Harv was answering, waiting for the turn to end. */
  queued?: QueuedMessage[];
  /** This chat's Claude Code commands once its session runs (otherwise the catalog's). */
  commands?: SlashCommandInfo[];
  /** Background agents and shells it started (the strip above the prompt). */
  tasks?: BackgroundTask[];
  /** The status line above the input (like Claude Code's): when this turn began, its output tokens so far, the tool running. */
  startedAt?: number;
  outTokens?: number;
  activity?: string;
  /** How the last finished turn went, shown faintly when idle. */
  lastTurn?: { ms: number; tokens: number };
  /** Plan mode: Harv only reads and plans until the user approves a plan. */
  planning?: boolean;
}

/** The Settings tab's id in `activeId`; it sits in the tab bar after the chats. */
export const SETTINGS_TAB = 'settings';

export interface ChatState {
  tabs: Tab[];
  /** A chat tab's id, SETTINGS_TAB, or null when nothing is open. */
  activeId: string | null;
  /** The Settings tab is in the tab bar. */
  settingsOpen: boolean;
  /** What each chat shows: its log or one of its tools (missing = the log). */
  views: Record<string, ChatView>;
  /** Tools each chat has open, in the order they were opened. */
  tools: Record<string, ToolKind[]>;
  model: ModelChoice;
  effort: EffortLevel;
  /**
   * The server's first hello has come: until then the tabs are only the starter blank tab,
   * which flashed "New chat" before the saved chats replaced it (the user's report, 2026-10-27).
   */
  hydrated: boolean;
}

const newId = () => crypto.randomUUID();
/** One-message overrides at the start ("/opus /max …") don't belong in a tab title. */
const OVERRIDE_WORDS = /^(\s*\/(opus|sonnet|haiku|fable|low|med|medium|high|xhigh|max)\b)+\s*/i;
/** A new chat's first title, cut like the server cuts it so it doesn't change on reload. */
/** A new tab's first name from its first message, without a leading /report or /btw (the server names it the same way). */
export const titleFrom = (text: string) => {
  const t = text.replace(/^\/(report|btw)\s+/i, '');
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
};
const blankTab = (): Tab => ({ id: newId(), title: 'New chat', lines: [], busy: false, currentId: null });

/**
 * A tab's shown name: an empty chat with a tool open is named after it, "Files", "Browser" or "Terminal"
 * (the user's wish, 2026-11-13); its first message names it for real.
 */
const TOOL_TITLES: Record<ToolKind, string> = { files: 'Files', browser: 'Browser', terminal: 'Terminal' };
export function tabTitle(t: Pick<Tab, 'title' | 'lines'>, view: ChatView | undefined, tools: ToolKind[] | undefined): string {
  if (t.title !== 'New chat' || t.lines.length) return t.title;
  const tool = view && view !== 'chat' ? view : tools?.at(-1);
  return tool ? TOOL_TITLES[tool] : t.title;
}

// The model/effort pick belongs to its chat (the user's rule, 2026-11-11: a manual pick stays until
// they pick AUTO again; it used to be one pick per window, and a reload put AUTO back). Saved per
// computer, surviving reloads; storage can be unavailable.
type Selection = { model: ModelChoice; effort: EffortLevel };
const PICKS_KEY = 'harv.picks';
const DEFAULT_PICK: Selection = { model: 'auto', effort: 'high' };
const saved = loadJson<Record<string, Selection> | null>(PICKS_KEY, null);
const picks: Record<string, Selection> = saved && typeof saved === 'object' ? saved : {};
function savePick(tabId: string, pick: Selection) {
  if (pick.model === 'auto' && pick.effort === DEFAULT_PICK.effort) delete picks[tabId];
  else picks[tabId] = pick;
  saveJson(PICKS_KEY, picks);
}
const pickOf = (tabId: string | null): Selection => (tabId && picks[tabId]) || DEFAULT_PICK;
/** A deleted chat's pick goes with it (the list only grew: the full review, U15). */
function dropPick(tabId: string) {
  if (!(tabId in picks)) return;
  delete picks[tabId];
  saveJson(PICKS_KEY, picks);
}

const first = blankTab();
const store = createStore<ChatState>({
  tabs: [first],
  activeId: first.id,
  settingsOpen: false,
  views: {},
  tools: {},
  hydrated: false,
  ...DEFAULT_PICK,
});

// The header shows the active chat's own pick: whenever the active chat changes, its pick comes back.
let shownFor: string | null = null;
store.subscribe(() => {
  const { activeId, model, effort } = store.get();
  if (activeId === shownFor) return;
  shownFor = activeId;
  const pick = pickOf(activeId);
  if (pick.model !== model || pick.effort !== effort) store.set((s) => ({ ...s, ...pick }));
});

export const useChat = store.use;
export const getChatState = store.get;

export interface HistoryState {
  items: HistoryItem[];
  query: string;
}
const history = createStore<HistoryState>({ items: [], query: '' });
export const useHistory = history.use;

export const fromSnapshot = (chat: ChatSnapshot): Tab => ({
  id: chat.id,
  stored: true,
  ...(chat.projectId ? { projectId: chat.projectId } : {}),
  title: chat.title,
  // Mid-reply when this window connected (the full review, U1): busy, so STOP and the status line show.
  busy: !!chat.running,
  ...(chat.running
    ? {
        startedAt: chat.running.since,
        tag: tagOf(chat.running.model, chat.running.effort),
        ...(chat.running.reason ? { reason: chat.running.reason } : {}),
      }
    : {}),
  currentId: null,
  ...(chat.context ? { context: chat.context } : {}),
  ...(chat.queued?.length ? { queued: chat.queued } : {}),
  ...(chat.commands ? { commands: chat.commands } : {}),
  ...(chat.tasks?.length ? { tasks: chat.tasks } : {}),
  ...(chat.planning ? { planning: true } : {}),
  lines: linesOf(chat),
});

const linesOf = (chat: ChatSnapshot): Line[] =>
  chat.lines.map((l) => ({
    id: newId(),
    at: l.at ?? Date.now(),
    kind: l.kind,
    text: l.text,
    ...(l.tag ? { tag: l.tag } : {}),
    ...(l.reason ? { reason: l.reason } : {}),
    ...(l.files ? { files: l.files } : {}),
    ...(l.ref ? { ref: l.ref } : {}),
  }));

/** Keeps only the entries of a per-chat map whose chat is still a tab. */
const onlyTabs = <T>(map: Record<string, T>, tabs: Tab[]) =>
  Object.fromEntries(Object.entries(map).filter(([id]) => tabs.some((t) => t.id === id)));

/**
 * Saved chats from the server replace ours; unsent blank tabs are kept. `ui`
 * (the saved layout) is given on the first connect only: it brings back blank
 * tabs, the tab order, which tab was showing and each chat's tools, like
 * Chrome reopening its tabs. After a reconnect the dashboard's own layout wins.
 */
function hydrate(chats: ChatSnapshot[], saved?: UiState) {
  const ui = saved;
  store.set((s) => {
    // The server's copy of each chat, plus the lines only this window had (U31), in time order.
    const saved = chats.map(fromSnapshot).map((c) => {
      const local = s.tabs.find((t) => t.id === c.id)?.lines.filter((l) => l.local) ?? [];
      return local.length ? { ...c, lines: [...c.lines, ...local].sort((a, b) => a.at - b.at) } : c;
    });
    // The untouched starter tab gives way to saved chats; blank tabs the user opened stay.
    const blanks = s.tabs.filter((t) => !t.stored && t.id !== first.id && !saved.some((c) => c.id === t.id));
    for (const id of ui?.blanks ?? []) {
      if (!saved.some((c) => c.id === id) && !blanks.some((t) => t.id === id)) blanks.push({ ...blankTab(), id });
    }
    let tabs = [...saved, ...blanks];
    if (ui?.order.length) {
      tabs = inOrder(tabs, ui.order);
    }
    if (tabs.length === 0) tabs.push(s.tabs.find((t) => t.id === first.id) ?? blankTab());

    const settingsOpen = s.settingsOpen || !!ui?.settingsOpen;
    const wanted = ui ? ui.activeId : s.activeId;
    const valid = (id: string | null) => (id === SETTINGS_TAB && settingsOpen) || tabs.some((t) => t.id === id);
    const activeId = valid(wanted) ? wanted : valid(s.activeId) ? s.activeId : tabs.at(-1)!.id;
    const views = onlyTabs(ui ? { ...ui.views, ...s.views } : s.views, tabs);
    const tools = onlyTabs(ui ? { ...ui.tools, ...s.tools } : s.tools, tabs);
    return { ...s, tabs, activeId, settingsOpen, views, tools, hydrated: true };
  });
}

/**
 * Another window's tabs: blank tabs come and go as there, every
 * tab takes its place in the order, and the drafts are the same. Saved chats open and close
 * through chat.opened / chat.removed, which come first. Which tab shows stays this device's.
 */
/** Chats asked for with chat.load, and when (asked again after a while: it may not have been saved yet). */
const loading = new Map<string, number>();
/** Chats this window asked to reopen from History: only it switches to them (the full review, U28). */
const openedHere = new Set<string>();
/** Chats where this window said "start a new chat and …": it switches to the new one when it opens. */
const movedHere = new Set<string>();

export function syncLayout(ui: SharedUi, windows?: Pick<UiState, 'tools' | 'views'>): void {
  store.set((s) => {
    // Another window of this same Harv: each chat's open tools and view too.
    if (windows) s = { ...s, tools: windows.tools, views: windows.views };
    // A blank tab that left the blanks but not the order got its first message in another window: a saved chat now.
    let tabs = s.tabs
      .filter((t) => t.stored || t.busy || ui.order.includes(t.id))
      .map((t) => (t.stored || ui.blanks.includes(t.id) ? t : { ...t, stored: true }));
    for (const id of ui.blanks) if (!tabs.some((t) => t.id === id)) tabs.push({ ...blankTab(), id });
    // Saved chats this window hasn't got (made while it was away or asleep): the server sends them.
    for (const id of ui.order)
      if (!ui.blanks.includes(id) && !tabs.some((t) => t.id === id) && Date.now() - (loading.get(id) ?? 0) > 3000) {
        loading.set(id, Date.now());
        sendMessage({ type: 'chat.load', tabId: id });
      }
    tabs = inOrder(tabs, ui.order);
    if (tabs.length === 0) tabs.push(blankTab());
    const valid = (id: string | null) => (id === SETTINGS_TAB && s.settingsOpen) || tabs.some((t) => t.id === id);
    const activeId = valid(s.activeId) ? s.activeId : tabs.at(-1)!.id;
    return { ...s, tabs, activeId, views: onlyTabs(s.views, tabs), tools: onlyTabs(s.tools, tabs) };
  });
  replaceDrafts(ui.drafts, ui.attachments);
}

function updateTab(id: string, fn: (tab: Tab) => Tab) {
  store.set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? fn(t) : t)) }));
}

const line = (kind: LineKind, text: string, extra: Partial<Line> = {}): Line => ({ id: newId(), kind, text, at: Date.now(), ...extra });

/** Marks the streaming line finished, dropping it if nothing arrived. */
function finishCurrent(tab: Tab): Tab {
  if (!tab.currentId) return tab;
  const lines = tab.lines
    .filter((l) => !(l.id === tab.currentId && l.text === ''))
    .map((l) => (l.id === tab.currentId ? { ...l, streaming: false } : l));
  return { ...tab, lines, currentId: null };
}

/** Adds text to the streaming line, creating one after a tool call. */
function withCurrent(tab: Tab, update: (text: string) => string): Tab {
  if (tab.currentId) {
    return { ...tab, lines: tab.lines.map((l) => (l.id === tab.currentId ? { ...l, text: update(l.text) } : l)) };
  }
  const fresh = line('harv', update(''), { tag: tab.tag, reason: tab.reason, streaming: true });
  return { ...tab, lines: [...tab.lines, fresh], currentId: fresh.id };
}

/** A turn begins: the status line's clock starts (a turn already running keeps its own). */
const turnStart = (t: Tab): Partial<Tab> => (t.busy && t.startedAt ? {} : { startedAt: Date.now(), outTokens: 0, activity: undefined });

export function applyChatEvent(msg: ChatServerMessage): void {
  switch (msg.type) {
    case 'chat.pick': {
      savePick(msg.tabId, { model: msg.model, effort: msg.effort });
      if (store.get().activeId === msg.tabId) store.set((s) => ({ ...s, model: msg.model, effort: msg.effort }));
      break;
    }
    case 'chat.started': {
      // A turn runs in it (sent here, on the other device, or by a schedule): the start question is answered.
      if (startQuestions.get().includes(msg.tabId)) {
        startQuestions.set((ids) => ids.filter((id) => id !== msg.tabId));
        markAnswered(msg.tabId);
      }
      const tag = tagOf(msg.model, msg.effort);
      const { reason } = msg;
      updateTab(msg.tabId, (t) => {
        // The thinking line added on send gets its tag now that the router has decided.
        const waiting = t.lines.find((l) => l.id === t.currentId && l.text === '');
        if (waiting) {
          const lines = t.lines.map((l) => (l === waiting ? { ...l, tag, reason } : l));
          return { ...t, ...turnStart(t), busy: true, tag, reason, lines };
        }
        const pending = line('harv', '', { tag, reason, streaming: true });
        return { ...t, ...turnStart(t), busy: true, tag, reason, lines: [...t.lines, pending], currentId: pending.id };
      });
      break;
    }
    case 'chat.stepped': {
      // AUTO stepped up mid-reply: the reply in progress (and what follows) shows the new model·effort.
      const tag = tagOf(msg.model, msg.effort);
      const { reason } = msg;
      updateTab(msg.tabId, (t) => ({
        ...t,
        tag,
        reason,
        lines: t.lines.map((l) => (l.id === t.currentId && l.kind === 'harv' ? { ...l, tag, reason } : l)),
      }));
      break;
    }
    case 'chat.delta':
      updateTab(msg.tabId, (t) => ({ ...withCurrent(t, (text) => text + msg.text), activity: undefined }));
      break;
    case 'chat.progress':
      updateTab(msg.tabId, (t) => ({ ...t, outTokens: msg.outputTokens }));
      break;
    case 'chat.assistant':
      updateTab(msg.tabId, (t) => withCurrent(t, () => msg.text));
      break;
    case 'chat.thinking':
      // Before the reply it led to: in front of the waiting (still empty) reply line, if there is one.
      updateTab(msg.tabId, (t) => {
        const thought = line('thinking', msg.text, { tag: `${msg.seconds}s` });
        const current = t.lines.find((l) => l.id === t.currentId);
        if (current && current.text === '') {
          const at = t.lines.indexOf(current);
          return { ...t, lines: [...t.lines.slice(0, at), thought, ...t.lines.slice(at)] };
        }
        return { ...t, lines: [...finishCurrent(t).lines, thought], currentId: null };
      });
      break;
    case 'chat.tool':
      updateTab(msg.tabId, (t) => {
        const done = finishCurrent(t);
        return {
          ...done,
          activity: activityOf(msg.name),
          lines: [...done.lines, line('tool', msg.detail ? `${msg.name} · ${msg.detail}` : msg.name, { ref: msg.id })],
        };
      });
      break;
    case 'chat.done':
      updateTab(msg.tabId, (t) => {
        const done = finishCurrent(t);
        const extra: Line[] = [];
        if (msg.stopped) extra.push(line('notice', 'Stopped.'));
        if (msg.error) extra.push(line('error', msg.error));
        const lastTurn = {
          ms: msg.usage?.durationMs ?? (done.startedAt ? Date.now() - done.startedAt : 0),
          tokens: msg.usage?.outputTokens ?? done.outTokens ?? 0,
        };
        return {
          ...done,
          busy: false,
          startedAt: undefined,
          activity: undefined,
          lastTurn,
          lines: [...done.lines, ...extra],
        };
      });
      break;
    case 'chat.context':
      updateTab(msg.tabId, (t) => ({ ...t, context: msg.tokens }));
      break;
    case 'chat.notice':
      updateTab(msg.tabId, (t) => ({ ...t, lines: [...t.lines, line('notice', msg.message)] }));
      break;
    case 'chat.line': {
      const { kind, text, ...rest } = msg.line;
      // A line from the server: the chat is saved there (it may have been sent from another window).
      updateTab(msg.tabId, (t) => ({ ...t, stored: true, lines: [...t.lines, line(kind, text, rest)] }));
      break;
    }
    case 'chat.error':
      updateTab(msg.tabId, (t) => ({ ...t, lines: [...t.lines, line('error', msg.message)] }));
      break;
    case 'chat.opened': {
      loading.delete(msg.chat.id);
      // This window reopened it from History: it switches there; the others only get the tab (U28).
      // So does the window where "start a new chat and …" was said (`movedFrom`, docs/PLAN.md §6ac).
      const asked = openedHere.delete(msg.chat.id) || (!!msg.movedFrom && movedHere.delete(msg.movedFrom));
      store.set((s) => ({
        ...s,
        tabs: s.tabs.some((t) => t.id === msg.chat.id) ? s.tabs : [...s.tabs, fromSnapshot(msg.chat)],
        activeId: !asked && msg.focus === false && s.activeId ? s.activeId : msg.chat.id,
      }));
      break;
    }
    case 'chat.renamed':
      updateTab(msg.tabId, (t) => ({ ...t, title: msg.title }));
      break;
    case 'chat.queued':
      updateTab(msg.tabId, (t) => ({ ...t, queued: msg.items }));
      break;
    case 'chat.commands':
      updateTab(msg.tabId, (t) => ({ ...t, commands: msg.commands }));
      break;
    case 'chat.tasks':
      updateTab(msg.tabId, (t) => ({ ...t, tasks: msg.tasks }));
      break;
    case 'chat.cleared':
      updateTab(msg.tabId, (t) => ({ ...t, lines: [], currentId: null, context: undefined, lastTurn: undefined }));
      break;
    case 'chat.plan':
      updateTab(msg.tabId, (t) => ({ ...t, planning: msg.on }));
      break;
    case 'chat.rewound':
      // The lines as the server has them now; the message it went back before goes into the input to edit.
      updateTab(msg.tabId, (t) => ({ ...t, lines: linesOf(msg.chat), currentId: null, context: msg.chat.context, lastTurn: undefined }));
      if (msg.text) setDraftText(msg.tabId, msg.text);
      break;
    case 'chat.removed':
      dropPick(msg.tabId);
      store.set((s) => {
        const tabs = s.tabs.filter((t) => t.id !== msg.tabId);
        return { ...withoutChat(s, msg.tabId), tabs, activeId: s.activeId === msg.tabId ? (tabs.at(-1)?.id ?? null) : s.activeId };
      });
      break;
    case 'history':
      // Ignore answers to a search the user has since changed.
      if (msg.query === history.get().query) history.set({ items: msg.items, query: msg.query });
      break;
  }
}

/** A chat's views and tools, forgotten when it closes. */
function withoutChat(s: ChatState, id: string): ChatState {
  const { [id]: _view, ...views } = s.views;
  const { [id]: _tools, ...tools } = s.tools;
  return { ...s, views, tools };
}

let restored = false;
/** Listeners for the saved layout on the first connect (drafts, explorer folders). */
const restoreListeners = new Set<(ui: UiState) => void>();
export const onLayoutRestore = (fn: (ui: UiState) => void) => void restoreListeners.add(fn);
/** True once the first hello brought the saved layout back; saving before that would wipe it. */
export const layoutRestored = () => restored;
export const subscribeChat = store.subscribe;

/**
 * Chats from before Harv started that still wait for "continue or new session".
 * Each chat asks on its own, inside its tab, whenever the user opens it.
 */
export const startQuestions = createStore<string[]>([]);

/**
 * Chats already answered since the server started (`boot` = its start time), kept
 * in localStorage so a page reload (Vite reloads it on some edits) doesn't ask again.
 */
const ANSWERED_KEY = 'harv.startAnswered';
let boot: number | null = null;
/** This server start's record: the chats it asked (`asked`, absent before the first ask) and those answered (`ids`). */
interface StartRecord {
  boot: number;
  ids: string[];
  asked?: string[];
}
function record(): StartRecord | null {
  const saved = loadJson<StartRecord | null>(ANSWERED_KEY, null);
  return saved?.boot === boot ? saved : null;
}
const answered = () => record()?.ids ?? [];
// No storage: a reload just asks again.
const saveRecord = (next: StartRecord) => saveJson(ANSWERED_KEY, next);
const markAnswered = (id: string) => saveRecord({ ...(record() ?? { boot: boot ?? 0 }), ids: [...answered(), id] });

/**
 * On a fresh server start, every chat Harv has answered in asks once (unless answered before a reload).
 * One with only notes (`/report`, notices) has no Claude session to continue, so it doesn't ask.
 */
export function askOnStart(chats: ChatSnapshot[], startedAt: number | undefined) {
  if (startedAt === boot) return;
  const first = boot === null;
  boot = startedAt ?? 0;
  // A reconnect to the same server (no startedAt from an older server) isn't a new start.
  if (!first && !startedAt) return;
  const saved = record();
  const done = saved?.ids ?? [];
  // Only a chat with a Claude session here has something to continue (one from the other device starts fresh anyway).
  const resumable = chats.filter((c) => c.resumable && c.lines.some((l) => l.kind === 'harv')).map((c) => c.id);
  // A page reload in the same server run asks only what the start asked: a chat first used after it has nothing to pick.
  const asked = saved?.asked ?? resumable;
  if (!saved?.asked) saveRecord({ boot: boot ?? 0, ids: done, asked });
  startQuestions.set(resumable.filter((id) => asked.includes(id) && !done.includes(id)));
}

/**
 * The answer for one chat. "continue" keeps its tab and session. "new" swaps the
 * tab for a blank chat in the same place (the old chat stays in history), so the
 * next message starts a fresh session.
 */
export function answerStart(tabId: string, choice: 'continue' | 'new') {
  startQuestions.set((ids) => ids.filter((id) => id !== tabId));
  markAnswered(tabId);
  if (choice === 'continue') return;
  const at = store.get().tabs.findIndex((t) => t.id === tabId);
  chat.closeTab(tabId);
  const blank = blankTab();
  store.set((s) => ({ ...s, tabs: [...s.tabs.slice(0, at), blank, ...s.tabs.slice(at)], activeId: blank.id }));
}

onServerMessage((msg) => {
  if (msg.type === 'hello') {
    if (restored) {
      hydrate(msg.chats);
    } else {
      hydrate(msg.chats, msg.ui);
      restored = true;
      restoreListeners.forEach((fn) => fn(msg.ui));
    }
    askOnStart(msg.chats, msg.startedAt);
    history.set({ items: msg.history, query: '' });
  } else if (msg.type === 'chat.project') {
    // The server now knows this chat (a project needs a saved chat).
    updateTab(msg.tabId, (t) => {
      const { projectId: _old, ...rest } = t;
      return { ...rest, stored: true, ...(msg.projectId ? { projectId: msg.projectId } : {}) };
    });
  } else if (msg.type === 'ui.synced') {
    if (restored) syncLayout(msg.ui, msg.windows);
  } else if (msg.type === 'term.show') {
    // Harv runs something in a terminal. His own one for a chat (`from`) is a tab of its own next to it,
    // never the chat's own view (the user's report note, 2026-11-19): made if it isn't open, and brought
    // to the front where that chat is on screen. Another tab's terminal (terminal_run's chat) shows in place.
    const s = store.get();
    const open = s.tabs.some((t) => t.id === msg.tabId);
    if (!msg.from) {
      if (open) chat.setView(msg.tabId, 'terminal');
      return;
    }
    if (!open) {
      const tab: Tab = { ...blankTab(), id: msg.tabId };
      store.set((st) => ({ ...st, tabs: [...st.tabs, tab] }));
      if (s.tabs.some((t) => t.id === msg.from)) chat.moveTab(msg.tabId, msg.from, true);
    }
    chat.setView(msg.tabId, 'terminal');
    if (s.activeId === msg.from) chat.setActive(msg.tabId);
  } else if (msg.type === 'browser.show') {
    // Harv opens a page: the browser comes up in a tab of its own, never over the asking chat (the user's
    // wish, 2026-11-16): a tab already showing it, else a new one next to that chat. Only the app has the
    // browser, so the phone (another window of the same Harv) does nothing, or both would make a tab.
    if (!isTauri()) return;
    const s = store.get();
    const shown = s.tabs.find((t) => s.views[t.id] === 'browser');
    if (shown) chat.setActive(shown.id);
    else {
      const id = chat.newTab('browser');
      if (s.tabs.some((t) => t.id === msg.tabId)) chat.moveTab(id, msg.tabId, true);
    }
  } else if (msg.type.startsWith('chat.') || msg.type === 'history') {
    applyChatEvent(msg as ChatServerMessage);
  }
});

/** Folders a chat's terminal should start in (from the explorer's "Open in Terminal"). */
export const terminalStart = new Map<string, string>();

/** A message that couldn't go out: the socket is down. */
const offline = (tabId: string) =>
  updateTab(tabId, (t) => ({ ...t, lines: [...t.lines, line('error', 'Not connected to the Harv server.', { local: true })] }));

/** Tabs in the saved layout's order; ones it doesn't know keep their place after those. */
function inOrder(tabs: Tab[], order: string[]): Tab[] {
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? Infinity : i;
  };
  return tabs
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.i - b.i)
    .map(({ t }) => t);
}

/** A reply's `[model·effort]` tag: "Sonnet 5.5" at medium → "sonnet·medium". */
const tagOf = (model: string, effort: string) => `${model.split(' ')[0]!.toLowerCase()}·${effort}`;

export const chat = {
  setModel(model: ModelChoice) {
    store.set((s) => ({ ...s, model }));
    const { activeId, effort } = store.get();
    if (activeId) savePick(activeId, { model, effort });
  },
  setEffort(effort: EffortLevel) {
    store.set((s) => ({ ...s, effort }));
    const { activeId, model } = store.get();
    if (activeId) savePick(activeId, { model, effort });
  },
  setActive: (activeId: string) => store.set((s) => ({ ...s, activeId })),

  /** Makes a chat a project chat (Harv works there as Claude Code), or a plain chat again with null. */
  setProject(tabId: string, projectId: string | null) {
    sendMessage({ type: 'chat.setProject', tabId, projectId });
  },

  /** Opens a new chat (optionally straight into one of its tools) and returns its id. */
  newTab(view: ChatView = 'chat'): string {
    const tab = blankTab();
    store.set((s) => ({
      ...s,
      tabs: [...s.tabs, tab],
      activeId: tab.id,
      ...(view !== 'chat' ? { views: { ...s.views, [tab.id]: view }, tools: { ...s.tools, [tab.id]: [view] } } : {}),
    }));
    return tab.id;
  },

  /** Moves a tab next to another one (before it, or after it when `after`). The order is saved with the layout. */
  moveTab(id: string, targetId: string, after: boolean) {
    if (id === targetId) return;
    store.set((s) => {
      const moving = s.tabs.find((t) => t.id === id);
      if (!moving || !s.tabs.some((t) => t.id === targetId)) return s;
      const rest = s.tabs.filter((t) => t.id !== id);
      const at = rest.findIndex((t) => t.id === targetId) + (after ? 1 : 0);
      const tabs = [...rest.slice(0, at), moving, ...rest.slice(at)];
      return tabs.every((t, i) => t === s.tabs[i]) ? s : { ...s, tabs };
    });
  },

  closeTab(id: string) {
    // The server ends the chat's terminal too.
    sendMessage({ type: 'chat.close', tabId: id });
    dropDrafts(id);
    store.set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeId = s.activeId === id ? (tabs.at(-1)?.id ?? (s.settingsOpen ? SETTINGS_TAB : null)) : s.activeId;
      return { ...withoutChat(s, id), tabs, activeId };
    });
  },

  /** Shows a chat's log or one of its tools, opening the tool if it isn't yet. */
  setView(tabId: string, view: ChatView) {
    store.set((s) => {
      const open = s.tools[tabId] ?? [];
      const tools = view === 'chat' || open.includes(view) ? s.tools : { ...s.tools, [tabId]: [...open, view] };
      return { ...s, tools, views: { ...s.views, [tabId]: view } };
    });
  },

  /** Closes one of a chat's tools; the chat goes back to its log. */
  closeTool(tabId: string, kind: ToolKind) {
    if (kind === 'terminal') sendMessage({ type: 'term.close', id: terminalId(tabId) });
    store.set((s) => ({
      ...s,
      tools: { ...s.tools, [tabId]: (s.tools[tabId] ?? []).filter((k) => k !== kind) },
      views: s.views[tabId] === kind ? { ...s.views, [tabId]: 'chat' } : s.views,
    }));
  },

  /** The chat's terminal in `dir`: the server starts it there, moves a running one there, or restarts an exited one there. */
  terminalAt(tabId: string, dir: string) {
    terminalStart.set(tabId, dir);
    chat.setView(tabId, 'terminal');
  },

  /** Opens Settings as a tab in the chat bar (or switches to it). */
  openSettings: () => store.set((s) => ({ ...s, settingsOpen: true, activeId: SETTINGS_TAB })),

  closeSettings() {
    store.set((s) => ({
      ...s,
      settingsOpen: false,
      activeId: s.activeId === SETTINGS_TAB ? (s.tabs.at(-1)?.id ?? null) : s.activeId,
    }));
  },

  /** The active chat's id. From Settings (or nothing) it switches to the last chat, or opens a new one. */
  ensureTab(): string {
    const s = store.get();
    if (s.tabs.some((t) => t.id === s.activeId)) return s.activeId!;
    const last = s.tabs.at(-1);
    if (last) chat.setActive(last.id);
    else chat.newTab();
    return store.get().activeId!;
  },

  /** `spoken`: from voice mode, so Harv answers in a few sentences to be read aloud (docs/PLAN.md §6q). */
  send(text: string, attachments: Attachment[] = [], spoken = false) {
    const tabId = chat.ensureTab();
    const voice = spoken ? { spoken: true } : {};
    const { model, effort } = store.get();
    const files = attachments.map((a) => a.name);
    // /btw answers on the side, even mid-reply, and /report writes a note: the server adds the lines, and no turn starts.
    if (/^\/(btw|report)(\s|$)/i.test(text.trim()) && !attachments.length) {
      if (!sendMessage({ type: 'chat.send', tabId, text, model, effort })) offline(tabId);
      else updateTab(tabId, (t) => ({ ...t, stored: true }));
      return;
    }
    // "Start a new chat and …" in a chat that has begun: the server opens the new one (this window
    // switches to it) and this chat goes on, so no line here (docs/PLAN.md §6ac).
    if (!attachments.length && store.get().tabs.find((t) => t.id === tabId)?.stored && newChatTask(text) !== null) {
      movedHere.add(tabId);
      if (!sendMessage({ type: 'chat.send', tabId, text, model, effort, ...voice })) {
        movedHere.delete(tabId);
        offline(tabId);
      }
      return;
    }
    // Harv is still answering: the server queues it (shown above the input) and runs it when the turn ends.
    if (store.get().tabs.find((t) => t.id === tabId)?.busy) {
      if (!sendMessage({ type: 'chat.send', tabId, text, model, effort, ...voice, ...(attachments.length ? { attachments } : {}) }))
        offline(tabId);
      return;
    }
    updateTab(tabId, (t) => ({
      ...t,
      title: t.title === 'New chat' ? titleFrom(text.replace(OVERRIDE_WORDS, '') || text || files[0] || 'Attachment') : t.title,
      stored: true,
      lines: [...t.lines, line('you', text, files.length ? { files } : {})],
    }));
    chat.dispatch(tabId, { type: 'chat.send', tabId, text, model, effort, ...voice, ...(attachments.length ? { attachments } : {}) });
  },

  /**
   * The Yes / No buttons under held steps (the user's report note, 2026-11-18): sends "yes" or "no" as
   * the user's message, flagged so the gate takes it as that answer to every step waiting. Shown only
   * while Harv isn't replying, so it always starts the next turn.
   */
  answerHeld(tabId: string, answer: 'yes' | 'no') {
    const { model, effort } = store.get();
    updateTab(tabId, (t) => ({ ...t, stored: true, lines: [...t.lines, line('you', answer)] }));
    chat.dispatch(tabId, { type: 'chat.send', tabId, text: answer, model, effort, answer });
  },

  /** Runs the tab's last message again one step up the model·effort ladder. */
  harder(tabId: string) {
    updateTab(tabId, (t) => ({ ...t, lines: [...t.lines, line('you', 'Try harder.')] }));
    chat.dispatch(tabId, { type: 'chat.harder', tabId });
  },

  /** Sends a turn, showing Harv thinking right away (AUTO may take a moment to pick a model). */
  dispatch(tabId: string, msg: ClientMessage) {
    if (!sendMessage(msg)) {
      offline(tabId);
      return;
    }
    const pending = line('harv', '', { streaming: true });
    updateTab(tabId, (t) => ({ ...t, ...turnStart(t), busy: true, lines: [...t.lines, pending], currentId: pending.id }));
  },

  /** A line from the dashboard itself (command help, errors); not saved. */
  localNotice(text: string, kind: 'notice' | 'error' = 'notice') {
    const tabId = chat.ensureTab();
    updateTab(tabId, (t) => ({ ...t, lines: [...t.lines, line(kind, text, { local: true })] }));
  },

  /** A note in the chat that's showing, if one is (not saved; Settings stays put). */
  noticeInActive(text: string) {
    const { activeId, tabs } = store.get();
    if (activeId && tabs.some((t) => t.id === activeId))
      updateTab(activeId, (t) => ({ ...t, lines: [...t.lines, line('notice', text, { local: true })] }));
  },

  stop(tabId: string) {
    sendMessage({ type: 'chat.stop', tabId });
  },

  /** Plan mode on or off for a chat (/plan). */
  setPlanning(tabId: string, on: boolean) {
    updateTab(tabId, (t) => ({ ...t, planning: on }));
    if (!sendMessage({ type: 'chat.plan', tabId, on })) offline(tabId);
  },

  /** Rewind to before one of the user's messages (the ⟲ on it), counted from the end so the server finds the same one. */
  rewind(lineId: string) {
    const tab = store.get().tabs.find((t) => t.lines.some((l) => l.id === lineId));
    if (!tab) return;
    const mine = tab.lines.filter((l) => l.kind === 'you');
    const at = mine.findIndex((l) => l.id === lineId);
    if (at !== -1) sendMessage({ type: 'chat.rewind', tabId: tab.id, fromEnd: mine.length - 1 - at });
  },

  /** /rewind: to before the last message. */
  rewindLast(tabId: string) {
    const tab = store.get().tabs.find((t) => t.id === tabId);
    if (!tab?.stored || !tab.lines.some((l) => l.kind === 'you')) return chat.localNotice('Nothing to rewind in this chat yet.');
    sendMessage({ type: 'chat.rewind', tabId, fromEnd: 0 });
  },

  /** Stops one background agent or shell; the reply goes on. */
  stopTask(tabId: string, taskId: string) {
    sendMessage({ type: 'chat.stopTask', tabId, taskId });
  },

  /** Drops a queued message before it runs. */
  unqueue(tabId: string, id: string) {
    sendMessage({ type: 'chat.unqueue', tabId, id });
    updateTab(tabId, (t) => ({ ...t, queued: t.queued?.filter((q) => q.id !== id) }));
  },

  /**
   * Takes a queued message back into the input to edit (like Claude Code): it leaves the
   * queue, its text and files go into the draft, and sending queues it again.
   */
  editQueued(tabId: string, id: string) {
    const item = store
      .get()
      .tabs.find((t) => t.id === tabId)
      ?.queued?.find((q) => q.id === id);
    // One already handed to Claude can't come back (it goes in at the reply's next step).
    if (!item || item.handed) return;
    chat.unqueue(tabId, id);
    setDraftText(tabId, item.text);
    for (const file of item.attachments ?? []) addAttachment(tabId, file);
  },

  /** Runs a queued message now: the current reply stops. */
  sendNow(tabId: string, id: string) {
    sendMessage({ type: 'chat.sendNow', tabId, id });
  },

  /** Activates the chat if it's already a tab, otherwise asks the server to reopen it. */
  openFromHistory(id: string) {
    if (store.get().tabs.some((t) => t.id === id)) chat.setActive(id);
    else if (sendMessage({ type: 'chat.open', tabId: id })) openedHere.add(id);
  },

  /** Renames a chat; Harv stops naming it automatically. */
  rename(tabId: string, raw: string) {
    const title = raw.replace(/\s+/g, ' ').trim();
    if (!title) return;
    updateTab(tabId, (t) => ({ ...t, title }));
    sendMessage({ type: 'chat.rename', tabId, title });
  },

  deleteChat(id: string) {
    sendMessage({ type: 'chat.delete', tabId: id });
  },

  searchHistory(query: string) {
    history.set((h) => ({ ...h, query }));
    sendMessage({ type: 'history.search', query });
  },
};
