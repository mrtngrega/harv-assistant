import { type ReactNode } from 'react';
import type { ChatView, ToolKind } from '@harv/shared';
import { chat, useChat } from '../../lib/chatStore.ts';
import { inApp } from '../../lib/desktop.ts';
import { Rollout } from '../Rollout.tsx';
import { Icon } from './explorer/icons.tsx';

// Drawn icons, not text symbols: those came from different fonts on each computer (the notebook's
// ◍ was bold and sat high, 2026-11-10).
export const TOOL_ICONS: Record<ChatView | 'settings', ReactNode> = {
  chat: <Icon name="chat" size={14} />,
  terminal: <Icon name="terminal" size={14} />,
  files: <Icon name="folder" size={14} />,
  settings: <Icon name="gear" size={12} />,
  browser: <Icon name="globe" size={14} />,
};


/** A non-chat tab in the chat bar (Settings). */
export function SpecialTab({
  id,
  icon,
  title,
  active,
  onSelect,
  onClose,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      data-tab={id}
      className={`animate-fade-in flex flex-none items-center gap-0.5 rounded-t-[10px] border border-b-0 ${
        active ? 'border-[rgb(220_232_245/0.18)] bg-white/10' : 'border-transparent'
      }`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        className={`flex min-h-9 cursor-pointer items-center gap-1.5 truncate pr-1 pl-3 text-xs whitespace-nowrap ${active ? 'text-ink' : 'text-muted'}`}
      >
        <span aria-hidden="true" className="flex text-accent">
          {icon}
        </span>
        <span className="truncate">{title}</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${title}`}
        className="mr-1 size-7 flex-none cursor-pointer rounded-md text-[13px] text-muted hover:bg-white/10"
      >
        <Icon name="close" size={12} className="mx-auto block" />
      </button>
    </div>
  );
}

const VIEWS: { view: ChatView; label: string; short: string }[] = [
  { view: 'chat', label: 'Chat', short: 'chat' },
  { view: 'files', label: 'File Explorer', short: 'files' },
  { view: 'terminal', label: 'Terminal', short: 'terminal' },
  // One browser for every chat (docs/PLAN.md §6x), only in the app (it's the app's own web views).
  ...(inApp ? [{ view: 'browser' as const, label: 'Browser', short: 'browser' }] : []),
];

/**
 * What a chat shows here. The layout is shared by every window, and the browser exists only in the
 * app: a chat the app shows in its browser shows its log in a browser or on the phone.
 */
export function shownView(view: ChatView | undefined): ChatView {
  return !view || (view === 'browser' && !inApp) ? 'chat' : view;
}

/**
 * The chat bar's view switch: the chat's log and its tools side by side, always visible (the critique,
 * 2026-11-09: behind "≡ chat ▾" nobody found them). Labels show on wide windows, icons always.
 */
export function ViewSwitch({ tabId }: { tabId: string }) {
  const { views, tools } = useChat();
  const view = shownView(views[tabId]);
  const open = tools[tabId] ?? [];
  const now = VIEWS.find((v) => v.view === view) ?? VIEWS[0]!;
  const others = open.filter((k) => k !== view).length;
  // Folded to what the chat shows; rolls out on hover over the tabs, which don't move (the user's wish, 2026-11-14).
  return (
    <div className="mb-1.5 flex flex-none">
      <Rollout
        label="Show in this chat"
        folded={
          <span className="flex min-h-8 items-center gap-1.5 rounded-lg border border-transparent bg-black/20 p-0.5">
            <span className="flex min-h-7 items-center gap-1.5 rounded-md bg-white/10 px-1.5 text-[11px] whitespace-nowrap text-ink">
              <span className="flex text-accent">{TOOL_ICONS[now.view]}</span>
              <span className="hidden @5xl/bar:inline">{now.short}</span>
            </span>
            {others > 0 && <span className="text-[10px] text-accent">+{others}</span>}
            <span className="pr-1 text-[10px] text-muted">‹</span>
          </span>
        }
      >
        <ViewRow tabId={tabId} view={view} open={open} />
      </Rollout>
    </div>
  );
}

function ViewRow({ tabId, view, open }: { tabId: string; view: ChatView; open: ToolKind[] }) {
  return (
    <div
      role="radiogroup"
      aria-label="Show in this chat"
      className="flex flex-none items-center gap-0.5 rounded-lg border border-[rgb(220_232_245/0.12)] bg-[rgb(16_24_34/0.92)] p-0.5 shadow-lg backdrop-blur-md"
    >
      {VIEWS.map((item) => {
        const running = item.view !== 'chat' && open.includes(item.view);
        return (
          <span key={item.view} className="group/view relative flex">
            <button
              type="button"
              role="radio"
              aria-checked={view === item.view}
              aria-label={item.label}
              title={item.label}
              onClick={() => chat.setView(tabId, item.view)}
              className={`flex min-h-7 min-w-7 cursor-pointer items-center justify-center gap-1.5 rounded-md px-1.5 text-[11px] whitespace-nowrap ${
                view === item.view ? 'bg-white/10 text-ink' : 'text-muted hover:bg-white/5 hover:text-ink'
              }`}
            >
              <span aria-hidden="true" className="flex text-accent">
                {TOOL_ICONS[item.view]}
              </span>
              {/* By the chat bar's own width (ChatPanel's @container/bar), not the window's. */}
              <span className="hidden @5xl/bar:inline">{item.short}</span>
            </button>
            {/* An open tool closes from here on hover (pass B, B17): the project menu holds projects only. */}
            {running && (
              <button
                type="button"
                aria-label={`Close ${item.label}`}
                title={`Close ${item.label}`}
                onClick={() => chat.closeTool(tabId, item.view as ToolKind)}
                className="absolute -top-1.5 -right-1.5 hidden size-4 cursor-pointer place-items-center rounded-full bg-[rgb(16_24_34/0.95)] text-muted group-hover/view:grid hover:text-ink"
              >
                <Icon name="close" size={8} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

