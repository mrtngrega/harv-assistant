// Harv presence in the chat (docs/review/pass-c.md C1, mockup docs/review/presence-mockup.html):
// the pure part, which moon a tool belongs to and what state Harv is in for one chat.

/** The six moons round Harv's face, in orbit order (inner first). */
export const MOONS = ['memory', 'files', 'shell', 'web', 'helpers', 'desktop'] as const;
export type Moon = (typeof MOONS)[number];

/**
 * The moon a tool call belongs to (`chat.tool`'s name: Harv's own tools by their short name,
 * desktop control as "desktop"), or null for tools with no moon (lights, schedules, skills…):
 * then only the core glows (the user, 2026-11-12).
 */
export function moonOf(name: string, detail = ''): Moon | null {
  if (name === 'desktop' || name.startsWith('mcp__desktop__')) return 'desktop';
  if (/^(remember|forget|list_chats|read_chat|project_status|harv_db)$/.test(name)) return 'memory';
  if (/^(Agent|Task|hand_off|SendMessage)$/.test(name)) return 'helpers';
  if (/^(Bash|PowerShell|BashOutput|KillShell|KillBash|Monitor|terminal_run|terminal_read)$/.test(name)) return 'shell';
  if (/^(WebSearch|WebFetch|generate_image)$/.test(name) || name.startsWith('browser_') || name.startsWith('mcp__claude_ai_')) return 'web';
  if (/^(Read|Write|Edit|MultiEdit|Glob|Grep|NotebookEdit|LS)$/.test(name))
    // Reading Harv's own memory files is memory, not files.
    return /[\\/]\.harv[\\/]memory\b/.test(detail) ? 'memory' : 'files';
  return null;
}

export type PresenceState = 'idle' | 'thinking' | 'working' | 'waiting' | 'desktop' | 'asleep';

export interface PresenceInput {
  /** The chat's turn is running. */
  busy: boolean;
  /** A tool ran in this turn (thinking before the first one). */
  toolRan: boolean;
  /** Held actions or an open card wait for the user's yes in this chat. */
  waiting: boolean;
  /** This chat drives the mouse and keyboard right now. */
  driving: boolean;
  /** Harv is paused at a plan limit with work of this chat cut off or queued. */
  asleep: boolean;
}

/** One state per chat; what needs the user wins, then the limit, then the work. */
export function presenceState(i: PresenceInput): PresenceState {
  if (i.waiting) return 'waiting';
  if (i.asleep) return 'asleep';
  if (!i.busy) return 'idle';
  if (i.driving) return 'desktop';
  return i.toolRan ? 'working' : 'thinking';
}

/** Below this chat width there's no hammock (it would cover the chat): the status line is enough. */
export const PRESENCE_MIN_WIDTH = 560;
