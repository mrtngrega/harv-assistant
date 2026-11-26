import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { SlashCommandInfo } from '@harv/shared';

/**
 * Claude Code commands Harv never offers or runs: ones that can bill beyond the
 * subscription or reach paid cloud features (CLAUDE.md: subscription only), ones
 * that only make sense in Claude Code's terminal, and ones the dashboard does
 * itself (/model, /effort: the model switcher and the router).
 */
/** Billed or paid cloud work. */
const BILLED = ['usage-credits', 'extra-usage', 'ultrareview', 'fast', 'schedule', '__remote-workflow', 'workflow-launch-exec'];

const HIDDEN = new Set([
  ...BILLED,
  // Terminal-only or Claude Code's own setup.
  'heapdump',
  'color',
  'focus',
  'config',
  'auto-mode-setup',
  'import',
  'loop',
  'login',
  'logout',
  'exit',
  'statusline',
  'terminal-setup',
  // The dashboard's own.
  'model',
  'effort',
]);

/** Why a hidden command doesn't run, for the chat notice. */
export function hiddenReason(name: string): string | undefined {
  if (!HIDDEN.has(name)) return undefined;
  if (['model', 'effort'].includes(name)) return 'Use the model switcher at the top, or /model in the chat line.';
  if (BILLED.includes(name)) return 'It can use paid extra usage or cloud features, and Harv only ever uses your subscription.';
  return 'It only works in Claude Code’s terminal.';
}

/** Harv's own version of Claude Code's /btw (a terminal feature there): see btw.ts. */
const BTW: SlashCommandInfo = {
  name: 'btw',
  description: 'Ask a quick side question without interrupting Harv (answered from this chat, not added to it)',
  argumentHint: '<question>',
};

/** Harv's own: a new session for this chat that starts from a handoff summary (one turn writes it). */
const FRESH: SlashCommandInfo = {
  name: 'fresh',
  description: 'Shrink this chat: Harv keeps a summary and forgets the rest (cheaper replies; /clear forgets everything)',
  argumentHint: '',
};

/** Harv's own: a note about Harv for the user's harv_report.md (no model call). */
const REPORT: SlashCommandInfo = {
  name: 'report',
  description: 'Note something about Harv (a bug, a wish) in harv_report.md, without asking Harv',
  argumentHint: '<what happened or what you want>',
};

/** The commands Harv offers, sorted by name (Claude Code's own first when names clash). */
export function toCommandInfo(commands: SlashCommand[], terminalOnly: string[] = []): SlashCommandInfo[] {
  const seen = new Set<string>(['btw', 'fresh', 'report']);
  const out: SlashCommandInfo[] = [BTW, FRESH, REPORT];
  for (const c of [...commands].sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin))) {
    // Claude Code still lists some commands it has dropped, described as "(removed) …".
    if (HIDDEN.has(c.name) || terminalOnly.includes(c.name) || seen.has(c.name) || /^\(removed\)/i.test(c.description)) continue;
    seen.add(c.name);
    out.push({ name: c.name, description: c.description, argumentHint: c.argumentHint });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `/name args` → name, when the message starts with a slash command (not a path like /c/Users). */
export function commandName(text: string): string | undefined {
  return /^\/([\w:.-]+)(\s|$)/.exec(text.trim())?.[1];
}

/** Harv's and the dashboard's own words after a slash: never a skill to go looking for. */
const OWN_WORDS = new Set(['btw', 'fresh', 'report', 'clear', 'plan', 'rewind', 'model', 'effort', 'attach', 'new', 'help', 'compact']);

/**
 * A normal chat lists only some skills (CHAT_SKILLS). This says whether the user asked for one
 * by name: a `/name` the chat doesn't know (not a model or effort word like /opus), or "use the
 * <name> skill" for an installed skill the chat lacks. The bare words "skill" or "plugin" don't
 * count (the full review, K28: "my English skills are rusty" or "is there a skill for PDFs?",
 * which is skill-finder's job, loaded every skill).
 */
export function asksForSkill(
  text: string,
  known: (name: string) => boolean,
  overrideWord: (word: string) => boolean,
  installed: (name: string) => boolean = () => false,
): boolean {
  const name = commandName(text);
  if (name) return !OWN_WORDS.has(name.toLowerCase()) && !overrideWord(name) && !known(name);
  for (const m of text.matchAll(/\b(?:use|run|try|with|load|via)\s+(?:the\s+|my\s+|your\s+)?([\w:.-]+)\s+(?:skill|plugin)\b/gi)) {
    const named = m[1]!.replace(/^\/+/, '');
    if (installed(named) && !known(named)) return true;
  }
  return false;
}
