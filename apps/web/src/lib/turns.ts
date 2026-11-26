import type { ActionEntry } from '@harv/shared';
import type { Line } from './chatStore.ts';

/**
 * How a chat's lines show (Fable pass B: B3, B4, B5): one `harv ›` header per reply, a finished
 * turn's thoughts and tool steps folded into one "▸ 7 steps" row, tool steps in plain words.
 */

export type Shown =
  | { kind: 'line'; line: Line; /** Show `harv ›`, the time and the tag (a reply's first block, or a new tag). */ head: boolean }
  | { kind: 'steps'; id: string; lines: Line[]; seconds: number };

/** "2s" → 2 (a thinking line's tag). */
const thoughtSeconds = (line: Line) => Number.parseInt(line.tag ?? '', 10) || 0;

/** A step the user should still see after the turn: held, refused, failed or undoable. */
export function standsOut(action: ActionEntry | undefined): boolean {
  if (!action) return false;
  return action.status === 'blocked' || action.status === 'failed' || action.status === 'pending' || action.canUndo;
}

/** Plumbing the user never needs to see (Claude Code loading a tool's definition). */
const HIDDEN_TOOLS = new Set(['ToolSearch']);

/** Thoughts this short get no row (the status line showed them live). */
const SHORT_THOUGHT_S = 3;

export function groupLines(lines: Line[], busy: boolean, actionOf: (ref?: string) => ActionEntry | undefined): Shown[] {
  const out: Shown[] = [];
  // Turns: a `you` line starts one. The last turn is still running while the tab is busy.
  const lastYou = lines.findLastIndex((l) => l.kind === 'you');
  let lastTag: string | undefined;
  let headDone = false;
  let fold: { id: string; lines: Line[]; first: number; last: number } | null = null;
  let foldAt = -1;

  const flush = () => {
    if (fold && fold.lines.length > 0) {
      out.splice(foldAt, 0, { kind: 'steps', id: fold.id, lines: fold.lines, seconds: Math.round((fold.last - fold.first) / 1000) });
    }
    fold = null;
  };

  lines.forEach((line, i) => {
    if (line.kind === 'you') {
      flush();
      lastTag = undefined;
      headDone = false;
      out.push({ kind: 'line', line, head: true });
      return;
    }
    const running = busy && i > lastYou;
    if (line.kind === 'thinking' || line.kind === 'tool') {
      if (line.kind === 'tool' && HIDDEN_TOOLS.has(line.text.split(' · ')[0]!)) return;
      if (line.kind === 'thinking' && thoughtSeconds(line) < SHORT_THOUGHT_S && !running) return;
      if (running || (line.kind === 'tool' && standsOut(actionOf(line.ref)))) {
        out.push({ kind: 'line', line, head: true });
        return;
      }
      if (!fold) {
        fold = { id: `steps-${line.id}`, lines: [], first: line.at, last: line.at };
        foldAt = out.length;
      }
      fold.lines.push(line);
      fold.last = line.at;
      return;
    }
    if (line.kind === 'harv') {
      const head = !headDone || (!!line.tag && line.tag !== lastTag);
      headDone = true;
      if (line.tag) lastTag = line.tag;
      if (fold) fold.last = line.at;
      out.push({ kind: 'line', line, head });
      return;
    }
    out.push({ kind: 'line', line, head: true });
  });
  flush();
  return out;
}

const PLAIN: Record<string, string> = {
  Read: 'read',
  Write: 'wrote',
  Edit: 'edited',
  MultiEdit: 'edited',
  Glob: 'looked for files',
  Grep: 'searched',
  WebSearch: 'searched the web for',
  WebFetch: 'opened',
  Bash: 'ran a command',
  PowerShell: 'ran a command',
  Task: 'started a helper',
  Agent: 'started a helper',
  TodoWrite: 'updated the to-do list',
  NotebookEdit: 'edited',
  terminal_run: 'typed in the terminal',
  terminal_read: 'read the terminal',
  browser_open: 'opened',
  remember: 'remembered',
  forget: 'forgot',
  list_chats: 'looked through chats',
  read_chat: 'read the chat',
  hand_off: 'handed off',
  generate_image: 'drew',
};

/** The last part of a path, for "read app.py". */
const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * A tool step in plain words: a command's own description when it has one ("Download the cover
 * image"), else a verb and its object ("read app.py"). The raw text stays one click away.
 */
export function plainTool(text: string, action?: ActionEntry): string {
  const [name = '', ...rest] = text.split(' · ');
  const detail = rest.join(' · ');
  const verb = PLAIN[name];
  if (!verb) return text;
  if (name === 'Bash' || name === 'PowerShell') {
    // The log's summary is the call's description, or the command itself when it had none.
    const said = action?.summary;
    return said && !detail.startsWith(said.slice(0, 40)) ? said : verb;
  }
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return detail ? `${verb} ${fileName(detail)}` : verb;
  return detail ? `${verb} ${detail}` : verb;
}

/** The gate's line for a held action (safety/gate.ts `hold`). */
export const HELD_PREFIX = 'Held, waiting for your yes:';

export const isHeld = (line: Line) => line.kind === 'notice' && line.text.startsWith(HELD_PREFIX);

/** Held actions still waiting: the ones since the user's last message (that message answers them). Pass B, B6. */
export function heldWaiting(lines: Line[]): number {
  let n = 0;
  for (let i = lines.length - 1; i >= 0 && lines[i]!.kind !== 'you'; i--) if (isHeld(lines[i]!)) n++;
  return n;
}

const DOING: Record<string, string> = {
  Bash: 'running a command',
  PowerShell: 'running a command',
  Read: 'reading',
  Write: 'writing',
  Edit: 'editing',
  MultiEdit: 'editing',
  NotebookEdit: 'editing',
  Grep: 'searching',
  Glob: 'looking for files',
  WebSearch: 'searching the web',
  WebFetch: 'reading a page',
  Task: 'with a helper',
  Agent: 'with a helper',
  Skill: 'using a skill',
};

/**
 * What the status line and the pill say while a tool runs: "running a command", "Gmail: search
 * threads", not "Bash" or "mcp__claude_ai_Gmail__search_threads" (the full review, U24).
 */
export function activityOf(name: string): string {
  if (DOING[name]) return DOING[name];
  const mcp = /^mcp__(?:claude_ai_)?([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) {
    const what = mcp[2]!.replace(/[_-]+/g, ' ');
    return mcp[1] === 'harv' ? what : `${mcp[1]!.replace(/_/g, ' ')}: ${what}`;
  }
  return name;
}
