import { EFFORT_LEVELS, type EffortLevel } from '@harv/shared';

/** Commands the dashboard handles itself; they never reach Claude, so they cost nothing. */
export type Command =
  | { kind: 'model'; model?: string; effort?: EffortLevel }
  | { kind: 'attach' }
  | { kind: 'new' }
  | { kind: 'help' }
  /** Plan mode: `on` undefined toggles it. */
  | { kind: 'plan'; on?: boolean }
  | { kind: 'rewind' };

export const HELP = [
  'Harv’s commands:',
  '/btw <question> · a quick side question, without interrupting',
  '/report <note> · a bug or wish for Harv, into harv_report.md',
  '/fresh · shrink this chat: Harv keeps a summary and forgets the rest (cheaper replies)',
  '/plan · Harv only reads and plans, then shows you the plan',
  '/rewind · back to before your last message (⟲ on a message goes further)',
  '/model auto|opus|sonnet|haiku|fable [effort] · switch the model',
  '/new · a new chat   /attach · add files   /clear · Harv forgets this chat',
  'Start a message with /opus, /sonnet or /max to run just that one message that way.',
  'Type / for all of Claude Code’s commands and your skills. While Harv answers, what you send waits for his next step.',
].join('\n');

const MODELS = ['auto', 'opus', 'sonnet', 'haiku', 'fable'];
const EFFORT_ALIASES: Record<string, EffortLevel> = { med: 'medium' };

/** A dashboard command, or null for a normal message (including one-message overrides like "/opus fix it"). */
export function parseCommand(text: string): Command | { kind: 'error'; message: string } | null {
  const [head, ...args] = text.trim().split(/\s+/);
  switch (head?.toLowerCase()) {
    case '/attach':
      return args.length ? null : { kind: 'attach' };
    case '/new':
      return args.length ? null : { kind: 'new' };
    case '/plan': {
      const a = args[0]?.toLowerCase();
      if (args.length > 1 || (a && a !== 'on' && a !== 'off')) return null;
      return { kind: 'plan', ...(a ? { on: a === 'on' } : {}) };
    }
    case '/rewind':
      return args.length ? null : { kind: 'rewind' };
    case '/help':
    case '/?':
      return { kind: 'help' };
    case '/model': {
      if (args.length === 0) return { kind: 'help' };
      let model: string | undefined;
      let effort: EffortLevel | undefined;
      for (const raw of args) {
        const a = raw.toLowerCase();
        const e = EFFORT_ALIASES[a] ?? a;
        if (!model && MODELS.includes(a)) model = a;
        else if (!effort && (EFFORT_LEVELS as string[]).includes(e)) effort = e as EffortLevel;
        else return { kind: 'error', message: `Unknown model or effort “${raw}”. ${HELP}` };
      }
      return { kind: 'model', model, effort };
    }
    default:
      return null;
  }
}
