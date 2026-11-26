import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  awayCount,
  dismissNotice,
  lineOf,
  reopen,
  SAY_MS,
  setNoticeOpen,
  setRecentOpen,
  useHang,
  useNotices,
  type NoticeAction,
  type QueuedNotice,
} from '../lib/notices.ts';
import { chat } from '../lib/chatStore.ts';
import { useSettings } from '../lib/useHarvSocket.ts';

const AMBER = (n: { level: string }) => n.level !== 'normal';

/** The detail's buttons: the notice's own, plus a plain close when none of them is one. */
function actionsOf(n: QueuedNotice): NoticeAction[] {
  const list = n.actions ?? [];
  if (n.key === 'reply' && n.chats && n.chats.length > 1)
    return [...n.chats.map((c) => ({ label: `Open “${c.title}”`, run: () => chat.setActive(c.id) })), { label: 'Dismiss' }];
  return list.some((a) => !a.run) ? list : [...list, { label: 'Dismiss' }];
}

/**
 * Harv says his notices (docs/PLAN.md §6ad): one line in a bubble under his face when the hammock
 * shows (`useHang`), else near the top of the chat area. Click it for the detail and its actions.
 * Normal ones go after SAY_MS (a thin line runs down); warnings are amber and stay; urgent ones are
 * amber, stronger and glow. The rest wait behind it ("+2"), urgent first.
 */
export function NoticeBubble() {
  const { queue, open } = useNotices();
  const hang = useHang();
  const { motion } = useSettings();
  const head = queue[0];

  // A normal notice goes by itself, unless its detail is open.
  useEffect(() => {
    if (!head || head.level !== 'normal' || open) return;
    const timer = window.setTimeout(() => dismissNotice(head.id), SAY_MS);
    return () => clearTimeout(timer);
  }, [head, open]);

  if (!head) return null;
  const urgent = head.level === 'urgent';
  const more = queue.length - 1;
  return (
    // Outer: placement. Inner: the fade (its own transform), after the hammock lands when he's there.
    <div className="pointer-events-none absolute inset-x-0 z-[6] flex justify-center px-3" style={{ top: hang || 10 }}>
      <div
        role={AMBER(head) ? 'alert' : 'status'}
        key={head.id}
        className={`pointer-events-auto relative w-max max-w-[min(440px,100%)] rounded-[14px] border bg-[rgb(16_24_34/0.94)] shadow-[0_12px_32px_rgb(0_0_0/0.4)] ${
          motion ? 'animate-fade-in' : ''
        } ${open ? 'w-[min(440px,100%)]' : ''} ${
          urgent
            ? 'border-2 border-warn bg-[linear-gradient(rgb(242_184_128/0.16),rgb(242_184_128/0.16)),rgb(16_24_34/0.94)] shadow-[0_0_0_4px_rgb(242_184_128/0.12),0_0_28px_rgb(242_184_128/0.35),0_12px_32px_rgb(0_0_0/0.4)]'
            : AMBER(head)
              ? 'border-warn/65'
              : 'border-accent/45'
        }`}
        style={motion && hang ? { animationDelay: '280ms' } : undefined}
      >
        <div className="flex min-w-0 items-stretch">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setNoticeOpen(!open)}
            className={`relative flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-[14px] py-2 pl-3.5 text-left text-[13px] hover:bg-white/5 ${AMBER(head) ? 'pr-1.5' : 'pr-3.5'} ${
              AMBER(head) ? 'text-warn' : 'text-ink'
            } ${urgent ? 'font-semibold' : ''}`}
          >
            <span aria-hidden="true" className={`flex-none ${AMBER(head) ? 'text-warn' : 'text-accent'}`}>
              {head.icon}
            </span>
            <span className={`min-w-0 flex-1 ${open ? '[overflow-wrap:anywhere]' : 'truncate'}`}>{lineOf(head)}</span>
            {more > 0 && (
              <span
                title={`${more} more waiting`}
                className={`flex-none rounded-full px-1.5 text-[11px] font-semibold text-[#0f1620] ${AMBER(head) ? 'bg-warn' : 'bg-accent'}`}
              >
                +{more}
              </span>
            )}
            {head.level === 'normal' && !open && motion && (
              <i
                key={head.id}
                aria-hidden="true"
                className="absolute inset-x-3.5 bottom-[3px] h-px origin-left bg-accent/55"
                style={{ animation: `notice-fade ${SAY_MS}ms linear forwards` }}
              />
            )}
          </button>
          {/* Amber ones stay until clicked: one click puts them away without opening the detail. */}
          {AMBER(head) && (
            <button
              type="button"
              title="Dismiss"
              aria-label="Dismiss"
              onClick={() => dismissNotice(head.id)}
              className="flex w-8 flex-none cursor-pointer items-center justify-center rounded-[14px] text-[15px] leading-none text-warn/70 hover:bg-white/10 hover:text-warn"
            >
              ×
            </button>
          )}
        </div>
        {open && (
          <div className="mt-0.5 flex flex-col gap-2.5 border-t border-line px-3.5 pt-2.5 pb-3 text-xs text-muted">
            {head.detail && <p className="m-0 max-h-32 overflow-y-auto [overflow-wrap:anywhere]">{head.detail}</p>}
            <div className="flex flex-wrap gap-2">
              {actionsOf(head).map((a, i) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => {
                    a.run?.();
                    dismissNotice(head.id);
                  }}
                  className={
                    i === 0 && a.run
                      ? 'cursor-pointer rounded-md border border-accent/50 px-2 py-1 text-accent hover:bg-accent/15'
                      : 'cursor-pointer rounded-md border border-line px-2 py-1 text-muted hover:bg-white/10 hover:text-ink'
                  }
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Today's notices behind the header logo: newest first, what came while the user was away marked, a
 * click opens one again. In a portal under `anchor`: the header's glass is its own layer, so a list
 * inside it went behind the history panel.
 */
export function RecentNotices({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const { recent } = useNotices();
  const box = useRef<HTMLDivElement>(null);
  const away = awayCount(recent);

  useEffect(() => {
    setRecentOpen(true);
    const close = (e: Event) => {
      // The logo itself toggles it (its own click closes it).
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') onClose();
      } else if (!box.current?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-recent-toggle]')) onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      // Seen now: "while you were away" is only the top line of the first look.
      setRecentOpen(false);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label="Recent notices"
      style={{ top: anchor.bottom + 8, left: Math.max(12, anchor.left) }}
      className="fixed z-50 max-h-[300px] w-[min(360px,calc(100vw-24px))] overflow-y-auto rounded-xl border border-accent/35 bg-[rgb(16_24_34/0.96)] py-2 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.45)] backdrop-blur-[22px]"
    >
      <div className="px-3.5 pb-1.5 text-[11px] tracking-[0.15em] text-faint">RECENT · TODAY</div>
      {away > 0 && (
        <div className="mx-2 mb-1.5 rounded-lg bg-accent/10 px-2 py-1.5 text-accent">
          {away} notice{away === 1 ? '' : 's'} while you were away
        </div>
      )}
      {recent.length === 0 && <p className="m-0 px-3.5 py-1 text-faint">Nothing yet today.</p>}
      {recent.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => {
            reopen(r);
            onClose();
          }}
          className={`flex w-full cursor-pointer gap-2.5 border-l-2 px-3.5 py-1.5 text-left hover:bg-white/5 ${r.away ? 'border-accent' : 'border-transparent'}`}
        >
          <time className="flex-none text-faint tabular-nums">{clock(r.at)}</time>
          <span
            className={`min-w-0 [overflow-wrap:anywhere] ${r.notice.level === 'normal' ? 'text-ink' : 'text-warn'} ${r.notice.level === 'urgent' ? 'font-semibold' : ''}`}
          >
            {r.notice.line}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
