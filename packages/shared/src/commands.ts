/**
 * A mistyped `/word` (the user's `/maybe` for `/report`, 2026-11-09): a word after a slash that is no
 * command, skill, model or effort is caught before it goes anywhere. The dashboard keeps the text in
 * the box and says "did you mean"; the server refuses it the same way (and never loads every skill
 * for it). Shared so both judge alike.
 */

/** Harv's and the dashboard's own commands: always known, even before the catalog loads. */
export const OWN_COMMANDS = ['btw', 'fresh', 'report', 'clear', 'plan', 'rewind', 'model', 'attach', 'new', 'help'];
/** One-message model and effort words (`/opus fix it`, `/max …`): never a typo. */
const OVERRIDE_WORDS = ['auto', 'opus', 'sonnet', 'haiku', 'fable', 'low', 'med', 'medium', 'high', 'xhigh', 'max', 'effort'];

/** `/name args` → name, when a message starts with a slash command (not a path like /c/Users or /tmp/x). */
export function slashWord(text: string): string | undefined {
  return /^\/([\w:.-]+)(\s|$)/.exec(text.trim())?.[1];
}

/** Edit distance with swapped neighbours counting once ("reprot" → "report" is 1). */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  return d[a.length]![b.length]!;
}

/** The known command closest to a typo: a prefix of one, or within a couple of letters. */
export function nearestCommand(word: string, known: string[]): string | undefined {
  const w = word.toLowerCase();
  const names = [...new Set([...OWN_COMMANDS, ...known])];
  const prefixed = names.filter((n) => n.toLowerCase().startsWith(w)).sort((a, b) => a.length - b.length)[0];
  if (prefixed && w.length >= 2) return prefixed;
  const limit = Math.max(1, Math.floor(w.length / 3));
  let best: string | undefined;
  let bestD = limit + 1;
  for (const n of names) {
    const dist = distance(w, n.toLowerCase().replace(/^.*:/, ''));
    if (dist < bestD) [best, bestD] = [n, dist];
  }
  return best;
}

/**
 * The message starts with a `/word` that nothing knows: `known` is every command and skill (the
 * catalog's list, which has all the user's skills, plus the chat's own). Null for a normal message,
 * a real command, a model/effort word, or before the list is known.
 */
export function unknownCommand(text: string, known: string[]): { name: string; suggestion?: string } | null {
  const name = slashWord(text);
  // No list yet (the catalog is still loading): nothing to judge by.
  if (!name || known.length === 0) return null;
  const lower = name.toLowerCase();
  if (OVERRIDE_WORDS.includes(lower) || OWN_COMMANDS.includes(lower)) return null;
  if (known.some((k) => k.toLowerCase() === lower)) return null;
  const suggestion = nearestCommand(name, known);
  return { name, ...(suggestion ? { suggestion } : {}) };
}

/** What the chat says about it. */
export function unknownCommandText(u: { name: string; suggestion?: string }): string {
  return `There’s no /${u.name} command, so nothing was sent.${u.suggestion ? ` Did you mean /${u.suggestion}?` : ' Type / to see the commands.'} To send it as a plain message, take the slash off.`;
}
