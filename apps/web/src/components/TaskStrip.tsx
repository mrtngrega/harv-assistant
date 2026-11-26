import type { BackgroundTask } from '@harv/shared';
import { Icon } from './tools/explorer/icons.tsx';
import { useEffect, useState } from 'react';
import { chat, type Tab } from '../lib/chatStore.ts';
import { formatElapsed } from '../lib/format.ts';
import { STRIP_ACTION, STRIP_BAND, STRIP_GLYPH, STRIP_QUIET, STRIP_ROW } from './strip.ts';

const GLYPH: Record<BackgroundTask['status'], string> = { running: '⟳', completed: '✓', failed: '✗', stopped: '■' };
/** How long an ended task stays in the strip: a failure longer, so it isn't missed (the user's report, 2026-11-09: they never went away). */
export const SHOWN_MS: Record<Exclude<BackgroundTask['status'], 'running'>, number> = {
  completed: 60_000,
  stopped: 60_000,
  failed: 10 * 60_000,
};

/** Still in the strip at `now`: running, or ended less than its time ago. */
export function stillShown(task: BackgroundTask, now: number): boolean {
  return task.status === 'running' || task.endedAt === undefined || now - task.endedAt < SHOWN_MS[task.status];
}

const COLOR: Record<BackgroundTask['status'], string> = {
  running: 'text-accent',
  completed: 'text-ok',
  failed: 'text-warn',
  stopped: 'text-faint',
};

/** "general-purpose", "shell", "monitor": what kind of worker it is. */
function kindOf(task: BackgroundTask): string {
  if (task.kind === 'local_agent') return task.agent ?? 'agent';
  if (task.kind === 'local_bash') return 'shell';
  return task.kind.replace(/^local_/, '').replace(/_/g, ' ');
}

/**
 * The chat's background agents and shells, just above the status line:
 * "⟳ general-purpose · Find the radio API · 2m 05s · Grep ■". Ended ones stay a minute with
 * their outcome (a failure ten), and can be dismissed sooner. The strip runs its own clock for
 * that: the server sends the list only when something changes.
 */
export function TaskStrip({ tab }: { tab: Tab | undefined }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const tasks = (tab?.tasks ?? []).filter((t) => !hidden.has(t.id) && stillShown(t, now));
  const ticking = tasks.length > 0;

  useEffect(() => {
    if (!ticking) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [ticking]);

  if (!tab || tasks.length === 0) return null;
  return (
    <ul aria-label="Background tasks" className={`max-h-[6.25rem] overflow-y-auto ${STRIP_BAND}`}>
      {tasks.map((t) => {
        const took = formatElapsed((t.endedAt ?? now) - t.startedAt);
        const detail =
          t.status === 'running'
            ? [took, t.lastTool, t.summary]
            : [`${t.status === 'completed' ? 'done' : t.status} after ${took}`, t.summary];
        return (
          <li key={t.id} className={STRIP_ROW} title={t.summary || t.description}>
            <span aria-hidden="true" className={`${STRIP_GLYPH} ${COLOR[t.status]}`}>
              {GLYPH[t.status]}
            </span>
            <span className={`flex-none ${t.status === 'running' ? 'text-muted' : 'text-faint'}`}>{kindOf(t)}</span>
            <span className="min-w-0 truncate text-ink">{t.description}</span>
            <span className="min-w-0 flex-1 truncate text-faint">{detail.filter(Boolean).join(' · ')}</span>
            {t.status === 'running' ? (
              <button
                type="button"
                onClick={() => chat.stopTask(tab.id, t.id)}
                aria-label={`Stop ${t.description}`}
                className={`${STRIP_ACTION} ${STRIP_QUIET} hover:text-warn`}
              >
                stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setHidden((h) => new Set(h).add(t.id))}
                aria-label={`Dismiss ${t.description}`}
                className={`${STRIP_ACTION} ${STRIP_QUIET} hover:text-ink`}
              >
                <Icon name="close" size={12} className="block" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
