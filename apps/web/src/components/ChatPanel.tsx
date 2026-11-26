import { Presence } from './presence/Presence.tsx';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent, type RefObject } from 'react';
import { unknownCommand, unknownCommandText, type PathSuggestion } from '@harv/shared';
import { formatSize, uploadAttachment } from '../lib/attachments.ts';
import { HELP, parseCommand } from '../lib/commands.ts';
import { useCatalog, useSettings } from '../lib/useHarvSocket.ts';
import { chat, getChatState, SETTINGS_TAB, startQuestions, tabTitle, useChat } from '../lib/chatStore.ts';
import { useSafety } from '../lib/safetyStore.ts';
import { groupLines, heldWaiting, isHeld } from '../lib/turns.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { PreviewPane } from './chat/PreviewPane.tsx';
import { usePreviews } from '../lib/preview.ts';
import { SettingsView } from './SettingsView.tsx';
import { BrowserView } from './tools/BrowserView.tsx';
import { StartChoice } from './StartChoice.tsx';
import { StatusLine } from './StatusLine.tsx';
import { TaskStrip } from './TaskStrip.tsx';
import { matchCommands, SlashMenu } from './SlashMenu.tsx';
import { atToken, insideFolder, PathMenu, usePathSuggestions, withoutToken } from './PathMenu.tsx';
import { Icon } from './tools/explorer/icons.tsx';
import { shownView, SpecialTab, TOOL_ICONS, ViewSwitch } from './tools/TabParts.tsx';
import { addReference, setDraftText, updatePending, useDrafts, useDraftTexts } from '../lib/drafts.ts';
import { desktop, inApp, onNativeDrop } from '../lib/desktop.ts';
import { ErrorBoundary, retryImport } from './ErrorBoundary.tsx';
import { TalkButton } from './TalkButton.tsx';
import { NoticeBubble } from './Notices.tsx';

import { ChatLine, FileChip, StepsRow } from './chat/ChatLines.tsx';
import { dropSlot, setTabDragImage } from './chat/tabDrag.ts';
import { STRIP_ACTION, STRIP_BAND, STRIP_GLYPH, STRIP_QUIET, STRIP_ROW } from './strip.ts';
/**
 * ATTACH, RUN and STOP on the desktop: 32 px, lifted 6 px so their middle sits on the middle of the
 * harv> line (the 44 px input's first line), and on its last line when it grows (2026-11-10: 44 px
 * slabs floated between the status line and the prompt). The phone keeps 44 px touch targets.
 */
const BAR_BUTTON = 'mb-1.5 h-8 text-[11px] tracking-wider';

// The terminal (xterm) and the explorer load when first opened, keeping the dashboard's first load small.
const TerminalView = lazy(() => retryImport(() => import('./tools/TerminalView.tsx')).then((m) => ({ default: m.TerminalView })));
const Explorer = lazy(() => retryImport(() => import('./tools/explorer/Explorer.tsx')).then((m) => ({ default: m.Explorer })));

/** An element's width, kept up to date (0 until it's shown). `again` re-attaches when the element is swapped. */
function useWidth(ref: RefObject<HTMLElement | null>, again: unknown): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref, again]);
  return width;
}

/**
 * Yes / No under the steps Harv holds for the user's yes (the user's report note, 2026-11-18): one click
 * answers every step waiting, like typing "yes" or "no"; a reply in their own words still works.
 */
function HeldAnswer({ tabId, count }: { tabId: string; count: number }) {
  if (count === 0) return null;
  return (
    <div className="flex animate-fade-in flex-wrap items-center gap-2 pl-2.5 text-xs" data-held-answer>
      <button
        type="button"
        onClick={() => chat.answerHeld(tabId, 'yes')}
        className="cursor-pointer rounded border border-warn/60 bg-warn/10 px-3 py-0.5 text-warn hover:bg-warn/20"
      >
        {count > 1 ? `Yes to all ${count}` : 'Yes'}
      </button>
      <button
        type="button"
        onClick={() => chat.answerHeld(tabId, 'no')}
        className="cursor-pointer rounded border border-line px-3 py-0.5 text-muted hover:bg-white/5 hover:text-ink"
      >
        No
      </button>
      <span className="text-faint">or answer in your own words</span>
    </div>
  );
}

export function ChatPanel() {
  const { tabs: allTabs, activeId, settingsOpen, views, tools, hydrated } = useChat();
  // Nothing until the saved chats are here: the starter tab only flashed "New chat" before them.
  const tabs = hydrated ? allTabs : [];
  const inSettings = activeId === SETTINGS_TAB;
  const { approvals, desktop: driving, actions } = useSafety();
  const { density, sendKey } = useSettings();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingByTab = useDrafts();
  const draftTexts = useDraftTexts();
  const [dragging, setDragging] = useState(false);
  /** The tab whose name is being edited (right-click or F2 on it). */
  const [renaming, setRenaming] = useState<string | null>(null);
  // Tab being dragged, and where it would land (before or after `id`).
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const renameCancelled = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  /** The active chat's log, or one of its tools (the view menu). */
  const view = active ? shownView(views[active.id]) : 'chat';
  /** Settings or a tool is showing: no chat input or attachments. */
  const nonChat = inSettings || view !== 'chat';
  // The long hints only where they fit on one line: the box's own width, not the window's (side panels take room).
  const inputWidth = useWidth(inputRef, nonChat);
  // Each chat keeps its own unsent text.
  const draft = (active && draftTexts[active.id]) || '';
  const setDraft = (text: string) => setDraftText(active?.id ?? chat.ensureTab(), text);
  const pending = (activeId && pendingByTab[activeId]) || [];
  const uploading = pending.some((p) => !p.file && !p.error);
  const waiting = approvals.filter((a) => a.tabId === activeId);
  const previews = usePreviews();
  const preview = active && view === 'chat' ? previews[active.id] : undefined;
  // "Try harder" sits on the newest reply, once the tab is idle.
  const lastReplyId = active?.lines.findLast((l) => l.kind === 'harv' && l.tag)?.id;
  const lastYouAt = active?.lines.findLast((l) => l.kind === 'you')?.at ?? 0;
  // Cheap (one pass); the lines themselves stay memoized, so typing doesn't re-render them.
  const shown = active ? groupLines(active.lines, active.busy, (ref) => (ref ? actions[ref] : undefined)) : [];
  // Chats from before Harv started continue; a quiet line offers a new session (not while a turn runs in them).
  const asking = startQuestions.use();
  const askHere = !inSettings && view === 'chat' && active && !active.busy && asking.includes(active.id);
  // Typing "/" opens the command list (the dashboard's and Claude Code's); Esc closes it until the text changes.
  const catalog = useCatalog();
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosedAt, setMenuClosedAt] = useState<string | null>(null);
  const menuItems = nonChat || menuClosedAt === draft ? [] : matchCommands(draft, active?.commands ?? catalog?.commands ?? []);
  const menuAt = Math.min(menuIndex, Math.max(menuItems.length - 1, 0));
  // Typing "@" suggests files and folders on the PC (like Claude Code's): picking one attaches it by path.
  const [pathIndex, setPathIndex] = useState(0);
  const [pathClosedAt, setPathClosedAt] = useState<string | null>(null);
  const token = nonChat || menuItems.length > 0 || pathClosedAt === draft ? null : atToken(draft);
  const pathItems = usePathSuggestions(token ? token.query : null);
  const pathAt = Math.min(pathIndex, Math.max(pathItems.length - 1, 0));
  /** Enter (or a click) attaches it; Tab on a folder walks into it instead. */
  const pickPath = (s: PathSuggestion, walk = false) => {
    if (!token) return;
    setPathIndex(0);
    if (walk && s.folder) return setDraft(`${draft.slice(0, token.start)}@${insideFolder(s.path)}`);
    addReference(active?.id ?? chat.ensureTab(), s);
    setDraft(withoutToken(draft, token.start));
    inputRef.current?.focus();
  };
  // ATTACH in the app: the system's own picker for files or folders (by path), or an uploaded copy.
  const [attachMenu, setAttachMenu] = useState(false);
  const pickFromPc = async (folders: boolean) => {
    setAttachMenu(false);
    const picked = await desktop.pickPaths(folders).catch(() => []);
    const tabId = chat.ensureTab();
    for (const p of picked) addReference(tabId, p);
    inputRef.current?.focus();
  };
  const openAttach = () => (inApp ? setAttachMenu((open) => !open) : fileInputRef.current?.click());
  const pickCommand = (name: string) => {
    setDraft(`/${name} `);
    setMenuIndex(0);
    inputRef.current?.focus();
  };

  // Files and folders dragged in from File Explorer arrive from the app by path (the page never sees an
  // OS drop there): in the chat view they're attached like ATTACH › Files…/Folder…; the explorer view copies them in.
  const dropTo = useRef({ tab: active?.id, chatView: !nonChat && view === 'chat' });
  useEffect(() => {
    dropTo.current = { tab: active?.id, chatView: !nonChat && view === 'chat' };
  });
  useEffect(
    () =>
      onNativeDrop(
        (items) => {
          setDragging(false);
          if (!dropTo.current.chatView) return;
          const tabId = dropTo.current.tab ?? chat.ensureTab();
          for (const item of items) addReference(tabId, item);
          inputRef.current?.focus();
        },
        (over) => setDragging(over && dropTo.current.chatView),
      ),
    [],
  );

  // ↑/↓ through this chat's earlier messages, like Claude Code: `at` counts back from the newest
  // (-1 = what was being typed, kept in `saved`).
  const recall = useRef({ tab: '', at: -1, saved: '' });
  const lastEsc = useRef(0);
  const recallStep = (older: boolean): boolean => {
    if (!active) return false;
    const sent = active.lines.filter((l) => l.kind === 'you' && l.text.trim()).map((l) => l.text);
    const r = recall.current.tab === active.id ? recall.current : { tab: active.id, at: -1, saved: '' };
    const at = r.at + (older ? 1 : -1);
    if (at >= sent.length || at < -1 || (!older && r.at === -1)) return false;
    recall.current = { tab: active.id, at, saved: r.at === -1 ? draft : r.saved };
    const text = at === -1 ? recall.current.saved : sent[sent.length - 1 - at]!;
    setDraft(text);
    // The caret at the end, so the next ↑ goes on from the first line of a long message only after moving up through it.
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(text.length, text.length));
    return true;
  };

  // Esc closes the ATTACH menu wherever the focus is (it closed only on blur, and Esc-to-stop waits while
  // a menu is open, so Esc did nothing at all: the full review, U14). The next Esc stops the reply.
  useEffect(() => {
    if (!attachMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setAttachMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attachMenu]);

  // Esc is the stop hotkey: it halts the active tab and denies its waiting cards (format_drive, a question, a plan).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Files and Browser too (the full review, U4); in the terminal Esc belongs to the terminal (its STOP stays below).
      if (e.key !== 'Escape' || !active?.busy || inSettings || view === 'terminal') return;
      // Esc that closes a menu, a dialog or a rename belongs to them.
      if (document.querySelector('[role="menu"], [role="dialog"]') || (e.target as HTMLElement).closest?.('[role="tablist"] input')) return;
      e.preventDefault();
      chat.stop(active.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active?.busy, active?.id, view, inSettings]);

  const attach = (files: Iterable<File>) => {
    const tabId = chat.ensureTab();
    for (const file of files) {
      const key = crypto.randomUUID();
      updatePending(tabId, (list) => [...list, { key, name: file.name || 'pasted-image.png', size: file.size }]);
      uploadAttachment(tabId, file).then(
        (uploaded) => updatePending(tabId, (list) => list.map((p) => (p.key === key ? { ...p, file: uploaded } : p))),
        (err: Error) => updatePending(tabId, (list) => list.map((p) => (p.key === key ? { ...p, error: err.message } : p))),
      );
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // A dropped folder has no path the page can see (browsers and the app's web view hide it), so it can't come this way.
    const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    const folders = items.filter((i) => i.webkitGetAsEntry?.()?.isDirectory);
    const dropped = items.filter((i) => !folders.includes(i)).flatMap((i) => i.getAsFile() ?? []);
    if (folders.length)
      chat.localNotice(
        inApp
          ? 'Folders can’t be dropped (only copies of files can). Use + ATTACH › Folder…, type @ and the path, or Send to chat in the file explorer.'
          : 'Folders can’t be dropped. Type @ and the path, or use Send to chat in the file explorer.',
      );
    if (dropped.length) attach(dropped);
  };

  // How many tabs are scrolled out of sight on each side: the bar shows "‹ 3" / "2 ›" so they aren't lost
  // (the 2026-11-09 UI pass: with 19 tabs the user's real chats slid off the left with no hint).
  const [hidden, setHidden] = useState({ left: 0, right: 0 });
  useEffect(() => {
    const bar = tabsRef.current;
    if (!bar) return;
    const count = () => {
      const box = bar.getBoundingClientRect();
      let left = 0;
      let right = 0;
      for (const tab of bar.querySelectorAll<HTMLElement>('[data-tab]')) {
        const r = tab.getBoundingClientRect();
        if (r.right <= box.left + 12) left++;
        else if (r.left >= box.right - 12) right++;
      }
      setHidden((was) => (was.left === left && was.right === right ? was : { left, right }));
    };
    count();
    bar.addEventListener('scroll', count, { passive: true });
    const watch = new ResizeObserver(count);
    watch.observe(bar);
    return () => {
      bar.removeEventListener('scroll', count);
      watch.disconnect();
    };
  }, [tabs.length, settingsOpen]);
  const scrollTabs = (dir: -1 | 1) => {
    const bar = tabsRef.current;
    if (bar) bar.scrollBy({ left: dir * bar.clientWidth * 0.8, behavior: 'smooth' });
  };

  // The active tab scrolls into view in the tab bar (by hand: scrollIntoView would also scroll the page),
  // also when the bar gets narrower (a smaller window, a side panel opening), or it slid out of sight.
  useEffect(() => {
    const bar = tabsRef.current;
    if (!bar) return;
    const show = () => {
      const tab = bar.querySelector<HTMLElement>(`[data-tab="${activeId}"]`);
      if (!tab) return;
      const left = tab.offsetLeft - bar.offsetLeft;
      if (left < bar.scrollLeft) bar.scrollLeft = left - 8;
      else if (left + tab.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = left + tab.offsetWidth - bar.clientWidth + 8;
    };
    show();
    const watch = new ResizeObserver(show);
    watch.observe(bar);
    return () => watch.disconnect();
  }, [activeId, tabs.length, settingsOpen]);

  // Opening or switching to a chat puts the cursor in its command line, ready to type (the user's wish).
  // Not while a tab is being renamed.
  useEffect(() => {
    if (nonChat || renaming) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [activeId, nonChat, renaming]);

  // The desktop app's hotkey brings Harv up with the cursor in the command line.
  useEffect(() => {
    const onFocus = () => !nonChat && inputRef.current?.focus({ preventScroll: true });
    window.addEventListener('harv-focus', onFocus);
    return () => window.removeEventListener('harv-focus', onFocus);
  }, [nonChat]);

  // Keep the newest output in view while Harv streams, unless the user scrolled up to read (the user's wish):
  // then it stays put until they scroll back down, press ↓ or send something.
  const lastLine = active?.lines.at(-1);
  const lastText = lastLine?.text;
  const stuck = useRef(true);
  /** The chat whose log is scrolled up (it shows the ↓ button); its scroll event keeps this right. */
  const [scrolledUp, setScrolledUp] = useState<string | null>(null);
  const toBottom = () => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuck.current = true;
  };
  /** When the log last changed size: the scroll events a resize causes aren't the user scrolling up. */
  const resizedAt = useRef(0);
  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    if (performance.now() - resizedAt.current < 250) {
      if (stuck.current) el.scrollTop = el.scrollHeight;
      return;
    }
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setScrolledUp(stuck.current ? null : activeId);
  };
  // A window resize (maximize, snap, the stacked layout below 1024 px and back) reflows the log: one that
  // showed the newest output keeps showing it, instead of ending up hundreds of pixels up or at the top.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const watch = new ResizeObserver(() => {
      resizedAt.current = performance.now();
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [nonChat, activeId, hydrated]);
  useLayoutEffect(() => {
    toBottom();
  }, [activeId, hydrated]);
  useEffect(() => {
    if (lastLine?.kind === 'you') stuck.current = true;
    if (stuck.current) toBottom();
  }, [active?.lines.length, lastText, waiting.length, lastLine?.kind]);

  // The message box grows with what's typed (up to its max height).
  // Measured again when its width changes: a draft that came in while the window was hidden (the phone
  // typing) was measured at zero width, every letter on its own line.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || el.clientWidth === 0) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    el.style.overflowY = el.scrollHeight > el.clientHeight ? 'auto' : 'hidden';
  }, [draft, nonChat, inputWidth]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    const ready = pending.flatMap((p) => (p.file ? [p.file] : []));
    const command = ready.length === 0 ? parseCommand(text) : null;
    if (command) {
      setDraft('');
      if (command.kind === 'attach') openAttach();
      else if (command.kind === 'new') chat.newTab();
      else if (command.kind === 'help') chat.localNotice(HELP);
      else if (command.kind === 'plan') chat.setPlanning(chat.ensureTab(), command.on ?? !active?.planning);
      else if (command.kind === 'rewind') chat.rewindLast(chat.ensureTab());
      else if (command.kind === 'error') chat.localNotice(command.message, 'error');
      else {
        if (command.model) chat.setModel(command.model);
        if (command.effort) chat.setEffort(command.effort);
        const { model, effort } = getChatState();
        chat.localNotice(model === 'auto' ? 'Model: AUTO (Harv picks model and effort).' : `Model: ${model} · ${effort}.`);
      }
      return;
    }
    // A mistyped /word: the text stays in the box, with the nearest command (the user's wish, 2026-11-09).
    const typo = unknownCommand(
      text,
      [...(catalog?.commands ?? []), ...(active?.commands ?? [])].map((c) => c.name),
    );
    if (typo) {
      chat.localNotice(unknownCommandText(typo), 'error');
      return;
    }
    // While Harv answers, a message waits its turn (queued on the server, shown above the input).
    if ((!text && ready.length === 0) || uploading) return;
    chat.send(text, ready);
    setDraft('');
    if (activeId) updatePending(activeId, () => []);
  };

  return (
    <section
      aria-label="Chat"
      onDragOver={(e) => {
        // The explorer takes its own drops (copying files into the folder).
        if (nonChat || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => !nonChat && onDrop(e)}
      className={`glass relative flex min-w-0 flex-col overflow-hidden ${
        // Below lg the page is a column of unknown height: flex-1 there made the chat as tall as the whole
        // conversation and put harv> out of reach (pass B, B1), so it keeps its own height.
        'rounded-2xl h-[calc(var(--app-h)-162px)] min-h-[300px] flex-none lg:h-auto lg:max-h-[calc(var(--app-h)-109px)] lg:min-h-0 lg:flex-1'
      }`}
    >
      {/* The whole bar takes a dragged tab: gaps, the space past the last tab and the + too (the nearest slot wins). */}
      <div
        onDragOver={(e) => {
          if (!dragTab || !e.dataTransfer.types.includes('application/x-harv-tab')) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          const bar = tabsRef.current;
          if (!bar) return;
          // Near either end of an overflowing bar, scroll it along.
          const box = bar.getBoundingClientRect();
          if (e.clientX < box.left + 24) bar.scrollLeft -= 12;
          else if (e.clientX > box.right - 24) bar.scrollLeft += 12;
          const next = dropSlot(bar, e.clientX);
          if (next && (dropAt?.id !== next.id || dropAt.after !== next.after)) setDropAt(next);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData('application/x-harv-tab');
          if (!id) return;
          e.preventDefault();
          e.stopPropagation();
          const slot = tabsRef.current ? dropSlot(tabsRef.current, e.clientX) : null;
          if (slot) chat.moveTab(id, slot.id, slot.after);
          setDragTab(null);
          setDropAt(null);
        }}
        // A container: what shows beside the tabs follows the bar's own room, not the window's (at 130 % with the stats
        // panel open, the window was "wide" while the bar left the open tab only "…", 2026-11-10).
        className="@container/bar flex items-end gap-1 border-b border-line px-2 pt-2"
      >
        {/* Tabs shrink like Chrome's, then scroll sideways (mouse wheel too); + and the view menu stay put. */}
        {hidden.left > 0 && (
          <button
            type="button"
            onClick={() => scrollTabs(-1)}
            title={`${hidden.left} more tab${hidden.left === 1 ? '' : 's'} to the left`}
            className="mb-1 min-h-7 flex-none cursor-pointer rounded-md px-1.5 text-[11px] text-accent hover:bg-white/10"
          >
            ‹ {hidden.left}
          </button>
        )}
        <div
          ref={tabsRef}
          role="tablist"
          aria-label="Open chats"
          onWheel={(e) => {
            if (e.deltaY && e.currentTarget.scrollWidth > e.currentTarget.clientWidth) e.currentTarget.scrollLeft += e.deltaY;
          }}
          className="no-scrollbar flex min-w-0 flex-[0_1_auto] items-end gap-1 overflow-x-auto"
        >
          {tabs.map((t) => {
            const on = t.id === activeId;
            const title = tabTitle(t, views[t.id], tools[t.id]);
            return (
              <div
                key={t.id}
                data-tab={t.id}
                draggable={renaming !== t.id}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-harv-tab', t.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setTabDragImage(e, title);
                  setDragTab(t.id);
                }}
                onDragEnd={() => {
                  setDragTab(null);
                  setDropAt(null);
                }}
                className={`group/tab animate-fade-in relative flex w-[200px] max-w-[200px] min-w-[110px] flex-[0_1_200px] items-center gap-0.5 rounded-t-[10px] border border-b-0 ${
                  on ? 'border-[rgb(220_232_245/0.18)] bg-white/10' : 'border-transparent'
                } ${dragTab === t.id ? 'opacity-40' : ''} ${
                  dragTab && dragTab !== t.id && dropAt?.id === t.id
                    ? dropAt.after
                      ? 'shadow-[2px_0_0_0_var(--color-accent)]'
                      : 'shadow-[-2px_0_0_0_var(--color-accent)]'
                    : ''
                }`}
              >
                {renaming === t.id ? (
                  <input
                    aria-label="Chat name"
                    autoFocus
                    defaultValue={title}
                    maxLength={60}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        renameCancelled.current = true;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => {
                      // Enter and clicking away save; Escape doesn't.
                      const name = e.target.value.trim();
                      if (!renameCancelled.current && name && name !== t.title) chat.rename(t.id, name);
                      renameCancelled.current = false;
                      setRenaming(null);
                    }}
                    className="my-1 ml-1.5 min-h-7 w-[150px] rounded-md border border-accent/60 bg-black/30 px-1.5 text-xs text-ink outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    title={`${title} · right-click to rename`}
                    onClick={() => chat.setActive(t.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setRenaming(t.id);
                    }}
                    onKeyDown={(e) => {
                      // F2 renames too, for the keyboard.
                      if (e.key === 'F2') setRenaming(t.id);
                    }}
                    // The × floats over the name's end (the name fades under it) instead of pushing it: the
                    // names jumped as the mouse ran across the tabs (the user, 2026-11-13).
                    className={`flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-1.5 truncate pl-3 text-xs ${
                      on
                        ? 'pr-9 text-ink'
                        : 'pr-1 text-muted group-focus-within/tab:[mask-image:linear-gradient(to_left,transparent_30px,black_46px)] group-hover/tab:[mask-image:linear-gradient(to_left,transparent_30px,black_46px)]'
                    }`}
                  >
                    {/* One mark per tab, the most important one, so a narrow tab keeps room for its name. */}
                    {approvals.some((a) => a.tabId === t.id) || (!t.busy && heldWaiting(t.lines) > 0) ? (
                      <span title="Needs your answer" className="flex-none font-semibold text-warn">
                        !
                      </span>
                    ) : driving?.tabId === t.id && t.busy ? (
                      <span title="Using your mouse and keyboard" className="animate-blink flex-none text-accent">
                        ⌖
                      </span>
                    ) : t.busy ? (
                      <span aria-hidden="true" className="animate-blink size-1.5 flex-none rounded-full bg-accent" />
                    ) : shownView(views[t.id]) !== 'chat' ? (
                      <span aria-hidden="true" className="flex flex-none text-accent">
                        {TOOL_ICONS[shownView(views[t.id])]}
                      </span>
                    ) : (
                      t.projectId && (
                        <span aria-hidden="true" title="Project chat" className="flex-none text-accent">
                          ▣
                        </span>
                      )
                    )}
                    <span className="truncate">{title}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => chat.closeTab(t.id)}
                  aria-label={`Close ${title}`}
                  // × on the active tab and on hover only, like Chrome's narrow tabs: the name gets the room (pass B, B2).
                  className={`absolute top-1/2 right-1 size-7 -translate-y-1/2 cursor-pointer rounded-md text-[13px] text-muted hover:bg-white/10 ${
                    on ? '' : 'hidden group-focus-within/tab:block group-hover/tab:block'
                  }`}
                >
                  <Icon name="close" size={12} className="mx-auto block" />
                </button>
              </div>
            );
          })}
          {settingsOpen && (
            <SpecialTab
              id={SETTINGS_TAB}
              icon={TOOL_ICONS.settings}
              title="Settings"
              active={inSettings}
              onSelect={chat.openSettings}
              onClose={chat.closeSettings}
            />
          )}
        </div>
        {hidden.right > 0 && (
          <button
            type="button"
            onClick={() => scrollTabs(1)}
            title={`${hidden.right} more tab${hidden.right === 1 ? '' : 's'} to the right`}
            className="mb-1 min-h-7 flex-none cursor-pointer rounded-md px-1.5 text-[11px] text-accent hover:bg-white/10"
          >
            {hidden.right} ›
          </button>
        )}
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={() => chat.newTab()}
          // Drawn, at an even size: the "+" character sat 0.75 px low (the 2026-11-10 centring check).
          className="grid size-9 flex-none cursor-pointer place-items-center hover:text-accent"
        >
          <Icon name="plus" size={14} />
        </button>
        <div className="flex-1" />
        {active && <ViewSwitch tabId={active.id} />}
      </div>

      {/* Everything under the tab bar, so a chat's start question covers only this part. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Harv's notices: a bubble under his face when the hammock shows, else near the top (docs/PLAN.md §6ad). */}
        <NoticeBubble />
        {/* A chat showing its files or terminal still shows what it waits for (hidden, the turn just hung). */}
        {!inSettings && view !== 'chat' && waiting.length > 0 && (
          <div className="flex max-h-[60%] flex-none flex-col gap-2 overflow-y-auto border-b border-line p-3">
            {waiting.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        )}
        {inSettings ? (
          <div className="@container flex flex-1 flex-col overflow-y-auto px-5 py-4">
            <SettingsView />
          </div>
        ) : active && view === 'browser' ? (
          <BrowserView />
        ) : active && view === 'terminal' ? (
          <ErrorBoundary key={`t-${active.id}`} label="terminal">
            <Suspense fallback={<p className="m-auto text-muted">Starting the terminal…</p>}>
              <TerminalView key={active.id} chatId={active.id} />
            </Suspense>
          </ErrorBoundary>
        ) : active && view === 'files' ? (
          <ErrorBoundary key={`e-${active.id}`} label="file explorer">
            <Suspense fallback={<p className="m-auto text-muted">Opening the explorer…</p>}>
              <Explorer key={active.id} id={active.id} />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <div className={`relative flex min-h-0 flex-1 ${preview ? 'flex-col gap-2 pb-2 lg:flex-row lg:pr-2' : ''}`}>
            {/* Harv presence: his face and moons hanging from the top edge while he works (pass C, C1). */}
            {active && <Presence key={active.id} tab={active} />}
            {scrolledUp !== null && scrolledUp === activeId && (
              <button
                type="button"
                onClick={toBottom}
                title="Back to the newest output"
                className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full border border-accent/50 bg-[rgb(16_24_34/0.9)] px-3 py-1 text-[11px] text-accent hover:bg-accent/15"
              >
                ↓ {active?.busy ? 'live' : 'newest'}
              </button>
            )}
            <div
              ref={logRef}
              onScroll={onLogScroll}
              className={`harv-log flex min-w-0 flex-1 flex-col overflow-y-auto px-5 ${preview ? 'max-lg:max-h-[45%] lg:max-w-[50%]' : ''} ${density === 'compact' ? 'gap-1.5 py-3 leading-normal' : 'gap-3.5 py-4 leading-relaxed'}`}
            >
              {!hydrated ? null : !active || active.lines.length === 0 ? (
                <p className="m-auto text-center text-muted">
                  {active ? 'New chat. Ask Harv anything.' : 'No chat open. Press + to start one.'}
                  {/* The keys, where a new user looks (pass B, B15); the phone has no keyboard shortcuts. */}
                  {active && (
                    <span className="mt-3 block text-[11px] leading-6 text-faint">
                      / commands · @ a file or folder · drop files here · Shift+Tab plan first
                    </span>
                  )}
                </p>
              ) : (
                shown.map((s) =>
                  s.kind === 'steps' ? (
                    <StepsRow key={s.id} lines={s.lines} seconds={s.seconds} />
                  ) : (
                    <ChatLine
                      key={s.line.id}
                      line={s.line}
                      head={s.head}
                      waits={isHeld(s.line) && s.line.at > lastYouAt}
                      onHarder={!active.busy && s.line.id === lastReplyId ? () => chat.harder(active.id) : undefined}
                    />
                  ),
                )
              )}
              {active && hydrated && !active.busy && <HeldAnswer tabId={active.id} count={heldWaiting(active.lines)} />}
              {waiting.map((a) => (
                <ApprovalCard key={a.id} approval={a} />
              ))}
            </div>
            {active && preview && <PreviewPane tabId={active.id} preview={preview} />}
          </div>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-[rgb(10_16_24/0.7)] text-accent">
            drop files to attach
          </div>
        )}

        {!nonChat && active?.queued && active.queued.length > 0 && (
          // The same band and rows as everything else above the command line (strip.ts), so it lines up with them.
          <div aria-label="Queued messages" className={`${STRIP_BAND} flex flex-col`}>
            {active.queued.map((q) =>
              q.handed ? (
                // Already with Claude: it reads it after the step it's on, so it can't be edited or removed now.
                <div
                  key={q.id}
                  className={STRIP_ROW}
                  title="Already with Harv: he reads it after the step he's on, so it can't be edited or removed any more"
                >
                  <span aria-hidden="true" className={`${STRIP_GLYPH} text-accent`}>
                    ›
                  </span>
                  <span className="w-16 flex-none text-accent">with Harv</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{q.text || q.files?.join(', ')}</span>
                </div>
              ) : (
                <div key={q.id} className={STRIP_ROW}>
                  <span aria-hidden="true" className={`${STRIP_GLYPH} text-faint`}>
                    ›
                  </span>
                  <span className="w-16 flex-none text-faint" title="Harv reads it at his next step">
                    queued
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      chat.editQueued(active.id, q.id);
                      inputRef.current?.focus();
                    }}
                    title="Edit: takes it back into the input (↑ in an empty input does too)"
                    className="h-6 min-w-0 flex-1 cursor-pointer truncate rounded text-left leading-6 text-muted hover:text-ink"
                  >
                    {q.text || q.files?.join(', ')}
                  </button>
                  <button
                    type="button"
                    onClick={() => chat.sendNow(active.id, q.id)}
                    title="Stop the current reply and send this now"
                    className={`${STRIP_ACTION} border border-accent/50 text-accent hover:bg-accent/15`}
                  >
                    send now
                  </button>
                  <button
                    type="button"
                    onClick={() => chat.unqueue(active.id, q.id)}
                    aria-label="Remove queued message"
                    title="Remove"
                    className={`${STRIP_ACTION} ${STRIP_QUIET}`}
                  >
                    <Icon name="close" size={12} className="block" />
                  </button>
                </div>
              ),
            )}
          </div>
        )}

        {!nonChat && pending.length > 0 && (
          // Even space above and below: the chips sat on the status line's divider (2026-11-10).
          <div className="flex flex-wrap gap-1.5 border-t border-line py-2 pr-3 pl-5">
            {pending.map((p) => (
              <FileChip
                key={p.key}
                name={p.name}
                path={p.file?.path}
                folder={p.file?.folder}
                detail={
                  p.error
                    ? `! ${p.error}`
                    : p.file?.path
                      ? p.file.folder
                        ? undefined
                        : p.size
                          ? formatSize(p.size)
                          : undefined
                      : p.file
                        ? formatSize(p.size)
                        : 'uploading…'
                }
                onRemove={() => activeId && updatePending(activeId, (list) => list.filter((x) => x.key !== p.key))}
              />
            ))}
          </div>
        )}

        {!nonChat && <TaskStrip tab={active ?? undefined} />}
        {!nonChat && <StatusLine tab={active ?? undefined}>{askHere && <StartChoice key={active.id} tabId={active.id} />}</StatusLine>}
        {/* A busy chat showing Files, Terminal or Browser keeps its status and a STOP (the full review, U4:
            terminal_run switches the view by itself, right when Harv acts). */}
        {nonChat && !inSettings && active?.busy && (
          <StatusLine tab={active}>
            <button
              type="button"
              onClick={() => chat.stop(active.id)}
              title={view === 'terminal' ? 'Stop Harv' : 'Stop Harv (Esc)'}
              aria-label="Stop"
              className="flex h-5 flex-none cursor-pointer items-center rounded-md bg-warn px-2 text-[11px] leading-none font-semibold text-[#0f1620]"
            >
              STOP ■
            </button>
          </StatusLine>
        )}
        {!nonChat && active?.planning && (
          <div className={`${STRIP_BAND} ${STRIP_ROW} box-content text-accent`}>
            <span aria-hidden="true" className={STRIP_GLYPH}>
              ◇
            </span>
            <span className="flex-none">plan mode</span>
            <span className="min-w-0 truncate text-faint">Harv only reads and plans, then shows you the plan to approve</span>
            <button
              type="button"
              onClick={() => chat.setPlanning(active.id, false)}
              className={`${STRIP_ACTION} ml-auto text-muted hover:bg-white/10 hover:text-accent`}
            >
              turn off
            </button>
          </div>
        )}

        {!nonChat && (
          <form
            onSubmit={send}
            // The phone's line is narrow: small gaps and buttons, so the text gets the room.
            className={`relative flex items-end gap-2.5 pt-1 pr-3 pb-2.5 pl-5`}
          >
            {menuItems.length > 0 && <SlashMenu items={menuItems} index={menuAt} onPick={(c) => pickCommand(c.name)} />}
            {pathItems.length > 0 && <PathMenu items={pathItems} index={pathAt} onPick={(p) => pickPath(p)} />}
            <label htmlFor="harv-cmd" className="self-start pt-3 leading-5 font-semibold text-accent">
              {'harv>'}
            </label>
            <textarea
              ref={inputRef}
              id="harv-cmd"
              rows={1}
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (menuItems.length > 0 && !e.nativeEvent.isComposing) {
                  const typed = draft.slice(1).toLowerCase();
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMenuIndex((menuAt + (e.key === 'ArrowDown' ? 1 : menuItems.length - 1)) % menuItems.length);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuClosedAt(draft);
                    return;
                  }
                  // Tab, or Enter on a name not fully typed yet, completes it; Enter on a full name sends it.
                  if (e.key === 'Tab' || (e.key === 'Enter' && menuItems[menuAt]!.name.toLowerCase() !== typed)) {
                    e.preventDefault();
                    pickCommand(menuItems[menuAt]!.name);
                    return;
                  }
                }
                if (pathItems.length > 0 && !e.nativeEvent.isComposing) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    setPathIndex((pathAt + (e.key === 'ArrowDown' ? 1 : pathItems.length - 1)) % pathItems.length);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setPathClosedAt(draft);
                    return;
                  }
                  if (e.key === 'Tab' || e.key === 'Enter') {
                    e.preventDefault();
                    pickPath(pathItems[pathAt]!, e.key === 'Tab');
                    return;
                  }
                }
                // ↑ in an empty input takes the newest queued message back to edit.
                const editable = active?.queued?.filter((q) => !q.handed) ?? [];
                if (e.key === 'ArrowUp' && !draft && pending.length === 0 && active && editable.length) {
                  e.preventDefault();
                  chat.editQueued(active.id, editable.at(-1)!.id);
                  return;
                }
                // Claude Code's keys (the user's wish, 2026-11-10): ↑/↓ on the first/last line walk through
                // this chat's earlier messages, Esc Esc clears the line, Shift+Tab turns plan mode on or off.
                if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && active) {
                  const el = e.currentTarget;
                  const up = e.key === 'ArrowUp';
                  const edge = up ? !el.value.slice(0, el.selectionStart).includes('\n') : !el.value.slice(el.selectionEnd).includes('\n');
                  if (edge && recallStep(up)) {
                    e.preventDefault();
                    return;
                  }
                }
                if (e.key === 'Escape' && !active?.busy && draft) {
                  const now = Date.now();
                  if (now - lastEsc.current < 800) {
                    setDraft('');
                    recall.current = { tab: '', at: -1, saved: '' };
                    lastEsc.current = 0;
                  } else lastEsc.current = now;
                  return;
                }
                if (e.key === 'Tab' && e.shiftKey && active) {
                  e.preventDefault();
                  chat.setPlanning(active.id, !active.planning);
                  return;
                }
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                // Settings › Chat: Enter sends (Shift+Enter = new line), or Ctrl+Enter sends (Enter = new line).
                const sends = sendKey === 'enter' ? !e.shiftKey : e.ctrlKey;
                if (!sends) return;
                e.preventDefault();
                recall.current = { tab: '', at: -1, saved: '' };
                e.currentTarget.form?.requestSubmit();
              }}
              onPaste={(e) => {
                // Pasted screenshots arrive as files.
                if (e.clipboardData.files.length === 0) return;
                e.preventDefault();
                attach(e.clipboardData.files);
              }}
              placeholder={
                active?.busy
                  ? inputWidth >= 400
                    ? 'next message · Harv reads it at his next step'
                    : 'next message'
                  : inputWidth >= 270
                    ? 'ask anything · / for commands'
                    : 'ask anything'
              }
              title={`${sendKey === 'enter' ? 'Enter sends, Shift+Enter' : 'Ctrl+Enter sends, Enter'} makes a new line. ↑/↓ earlier messages, Esc stops a reply, Esc Esc clears the line, Shift+Tab plan mode. /help lists the commands.`}
              className="max-h-40 min-h-11 min-w-0 flex-1 resize-none overflow-y-hidden bg-transparent py-3 text-sm leading-5 outline-none placeholder:text-faint"
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) attach(e.target.files);
                e.target.value = '';
              }}
            />
            <div className="relative">
              {attachMenu && (
                <div
                  role="menu"
                  aria-label="Attach"
                  className="absolute right-0 bottom-full z-30 mb-1 flex w-56 flex-col rounded-xl border border-[rgb(220_232_245/0.18)] bg-[rgb(16_24_34/0.96)] py-1 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.4)]"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void pickFromPc(false)}
                    className="cursor-pointer px-3 py-1.5 text-left hover:bg-white/10"
                  >
                    Files…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void pickFromPc(true)}
                    className="cursor-pointer px-3 py-1.5 text-left hover:bg-white/10"
                  >
                    Folder…
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={openAttach}
                onBlur={(e) => {
                  if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) setAttachMenu(false);
                }}
                aria-label="Attach"
                aria-expanded={inApp ? attachMenu : undefined}
                title={
                  inApp
                    ? 'Attach files or folders (or type @ in the line)'
                    : 'Attach files (or drop them on the chat, or paste a screenshot); type @ to point Harv at a file or folder by path'
                }
                className={`cursor-pointer rounded-[10px] border border-[rgb(220_232_245/0.2)] hover:bg-white/10 ${`${BAR_BUTTON} px-3 text-muted hover:text-ink`}`}
              >
                +<span className="hidden sm:inline"> ATTACH</span>
              </button>
            </div>
            <TalkButton className={BAR_BUTTON} />
            {active?.busy && draft.trim() && (
              // While Harv answers, a mouse can queue too (pass B, B9); Enter does the same.
              <button
                type="submit"
                disabled={uploading}
                aria-label="Queue"
                title="Harv reads it at his next step"
                className={`cursor-pointer rounded-[10px] border border-accent/60 font-semibold text-accent hover:bg-accent/15 ${`${BAR_BUTTON} px-3`}`}
              >
                {'QUEUE ⏎'}
              </button>
            )}
            {active?.busy ? (
              <button
                type="button"
                onClick={() => chat.stop(active.id)}
                title="Stop (Esc)"
                aria-label="Stop"
                className={`cursor-pointer rounded-[10px] bg-warn font-semibold text-[#0f1620] ${`${BAR_BUTTON} px-3.5`}`}
              >
                {'STOP ■'}
              </button>
            ) : (
              <button
                type="submit"
                disabled={uploading}
                aria-label="Send"
                className={`cursor-pointer rounded-[10px] bg-accent font-semibold text-[#0f1620] disabled:cursor-wait disabled:opacity-60 ${`${BAR_BUTTON} px-3.5`}`}
              >
                {'RUN ⏎'}
              </button>
            )}
          </form>
        )}
      </div>
    </section>
  );
}
