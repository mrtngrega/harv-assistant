import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { ModelSwitcher } from './ModelSwitcher.tsx';
import { Icon } from './tools/explorer/icons.tsx';
import { chat, SETTINGS_TAB, useChat } from '../lib/chatStore.ts';
import { desktop, inApp } from '../lib/desktop.ts';
import { useConnection } from '../lib/useHarvSocket.ts';
import { HarvLogo, logoMode } from './HarvLogo.tsx';
import { RecentNotices } from './Notices.tsx';
import { awayCount, useNotices } from '../lib/notices.ts';

/** In the app, empty parts of the header (and the page edge) move the window; a double click maximizes. */
export function dragWindow(e: MouseEvent) {
  if (!inApp || e.button !== 0 || (e.target as HTMLElement).closest('button, input, select, a, [role="menu"], [role="dialog"]')) return;
  desktop.window(e.detail === 2 ? 'maximize' : 'drag');
}

/** The app's window controls: thin, quiet until hovered (× hides Harv to the tray). */
function WindowControls() {
  const button = 'grid size-8 cursor-pointer place-items-center rounded-md text-muted hover:bg-white/5';
  return (
    <div className="-mr-1 flex items-center gap-0.5">
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => desktop.window('minimize')}
        className={`${button} hover:text-accent`}
      >
        <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Maximize"
        title="Maximize"
        onClick={() => desktop.window('maximize')}
        className={`${button} hover:text-accent`}
      >
        <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Close to the tray"
        title="Close (Harv keeps running in the tray)"
        onClick={() => desktop.window('close')}
        className={`${button} hover:text-warn`}
      >
        <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
    </div>
  );
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // On the minute, not every second: each tick re-rendered the header, the model switcher and the logo (the full review, U13).
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      id = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    id = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(id);
  }, []);
  const pad = (n: number) => String(n).padStart(2, '0');
  // The time only: the date is on the system clock (pass B, B40).
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Harv's status lives above the command line now (StatusLine), like Claude Code's. */
export function Header() {
  const clock = useClock();
  const { activeId } = useChat();
  const { status } = useConnection();
  /** Recent is open, under the logo's box. */
  const [recent, setRecent] = useState<DOMRect | null>(null);
  const closeRecent = useCallback(() => setRecent(null), []);
  const away = awayCount(useNotices().recent);

  return (
    <header onMouseDown={dragWindow} className="glass flex flex-wrap items-center gap-4 rounded-2xl px-4 py-2.5 select-none">
      <div className="relative">
        <button
          type="button"
          // Not a drag handle: the header drags the window.
          onMouseDown={(e) => e.stopPropagation()}
          data-recent-toggle
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setRecent((r) => (r ? null : box));
          }}
          aria-haspopup="dialog"
          aria-expanded={!!recent}
          title="Recent notices"
          className="relative flex cursor-pointer items-center gap-2.5 rounded-lg pr-2 text-[15px] font-semibold tracking-[0.14em] text-accent hover:bg-white/5"
        >
          <HarvLogo size={32} mode={logoMode(status)} />
          HARV
          {away > 0 && (
            <i
              aria-label={`${away} new while you were away`}
              className="absolute top-0.5 left-7 size-2 rounded-full border-[1.5px] border-[#0c131b] bg-accent shadow-[0_0_6px_var(--color-accent)]"
            />
          )}
        </button>
        {recent && <RecentNotices anchor={recent} onClose={closeRecent} />}
      </div>
      <div className="flex-1" />
      <ModelSwitcher />
      {/* The first thing to go in a narrow window: below 1000px the window buttons wrapped onto a row of their own (2026-11-10). */}
      <div className="hidden text-muted tabular-nums min-[1000px]:block">{clock}</div>
      <button
        type="button"
        onClick={chat.openSettings}
        aria-label="Settings"
        aria-pressed={activeId === SETTINGS_TAB}
        title="Settings (opens as a tab)"
        className={`grid size-9 cursor-pointer place-items-center rounded-lg hover:bg-white/5 hover:text-ink ${activeId === SETTINGS_TAB ? 'text-accent' : 'text-muted'}`}
      >
        <Icon name="gear" size={18} />
      </button>
      {inApp && <WindowControls />}
    </header>
  );
}
