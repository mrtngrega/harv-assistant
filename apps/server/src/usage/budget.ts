import type { PlanMeter, PlanUsage } from '@harv/shared';
import type { CostGuide } from '../store/routes.ts';

/**
 * Near the end of the 5-hour session Harv keeps its models (quality first) but says when a task
 * won't fit, and stops cleanly at SESSION_STOP_AT to wait for the reset (the user's rule, 2026-11-10).
 */
export const SESSION_WARN_AT = 75;
export const SESSION_STOP_AT = 90;

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const state = (m: PlanMeter) => `${Math.round(m.percent)}% used${m.resetsAt ? `, resets at ${clock(m.resetsAt)}` : ''}`;

/** The note in front of a turn: nothing below SESSION_WARN_AT. */
export function sessionNote(m: PlanMeter | undefined): string {
  if (!m || m.percent < SESSION_WARN_AT || m.percent >= 100) return '';
  if (m.percent >= SESSION_STOP_AT)
    return `[Plan: the 5-hour session is nearly used up (${state(m)}). A quick answer or a small step is fine. Don't start bigger work (many steps, a build, a long review): say plainly it won't fit before the limit and suggest waiting for the reset, then continuing. If the user says go anyway, do it. Same models and effort as always: quality stays first.]\n\n`;
  return `[Plan: the 5-hour session is at ${state(m)}. If this task looks big (many steps, a long build or review), say in one line up front that it may not fit before the limit, and that you'll stop cleanly at ${SESSION_STOP_AT}% so it can continue after the reset; then go on unless the user says to wait. Small tasks: don't mention it. Same models and effort as always.]\n\n`;
}

/** The note between tool calls once the session reaches SESSION_STOP_AT: finish the step, stop cleanly. */
export function stopNote(m: PlanMeter | undefined): string {
  if (!m || m.percent < SESSION_STOP_AT) return '';
  return `[Plan: the 5-hour session just reached ${state(m)}. Stop cleanly now: finish only the step you're on (leave no file half-edited; in a project, commit the work so far if it's sound), start nothing new, then tell the user where you stopped, what's left, and that you'll continue after the reset when they say so.]`;
}

const when = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function inTime(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${min % 60}m` : `${min}m`;
}

const pct = (x: number) => (x < 1 ? `${x.toFixed(1)}%` : `${Math.round(x)}%`);

/**
 * How to estimate a task's plan usage from what replies cost here (the user's report note, 2026-11-25:
 * "guess the token/plan usage of a task or plan accurately").
 */
export function costGuideText(g: CostGuide): string {
  if (!g.perReply.length) return 'Cost guide: not enough replies logged yet to estimate costs (it fills in as Harv works).';
  const top = g.perReply.slice(0, 6);
  const reply = (r: CostGuide['perReply'][number]) =>
    g.sessionPerUsd !== undefined
      ? `${r.pick} ≈ ${pct(r.median * g.sessionPerUsd)} of the session (dear ones up to ${pct(r.p90 * g.sessionPerUsd)}; ${r.replies} replies)`
      : `${r.pick} ≈ $${r.median.toFixed(2)} (dear ones up to $${r.p90.toFixed(2)}; ${r.replies} replies)`;
  const rate =
    g.sessionPerUsd !== undefined
      ? `1% of the 5-hour session ≈ $${(1 / g.sessionPerUsd).toFixed(2)} of notional cost${g.weeklyPerUsd ? `, 1% of the week ≈ $${(1 / g.weeklyPerUsd).toFixed(2)}` : ''} (from ${g.windows} session windows).`
      : 'Not enough meter readings yet to turn dollars into %: give the estimate in replies and say the % is a rough guess.';
  return [
    'Cost guide, measured on the last two weeks of replies against the meter (an estimate; other use of the plan, like Claude Code sessions, adds to the meter too):',
    `- ${rate}`,
    `- One reply, typical: ${top.map(reply).join('; ')}.`,
    'To estimate a task: count the replies it needs (each tool-using step of a long job is part of one reply, so think in turns the user would see) × the per-reply cost on the model it\'ll run on; long chats and big file reads sit at the dear end. Give a range, e.g. "about 5–10% of the session", and after big work say what it really took.',
  ].join('\n');
}

/** The plan_usage tool's answer: every meter with its reset time, the pause and the queue, and the cost guide. */
export function usageText(u: PlanUsage, now = Date.now(), guide?: CostGuide): string {
  if (!u.meters.length) return 'No plan usage reading yet (the meter reads /usage shortly after start). Try again in a minute.';
  const rows = u.meters.map(
    (m) =>
      `- ${m.label}: ${Math.round(m.percent)}% used${m.resetsAt ? `, resets ${when(m.resetsAt)} (in ${inTime(m.resetsAt - now)})` : ''}`,
  );
  const age = u.fetchedAt ? ` (read ${inTime(now - u.fetchedAt)} ago)` : '';
  const extra = [
    u.pausedUntil ? `Paused at a limit until ${when(u.pausedUntil)}.` : '',
    u.queued ? `${u.queued} message(s) queued for after the reset.` : '',
    `Extra usage is ${u.extraUsageOn ? 'ON' : 'off'}.`,
  ].filter(Boolean);
  return [
    `Claude plan usage${age}, times in this computer's local time:`,
    ...rows,
    ...extra,
    ...(guide ? ['', costGuideText(guide)] : []),
  ].join('\n');
}

/** The session meter's window, so each note is given once per tab per window. */
export const windowOf = (m: PlanMeter) => String(m.resetsAt ?? 'unknown');
