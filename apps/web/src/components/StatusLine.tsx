import { useEffect, useState, type ReactNode } from 'react';
import { FRESH_HINT_TOKENS } from '@harv/shared';
import { chat, useChat, type Tab } from '../lib/chatStore.ts';
import { setDraftText } from '../lib/drafts.ts';
import { heldWaiting } from '../lib/turns.ts';
import { resetTime, tokens } from '../lib/format.ts';
import { useSafety } from '../lib/safetyStore.ts';
import { useConnection, useSettings, useUsage } from '../lib/useHarvSocket.ts';
import { useSchedules, whenText } from '../lib/scheduleStore.ts';
import { jumpTo } from '../lib/settingsJump.ts';
import { formatElapsed } from '../lib/format.ts';
import { STRIP_ACTION, STRIP_BAND, STRIP_GLYPH, STRIP_NOTE, STRIP_QUIET, STRIP_ROW } from './strip.ts';

/** Claude Code's spinner glyphs. */
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

const COLOR = {
  ok: 'var(--color-ok)',
  accent: 'var(--color-accent)',
  warn: 'var(--color-warn)',
  faint: 'var(--color-faint)',
};

/** "08:00" today, "Mon 08:00" another day. */
function nextText(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

/**
 * Harv's status for this chat, just above the command line, like Claude Code's:
 * "✻ thinking… (12s · ↓ 340 tokens · esc to stop)". Offline and plan pauses show here too.
 * `children`: a quiet note at the right end of the line (the start choice after a restart).
 */
export function StatusLine({ tab, children }: { tab: Tab | undefined; children?: ReactNode }) {
  const conn = useConnection();
  const usage = useUsage();
  const { motion } = useSettings();
  const { approvals, desktop } = useSafety();
  const { tabs } = useChat();
  const card = approvals.find((a) => a.tabId === tab?.id);
  const waiting = !!card;
  const ask = card?.kind === 'question' ? 'answer above' : card?.kind === 'plan' ? 'approve the plan above' : 'approve or deny above';
  // An approval card in another chat is invisible from here: say so, with a way there.
  const elsewhere = tabs.find((t) => t.id !== tab?.id && approvals.some((a) => a.tabId === t.id));
  // This chat's next scheduled run, so it shows without opening Settings (pass B, B38).
  const next = useSchedules()
    .filter((t) => t.tabId === tab?.id && t.nextAt)
    .sort((a, b) => a.nextAt! - b.nextAt!)[0];
  const busy = Boolean(tab?.busy);
  // This chat is using the mouse and keyboard (desktop control): said plainly, with its own clock.
  const driving = busy && desktop?.tabId === tab?.id ? desktop : null;
  const [now, setNow] = useState(() => Date.now());
  const [frame, setFrame] = useState(0);

  // The clock ticks while a turn runs; the spinner turns only with motion on.
  useEffect(() => {
    if (!busy) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const spin = motion ? window.setInterval(() => setFrame((f) => f + 1), 120) : undefined;
    return () => {
      clearInterval(clock);
      clearInterval(spin);
    };
  }, [busy, motion]);

  let glyph = '●';
  let color = COLOR.ok;
  let label: string;
  let extra = '';
  if (!conn.connected) {
    color = COLOR.faint;
    label = 'offline · reconnecting…';
  } else if (conn.status === 'paused') {
    color = COLOR.warn;
    // One line for a limit (pass B, B14): when it lifts, what waits, and a way to drop this tab's queue.
    label = usage?.pausedUntil ? `paused · plan limit until ${resetTime(usage.pausedUntil)}` : 'paused · plan limit';
    if (usage?.queued) extra = `${usage.queued} waiting`;
  } else if (busy && tab) {
    glyph = driving && !waiting ? '⌖' : motion ? SPIN[frame % SPIN.length]! : '✻';
    color = waiting ? COLOR.warn : driving ? COLOR.accent : tab.activity ? COLOR.warn : COLOR.accent;
    label = waiting
      ? `needs you · ${ask}`
      : driving
        ? `controlling your desktop · ${driving.action}`
        : tab.activity
          ? `working · ${tab.activity}`
          : 'thinking…';
    const since = driving && !waiting ? driving.since : tab.startedAt;
    const parts = [since ? formatElapsed(now - since) : '', tab.outTokens ? `↓ ${tokens(tab.outTokens)} tokens` : ''];
    extra = `(${[...parts.filter(Boolean), 'esc to stop'].join(' · ')})`;
  } else if (tab && heldWaiting(tab.lines) > 0) {
    // Held actions wait for the user's next message (pass B, B6).
    const n = heldWaiting(tab.lines);
    color = COLOR.warn;
    label = `waiting for your yes · ${n} held`;
    extra = n > 1 ? 'reply yes, no, or yes 1' : 'reply yes or no';
  } else {
    label = 'idle';
    if (tab?.lastTurn) extra = `last reply ${formatElapsed(tab.lastTurn.ms)} · ↓ ${tokens(tab.lastTurn.tokens)} tokens`;
  }

  return (
    <div role="status" aria-label={`Harv is ${label}`} className={`${STRIP_BAND} ${STRIP_ROW} box-content`}>
      <span aria-hidden="true" className={`${STRIP_GLYPH} ${driving && !waiting && motion ? 'animate-pulse' : ''}`} style={{ color }}>
        {glyph}
      </span>
      <span className="truncate" style={{ color: busy || color !== COLOR.ok ? color : undefined }}>
        {label}
      </span>
      {extra && <span className="truncate text-faint">{extra}</span>}
      {/* The right end: notes and links, then the chat's size (pass B, B2a: moved here from the tab bar). */}
      <span className="ml-auto flex min-w-0 items-center gap-2">
        {elsewhere && (
          <button
            type="button"
            onClick={() => {
              chat.setActive(elsewhere.id);
              chat.setView(elsewhere.id, 'chat');
            }}
            className={`${STRIP_ACTION} border border-warn/50 text-warn hover:bg-warn/15`}
          >
            ! “{elsewhere.title}” needs your approval
          </button>
        )}
        {conn.status === 'paused' && usage?.queued && tab ? (
          <button type="button" onClick={() => chat.stop(tab.id)} className={`${STRIP_ACTION} text-muted hover:bg-white/10 hover:text-ink`}>
            cancel this tab’s queue
          </button>
        ) : null}
        {children}
        {next && (
          <button
            type="button"
            onClick={() => {
              chat.openSettings();
              window.setTimeout(() => jumpTo('What Harv can do'), 80);
            }}
            title={`Scheduled in this chat: ${next.title} (${whenText(next)}). Click to see the list.`}
            className={`${STRIP_ACTION} ${STRIP_QUIET} hover:text-ink max-sm:hidden`}
          >
            scheduled · next {nextText(next.nextAt!)}
          </button>
        )}
        {!!tab?.context && (
          <span
            className={`${STRIP_NOTE} hidden sm:inline`}
            title="The chat's size: what Harv sent with its latest message, plus what it wrote. Every reply sends it again, so a big chat costs more."
          >
            chat size {tokens(tab.context)}
          </span>
        )}
        {!busy && tab?.context !== undefined && tab.context >= FRESH_HINT_TOKENS && (
          <button
            type="button"
            onClick={() => {
              setDraftText(tab.id, '/fresh');
              document.getElementById('harv-cmd')?.focus();
            }}
            title="This chat is big, so every reply costs more. /fresh saves memory and a summary, then goes on in a new session."
            className={`${STRIP_ACTION} text-warn hover:bg-warn/15`}
          >
            /fresh?
          </button>
        )}
      </span>
    </div>
  );
}
