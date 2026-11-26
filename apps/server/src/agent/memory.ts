import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { HARV_HOME } from '../paths.ts';

// Harv's private memory: one Markdown file per memory in ~/.harv/memory, changed only through the scoped
// remember/recall/forget tools below, which can't write anywhere else.
//
// Loaded by topic (the user, 2026-11-20: "a full on Jarvis that knows everything that's needed at the right
// time"; all notes in every prompt had filled 13.7k of 14k characters): every chat's prompt holds the core
// notes in full and a one-line index of the rest; a note's full text joins a message when the router's
// classifier names it for the message's topic, a note whose key word the message only contains comes as a
// one-line hint (since 2026-11-26: key words alone were mostly wrong), once per session, and Harv can always
// pull any note with `recall`. So the memory can grow without anything being cut.
//
// A note is plain Markdown with an optional header:
//   ---
//   about: one line on what it holds and when it matters
//   keys: fitbit, hodinky, garmin       (names and phrases that hint at it, any language; 4+ letters also match longer forms)
//   always: true                        (in every prompt in full)
//   ---

export const MEMORY_DIR = process.env.HARV_MEMORY_DIR ?? join(HARV_HOME, 'memory');
const MAX_CHARS = 2000;
/** The core notes (always in full) together stay under this; the rest costs one index line each. */
export const ALWAYS_BUDGET = 8_000;
/** Always in full, header or not: who the user is and how he wants answers. */
const CORE = ['user-profile', 'working-style', 'answer-style'];

export interface Memory {
  name: string;
  /** The whole file, header included (what sync and change notes compare). */
  content: string;
  /** The note without its header. */
  body: string;
  about: string;
  keys: string[];
  always: boolean;
  /** When the note was last saved (YYYY-MM-DD): its `updated` header, else the file's date. */
  updated?: string;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "2026-11-01" → "saved 2026-11-01, 19 days ago": a note's age, so Harv can judge how far to trust it. */
export function savedText(updated: string | undefined, now = Date.now()): string {
  if (!updated) return '';
  const days = Math.floor((Date.parse(`${day(now)}T00:00:00Z`) - Date.parse(`${updated}T00:00:00Z`)) / 86_400_000);
  if (!(days >= 0)) return `saved ${updated}`;
  return `saved ${updated}, ${days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`}`;
}

/** What Harv does when a chat shows a note is out of date (the user, 2026-11-20: notes always end up outdated). */
const FIX_STALE =
  'Notes go out of date: when this chat shows one is wrong or old (the user says otherwise, something was sold, finished, changed or moved), update it with remember right away (only what changed) and say so in one line ("noted: …").';

/** "User's GPU!" → "users-gpu"; null if nothing usable is left. */
export function toSlug(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || null;
}

const oneLine = (s: string, max: number) => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const HEAD = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** A note's header fields (empty when it has none). */
function header(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of HEAD.exec(raw.trim())?.[1]?.split(/\r?\n/) ?? []) {
    const [, key, value] = /^(\w+):\s*(.*)$/.exec(line.trim()) ?? [];
    if (key && value?.trim()) fields.set(key.toLowerCase(), value.trim());
  }
  return fields;
}

/** Reads a note's header (if any); a note without one is described by its first line. */
export function parseMemory(name: string, raw: string, mtimeMs?: number): Memory {
  const content = raw.trim();
  const head = HEAD.exec(content);
  const fields = header(content);
  const body = (head ? content.slice(head[0].length) : content).trim();
  const keys = (fields.get('keys') ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  return {
    name,
    content,
    body,
    about: oneLine(fields.get('about') || body.split('\n').find((l) => l.trim()) || name, 160),
    keys,
    always: CORE.includes(name) || /^(true|yes)$/i.test(fields.get('always') ?? ''),
    ...(/^\d{4}-\d\d-\d\d$/.test(fields.get('updated') ?? '')
      ? { updated: fields.get('updated') }
      : mtimeMs !== undefined
        ? { updated: day(mtimeMs) }
        : {}),
  };
}

function serialize(m: { about?: string; keys?: string[]; always?: boolean; updated?: string; body: string }): string {
  const head = [
    m.about ? `about: ${oneLine(m.about, 160)}` : '',
    m.keys?.length ? `keys: ${m.keys.map((k) => k.replace(/[,\n]/g, ' ').trim()).join(', ')}` : '',
    m.always ? 'always: true' : '',
    m.updated ? `updated: ${m.updated}` : '',
  ].filter(Boolean);
  return (head.length ? `---\n${head.join('\n')}\n---\n` : '') + m.body.trim() + '\n';
}

export function listMemories(dir = MEMORY_DIR): Memory[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseMemory(f.slice(0, -3), readFileSync(join(dir, f), 'utf8'), statSync(join(dir, f)).mtimeMs));
}

/** The core notes that fit the budget (user-profile first); the rest go in the index. */
function split(memories: Memory[]): { full: Memory[]; indexed: Memory[] } {
  const core = memories.filter((m) => m.always).sort((a, b) => Number(b.name === 'user-profile') - Number(a.name === 'user-profile'));
  const full: Memory[] = [];
  let used = 0;
  for (const m of core) {
    if (used + m.body.length > ALWAYS_BUDGET) continue;
    full.push(m);
    used += m.body.length;
  }
  return { full, indexed: memories.filter((m) => !full.includes(m)) };
}

/** The memory block for the system prompt: core notes in full, an index of the rest. */
export function memoryContext(dir = MEMORY_DIR): string {
  const memories = listMemories(dir);
  if (memories.length === 0) return 'You have no saved memories yet.';
  const { full, indexed } = split(memories);
  const parts = [FIX_STALE, ...full.map((m) => `### ${m.name}\n${m.body}`)];
  if (indexed.length)
    parts.push(
      [
        '### Your other memories (index)',
        "A note's full text joins the user's message by itself when the message is about it ([From your memory: …]); a [Maybe in your memory: …] line only means a word matched. Before you answer anything that touches one of these and isn't in this chat yet (the user's things, people, plans, preferences, past decisions), read it with recall: never guess what a note says from its line here.",
        ...indexed.map((m) => `- ${m.name}: ${m.about}`),
      ].join('\n'),
    );
  return parts.join('\n\n');
}

/** The notes not in the prompt in full, as `name: about` lines (the classifier picks from these). */
export function memoryIndex(dir = MEMORY_DIR): Memory[] {
  return split(listMemories(dir)).indexed;
}

/** The core notes' size together, and whether they all fit in every prompt. */
export function memoryTotal(dir = MEMORY_DIR): { chars: number; fits: boolean } {
  const chars = listMemories(dir)
    .filter((m) => m.always)
    .reduce((n, m) => n + m.body.length, 0);
  return { chars, fits: chars <= ALWAYS_BUDGET };
}

/** Lower case without accents, so "Hodinky", "hodínky" and "hodinky" are one word. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = (s: string) => fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Words of a note's name that say nothing about its topic. */
const NAME_NOISE = new Set(['project', 'projects', 'setup', 'style', 'from', 'with', 'notes', 'backup', 'class', 'user', 'profile']);

/**
 * A note's trigger words: its keys; a note without keys falls back to the telling words of its name.
 * Name words next to keys were noise: "car-search-friends" came in for "my friend has a PS5" and
 * "search the web" (2026-11-21).
 */
function triggers(m: Memory): string[][] {
  const keys = m.keys.map(words).filter((k) => k.length);
  if (keys.length) return keys;
  const fromName = m.name
    .split('-')
    .filter((w) => w.length >= 4 && !NAME_NOISE.has(w))
    .map((w) => [w.replace(/s$/, '')]);
  return fromName;
}

/** One trigger word against one message word: short words exactly, 4+ letters also as the start of a longer form. */
const hit = (key: string, word: string) => (key.length >= 4 ? word.startsWith(key) : word === key);

/** The notes (not already in the prompt) whose trigger words are in `text`. */
export function matchMemories(text: string, memories: Memory[]): string[] {
  const said = words(text);
  if (!said.length) return [];
  return memories
    .filter((m) =>
      triggers(m).some((key) =>
        said.some((_, i) =>
          key.every((k, j) => {
            const w = said[i + j];
            return w !== undefined && hit(k, w);
          }),
        ),
      ),
    )
    .map((m) => m.name);
}

/** What a session's messages already brought in: notes in full, and notes only hinted at. */
export interface MemorySeen {
  shown: Set<string>;
  hinted: Set<string>;
}

/**
 * The note in front of a message, leaving out what this chat already has (`seen`, updated) and the core notes:
 * the full text of the notes the router's classifier picked (it reads what the message is about), and one
 * hint line for the notes only a key word touched. Key words alone used to bring the whole note and were
 * mostly wrong (review of 20–26 Nov: "stock volume bar" → investing, "menu windows" → the notebook's Windows
 * apps, "send Hi on Discord" → email), so Harv now decides from the hint and recalls the note when it fits,
 * as Claude Code reads its own memory files. Null when nothing new is needed.
 */
export function memoryNote(text: string, picked: readonly string[], seen: MemorySeen, dir = MEMORY_DIR): string | null {
  const indexed = memoryIndex(dir);
  const chosen = new Set(picked);
  const full = indexed.filter((m) => chosen.has(m.name) && !seen.shown.has(m.name));
  const hits = new Set(matchMemories(text, indexed));
  const hints = indexed.filter((m) => hits.has(m.name) && !chosen.has(m.name) && !seen.shown.has(m.name) && !seen.hinted.has(m.name));
  if (!full.length && !hints.length) return null;
  for (const m of full) seen.shown.add(m.name);
  for (const m of hints) seen.hinted.add(m.name);
  const parts: string[] = [];
  if (full.length) parts.push(`[From your memory (this message touches these notes). ${FIX_STALE}\n${full.map(fullNote).join('\n\n')}]`);
  if (hints.length)
    parts.push(
      `[Maybe in your memory (a word matched; only if this message is really about its thing, read it with recall, names: ["<name>"]): ${hints.map((m) => `${m.name} (${m.about})`).join('; ')}]`,
    );
  return parts.join('\n\n');
}

/** A note in full under its name and age. */
export const fullNote = (m: Memory) => `### ${m.name}${m.updated ? ` (${savedText(m.updated)})` : ''}\n${m.body}`;

/** Full notes by name, or every note mentioning all words of `search`. */
/** The recall tool's inputs as given (a name as a plain string, `query` for a name or search words) → recall's. */
export function recallArgs(
  names: string[] | string | undefined,
  search: string | undefined,
  query: string | undefined,
  dir = MEMORY_DIR,
): [string[], string | undefined] {
  const list = typeof names === 'string' ? [names] : (names ?? []);
  const q = query?.trim();
  if (!q) return [list, search];
  const slug = toSlug(q);
  if (slug && listMemories(dir).some((m) => m.name === slug)) return [[...list, q], search];
  return [list, search ?? q];
}

export function recall(names: string[], search: string | undefined, dir = MEMORY_DIR): Memory[] {
  const all = listMemories(dir);
  const wanted = new Set(names.map((n) => toSlug(n)).filter(Boolean));
  const terms = search ? words(search) : [];
  return all.filter(
    (m) =>
      wanted.has(m.name) ||
      (terms.length > 0 && terms.every((t) => fold(`${m.name} ${m.about} ${m.keys.join(' ')} ${m.body}`).includes(t))),
  );
}

export function remember(
  name: string,
  content: string,
  dir = MEMORY_DIR,
  meta: { about?: string; keys?: string[]; always?: boolean } = {},
): string {
  const slug = toSlug(name);
  if (!slug) throw new Error('The memory needs a name with letters or digits.');
  if (content.length > MAX_CHARS) throw new Error(`Keep a memory under ${MAX_CHARS} characters.`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  // A header given in the text wins; an update that leaves the header out keeps the note's old one.
  const given = header(content);
  const old = existsSync(path) ? header(readFileSync(path, 'utf8')) : new Map<string, string>();
  const field = (k: string) => given.get(k) ?? old.get(k);
  // Trigger words only grow: an update that sends a shorter list (Harv rewrote one live, 2026-11-20, and
  // dropped half) would make the note miss its topic later. New words join the old ones.
  const keys = [
    ...new Set([...(old.get('keys')?.split(',') ?? []), ...(meta.keys ?? given.get('keys')?.split(',') ?? [])].map((k) => k.trim())),
  ];
  writeFileSync(
    path,
    serialize({
      about: meta.about ?? field('about'),
      keys: keys.filter(Boolean),
      always: meta.always ?? /^(true|yes)$/i.test(field('always') ?? ''),
      updated: day(Date.now()),
      body: parseMemory(slug, content).body,
    }),
    'utf8',
  );
  return slug;
}

export function forget(name: string, dir = MEMORY_DIR): boolean {
  const slug = toSlug(name);
  const path = slug ? join(dir, `${slug}.md`) : null;
  if (!path || !existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Every memory's content by name, to notice changes made by other chats (or by hand). */
export function memorySnapshot(dir = MEMORY_DIR): Map<string, string> {
  return new Map(listMemories(dir).map((m) => [m.name, m.content]));
}

/** What changed between two snapshots, as a note for Claude; null when nothing did. */
export function memoryChanges(before: Map<string, string>, after: Map<string, string>): string | null {
  const lines: string[] = [];
  for (const [name, content] of after) {
    if (before.get(name) !== content)
      lines.push(`- ${before.has(name) ? 'updated' : 'saved'} "${name}": ${parseMemory(name, content).body}`);
  }
  for (const name of before.keys()) if (!after.has(name)) lines.push(`- forgot "${name}"`);
  return lines.length ? lines.join('\n') : null;
}

export const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export const memoryTools = [
  tool(
    'remember',
    'Save or update one of your long-term memories about the user (preferences, decisions, facts about their setup, people, plans, rules they taught you). One topic per note, short kebab-case name; saving an existing name replaces its text (leave out about/always to keep the old ones; keys you send are added to the existing ones, never replace them). Only the core notes are in every prompt; the rest load when their topic comes up, so give each a clear `about` and in `keys` the names and phrases that only that thing has. Never store secrets.',
    {
      name: z.string().describe('Short name, e.g. "coding-preferences"'),
      content: z.string().describe('The memory, short and factual'),
      about: z.string().optional().describe("One line: what the note holds and when it matters (shown in every prompt's index)"),
      keys: z
        .array(z.string())
        .optional()
        .describe(
          'Names and phrases that point to this note only, in every language the user uses (e.g. ["fitbit", "hodinky", "garmin", "watch face"]): brands, models, people, project and place names; never common words that come up in other talk ("car", "send", "windows", "install", "stock", "routine"). Stems like "hodin" match longer forms',
        ),
      always: z.boolean().optional().describe('In every prompt in full: only for facts nearly every chat needs'),
    },
    async ({ name, content, about, keys, always }) => {
      try {
        const slug = remember(name, content, MEMORY_DIR, { about, keys, always });
        const total = memoryTotal();
        return text(
          `Saved memory "${slug}".${total.fits ? '' : ` Your always-loaded notes now take ${total.chars} characters, over the ${ALWAYS_BUDGET} that fit in every chat: shorten them or make one a topic note (always: false).`}`,
        );
      } catch (err) {
        return { ...text((err as Error).message), isError: true };
      }
    },
  ),
  tool(
    'recall',
    "Read your memories in full: by name (from the index in your prompt), or every note mentioning all the words of `search`. Use it before answering anything about the user's things, people, plans or past decisions that isn't in this chat yet.",
    {
      names: z
        .union([z.array(z.string()), z.string()])
        .optional()
        .describe('Note names from the index, e.g. ["smartwatches"]'),
      search: z.string().optional().describe('Words every returned note must mention'),
      // Haiku called recall with `query` before it had loaded the schema, got "no memory matches" and answered
      // without the note (2026-11-26): a name or words under any of these keys still find it.
      query: z.string().optional().describe('A note name or search words'),
    },
    async ({ names, search, query }) => {
      const found = recall(...recallArgs(names, search, query));
      if (!found.length)
        return text(
          `No memory matches${search ? ` "${search}"` : ''}. Your notes: ${
            listMemories()
              .map((m) => m.name)
              .join(', ') || 'none'
          }.`,
        );
      return text(`${found.map(fullNote).join('\n\n')}\n\n${FIX_STALE}`);
    },
  ),
  tool('forget', 'Delete one of your memories that is wrong or no longer true.', { name: z.string() }, async ({ name }) =>
    forget(name) ? text(`Forgot "${toSlug(name)}".`) : { ...text(`No memory named "${name}".`), isError: true },
  ),
];
