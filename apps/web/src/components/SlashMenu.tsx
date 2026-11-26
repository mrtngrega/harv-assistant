import type { SlashCommandInfo } from '@harv/shared';
import { SuggestionList } from './SuggestionList.tsx';

/** The dashboard's own commands (lib/commands.ts), listed with Claude Code's. */
export const DASHBOARD_COMMANDS: SlashCommandInfo[] = [
  { name: 'model', argumentHint: 'auto|opus|sonnet|haiku|fable [effort]', description: 'Switch the model and effort (Harv)' },
  { name: 'attach', argumentHint: '', description: 'Add files to the message (Harv)' },
  { name: 'new', argumentHint: '', description: 'Open a new chat tab (Harv)' },
  { name: 'plan', argumentHint: '[on|off]', description: 'Plan mode: Harv only reads and plans, then shows a plan to approve (Harv)' },
  { name: 'rewind', argumentHint: '', description: 'Go back to before your last message: files and chat (Harv)' },
  { name: 'help', argumentHint: '', description: 'Show Harv’s commands (Harv)' },
];

/** Harv's own commands, listed first in the menu and in /help (pass B, B10). */
export const PINNED = ['btw', 'report', 'fresh', 'plan', 'rewind', 'model', 'new', 'attach', 'clear'];
const pinRank = (name: string) => (PINNED.includes(name) ? PINNED.indexOf(name) : PINNED.length);

/** The commands matching what's typed after "/": names that start with it first, then names that contain it; Harv's own first in each. */
export function matchCommands(draft: string, commands: SlashCommandInfo[]): SlashCommandInfo[] {
  const typed = /^\/([\w:.-]*)$/.exec(draft)?.[1]?.toLowerCase();
  if (typed === undefined) return [];
  const seen = new Set<string>();
  const all = [...DASHBOARD_COMMANDS, ...commands].filter((c) => !seen.has(c.name) && seen.add(c.name));
  const byPin = (a: SlashCommandInfo, b: SlashCommandInfo) => pinRank(a.name) - pinRank(b.name);
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(typed)).sort(byPin);
  const contains = all.filter((c) => !c.name.toLowerCase().startsWith(typed) && c.name.toLowerCase().includes(typed)).sort(byPin);
  return [...starts, ...contains];
}

/** The list that opens above the command line while a "/command" is being typed, like Claude Code's. */
export function SlashMenu({ items, index, onPick }: { items: SlashCommandInfo[]; index: number; onPick: (c: SlashCommandInfo) => void }) {
  return (
    <SuggestionList
      label="Commands"
      items={items}
      index={index}
      onPick={onPick}
      keyOf={(c) => c.name}
      // A thin line under Harv's own commands, before Claude Code's and the skills.
      rowClass={(c, i) => (PINNED.includes(c.name) && items[i + 1] && !PINNED.includes(items[i + 1]!.name) ? 'border-b border-line' : '')}
      row={(c) => (
        <>
          <span className="flex-none text-accent">/{c.name}</span>
          {c.argumentHint && c.argumentHint.length <= 32 && <span className="hidden flex-none text-faint sm:inline">{c.argumentHint}</span>}
          <span className="min-w-0 truncate text-muted">{c.description}</span>
        </>
      )}
    />
  );
}
