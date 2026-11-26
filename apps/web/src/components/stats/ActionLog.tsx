import { recentActions, useSafety } from '../../lib/safetyStore.ts';
import { ActionBadge } from '../ApprovalCard.tsx';
import { Card } from './parts.tsx';

/** A result worth a line: not the plain "it worked", and without Claude Code's "Shell cwd was reset" note (pass B, B8). */
function resultText(result: string | undefined): string {
  const text = (result ?? '')
    .replace(/Shell cwd was reset to [^\n]*/g, '')
    .trim()
    .replace(/^Finished with messages:\s*$/, '')
    .trim();
  return /^(Done\.|Finished without errors\.)$/.test(text) ? '' : text;
}

/** "17:14" today, "16 Nov 17:14" before: the list spans days (the full review, R5). */
const time = (at: number, now = new Date()) => {
  const d = new Date(at);
  const clock = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? clock : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock}`;
};

/** A failure's first line only: the rest is the command's whole output (it stays in the tooltip). */
const firstLine = (text: string) =>
  text
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim() ?? '';

/** The latest yellow, red and blocked actions with their outcome and Undo. Reads aren't listed. */
export function ActionLog() {
  // Reads change nothing: only what changed (or waits, or was refused) is listed.
  const actions = recentActions(useSafety()).filter((a) => a.tier !== 'green');

  return (
    <Card title="Actions" sub="changes Harv made · newest first">
      {actions.length === 0 ? (
        <p className="m-0 text-xs text-muted">Nothing yet. Edits, commands and anything blocked show up here.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-xs">
          {actions.map((a) => (
            <li key={a.id} className="flex flex-col gap-0.5">
              <div className="flex items-baseline gap-2">
                <span className="flex-none text-[11px] whitespace-nowrap text-faint tabular-nums">{time(a.at)}</span>
                <span className="min-w-0 flex-1 truncate" title={a.summary}>
                  {a.summary}
                </span>
              </div>
              <div className="flex items-center gap-2 pl-[46px]">
                <ActionBadge action={a} />
                {resultText(a.result) && (
                  <span className="min-w-0 truncate text-[11px] text-faint" title={resultText(a.result)}>
                    {firstLine(resultText(a.result))}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
