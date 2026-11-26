import type { Tier } from '@harv/shared';
import { COMMITS, SEARCH_FIELD, SECRET_FIELD, SENDS } from './browser.ts';
import { saidWithoutNo } from './sending.ts';

// Desktop control (docs/PLAN.md §6t item 1): Windows-MCP's tools, judged by the gate. Looking at
// the screen is green. Anything that moves the mouse, types or switches windows is red; the gate asks
// only before a risky one the user's message didn't ask for outright (sending, buying, deleting, a
// secret field: desktopRisk, judged by what the last Snapshot says is there), even with "Ask before
// risky actions" off (the user's rule, 2026-11-09). Nobody to ask (a scheduled or background turn):
// refused. Windows-MCP's own shell, file, registry, process and web tools are never started
// (WINDOWS_MCP_TOOLS); if one shows up anyway it's blocked. App's launch_executable is judged in
// classify.ts as the same Start-Process command (launchVerdict): only what changes nothing runs here.

/** The name chats see the server under: its tools are mcp__desktop__<Tool>. */
export const DESKTOP_SERVER = 'desktop';
const PREFIX = `mcp__${DESKTOP_SERVER}__`;

/** Tools that only look (Notification shows a Windows toast; it changes nothing). */
const LOOKS = ['Snapshot', 'Screenshot', 'DisplayInventory', 'Wait', 'WaitFor', 'ControlStatus', 'Notification'];
/** Tools that act on the desktop. */
const ACTS = ['Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'MultiSelect', 'MultiEdit', 'App', 'Clipboard'];
/** The tools Windows-MCP is started with (an allow-list: tools a later version adds never appear by themselves). */
export const DESKTOP_TOOLS = [...LOOKS, ...ACTS];

export interface DesktopVerdict {
  tier: Tier;
  reason: string;
  summary: string;
}

export const isDesktopTool = (tool: string) => tool.startsWith(PREFIX);

const text = (v: unknown, max = 60) => {
  const s = typeof v === 'string' ? v : '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
const truthy = (v: unknown) => v === true || v === 'true';

/** Where a click or a scroll lands: an element from the last Snapshot, or a point on the screen. */
function target(input: Record<string, unknown>): string {
  if (typeof input.label === 'number') return `element #${input.label} from the last snapshot`;
  if (Array.isArray(input.loc)) return `(${input.loc.join(', ')})`;
  if (typeof input.loc === 'string' && input.loc) return input.loc;
  return 'where the mouse is';
}

export function classifyDesktop(tool: string, input: Record<string, unknown>): DesktopVerdict {
  const name = tool.slice(PREFIX.length);
  const acts = (summary: string): DesktopVerdict => ({
    tier: 'red',
    reason: 'Uses your mouse or keyboard.',
    summary,
  });
  if (LOOKS.includes(name)) return { tier: 'green', reason: 'Only reads the screen.', summary: `desktop: ${name}` };
  switch (name) {
    case 'Click': {
      const button = input.button && input.button !== 'left' ? `${String(input.button)}-` : '';
      const times = typeof input.clicks === 'number' && input.clicks > 1 ? ` ×${input.clicks}` : '';
      return acts(`${button}click ${target(input)}${times}`);
    }
    case 'Type':
      return acts(
        `type “${text(input.text)}”${input.loc !== undefined || input.label !== undefined ? ` into ${target(input)}` : ''}${truthy(input.press_enter) ? ' and press Enter' : ''}`,
      );
    case 'Scroll':
      return acts(`scroll ${typeof input.direction === 'string' ? input.direction : 'down'} at ${target(input)}`);
    case 'Move':
      return acts(truthy(input.drag) ? `drag to ${target(input)}` : `move the mouse to ${target(input)}`);
    case 'Shortcut':
      return acts(`press ${text(input.shortcut, 40)}`);
    case 'MultiSelect':
      return acts('select several items');
    case 'MultiEdit':
      return acts('fill in several fields');
    case 'Clipboard':
      if (input.mode === 'get') return { tier: 'green', reason: 'Only reads the clipboard.', summary: 'desktop: read the clipboard' };
      return acts(`copy “${text(input.text)}” to the clipboard`);
    case 'App': {
      const mode = typeof input.mode === 'string' ? input.mode : 'launch';
      const app = text(input.name, 40) || 'an app';
      if (mode === 'launch_executable')
        return {
          tier: 'blocked',
          reason: 'Running a program by its path is judged like the same command in the shell.',
          summary: `run ${text(input.executable, 80)}`,
        };
      if (mode === 'switch') return acts(`switch to ${app}`);
      if (mode === 'resize') return acts(`move or resize ${app}`);
      return acts(`open ${app}`);
    }
  }
  return {
    tier: 'blocked',
    reason: `${name} isn’t enabled in Harv’s desktop control; use Harv’s own tools for that (they’re checked and backed up).`,
    summary: `desktop: ${name}`,
  };
}

/** A desktop call that takes over the mouse or keyboard (the pill). */
export const actsOnDesktop = (tool: string, input: Record<string, unknown>) =>
  isDesktopTool(tool) && classifyDesktop(tool, input).tier === 'red';

// ── What an action hits (the user's rule, 2026-11-09: desktop control asks only for risky actions
// they didn't ask for outright, like the browser's rules) ──────────────────────────────────────────

/** A button, field or other control from the last Snapshot, at its center. */
export interface DesktopElement {
  x: number;
  y: number;
  type: string;
  name: string;
  window: string;
}

/** The text of an MCP tool's result (a string, content blocks, or `{ content }`). */
export function responseText(response: unknown): string {
  if (typeof response === 'string') return response;
  const blocks = Array.isArray(response)
    ? response
    : response && typeof response === 'object' && Array.isArray((response as { content?: unknown }).content)
      ? (response as { content: unknown[] }).content
      : [];
  return blocks
    .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .join('\n');
}

/**
 * The elements in a Snapshot: the interactive ones in tree order, then the scrollable ones (a Click's
 * `label` is an index into that list; best effort, Harv clicks by the coordinates the tree shows).
 * Windows-MCP 0.8.8 sends its text as a JSON list of strings, with a UI tree like
 * `    │   ├── window "Discord"` and `    │   │   ├── (812,940) button "Send"  [action: click]`.
 */
export function parseSnapshot(text: string): DesktopElement[] {
  const interactive: DesktopElement[] = [];
  const scrollable: DesktopElement[] = [];
  let window = '';
  for (const line of snapshotText(text).split(/\r?\n/)) {
    const w = /^[\s│]*(?:[├└]──\s*)?window "(.*)"\s*$/.exec(line);
    if (w) {
      window = w[1]!;
      continue;
    }
    const m = /^[\s│]*[├└]──\s*\((-?\d+),(-?\d+)\)\s+(.+?)\s+"(.*)"\s+\[action:\s*([\w-]+)\]/.exec(line);
    if (m) (m[5] === 'scroll' ? scrollable : interactive).push({ x: Number(m[1]), y: Number(m[2]), type: m[3]!, name: m[4]!, window });
  }
  return [...interactive, ...scrollable];
}

/** Windows-MCP wraps its text in a JSON list of strings (`["\n    Cursor Position: …"]`). */
function snapshotText(text: string): string {
  const t = text.trim();
  if (!t.startsWith('[')) return text;
  try {
    const parts: unknown = JSON.parse(t);
    if (Array.isArray(parts)) return parts.filter((p): p is string => typeof p === 'string').join('\n');
  } catch {
    // Not JSON: the text itself.
  }
  return text;
}

/** The element an action lands on: by label, or the nearest center within a few pixels of its point. */
export function elementAt(input: Record<string, unknown>, elements: DesktopElement[]): DesktopElement | undefined {
  if (typeof input.label === 'number') return elements[input.label];
  const p = point(input.loc);
  if (!p) return undefined;
  let best: DesktopElement | undefined;
  let bestD = 8;
  for (const el of elements) {
    const d = Math.hypot(el.x - p[0], el.y - p[1]);
    if (d <= bestD) [best, bestD] = [el, d];
  }
  return best;
}

/** Kinds of risky actions, with the words that count as the user asking for that kind outright. */
const KINDS = {
  send: /(?<![\p{L}])(send|post|publish|tweet|reply|comment on|share|write (to|back)|dm|submit|pošli|posli|pošlite|odošli|odosli|(napíš|napis) (mu|jej|im|na)|odpovedz|zdieľaj|zdielaj|zverejni)/iu,
  buy: /(?<![\p{L}])(buy|purchase|order|check ?out|pay|subscribe|donate|book|reserve|transfer|prevod|previesť|previest|kúp|kup|objednaj|zaplať|zaplat|predplať|rezervuj)/iu,
  delete: /(?<![\p{L}])(delete|remove|erase|uninstall|unsubscribe|zmaž|zmaz|vymaž|vymaz|odstráň|odstran|odinštaluj|odinstaluj)/iu,
  commit:
    /(?<![\p{L}])(confirm|accept|agree|apply|install|sign ?up|register|upload|transfer|save|potvrď|potvrd|súhlas|nainštaluj|nainstaluj|zaregistruj|nahraj|ulož|uloz)/iu,
  secret: /(?<![\p{L}])(password|passcode|pin|card number|heslo|kód karty)/iu,
};
export type RiskKind = keyof typeof KINDS;

/** Which kind of commitment a button's name is (Send, Buy now, Delete…), if any. */
export function kindOf(name: string): RiskKind | null {
  if (!COMMITS.test(name)) return null;
  // Deleting first: "Delete message" deletes, it doesn't send.
  if (KINDS.delete.test(name)) return 'delete';
  if (KINDS.buy.test(name)) return 'buy';
  if (SENDS.test(name)) return 'send';
  return 'commit';
}

/** A field where typing writes to someone (a chat box, a reply, a post). */
const MESSAGE_FIELD = /(message|chat|reply|comment|compose|write|tweet|post|status|caption|správ|sprav|odpove|komentár|komentar)/i;
const isSearchField = (el: DesktopElement) => SEARCH_FIELD.test(el.name) || /(address|url|omnibox|adres)/i.test(el.name);

export interface DesktopRisk {
  kind: RiskKind;
  /** What makes it risky, in plain words (on the card). */
  why: string;
}

/**
 * Whether a desktop action can send, buy, delete, commit or type a secret for the user. What it hits
 * comes from the last Snapshot; Enter in a field Harv can't see counts as maybe sending.
 */
/** A Type that lands in a field the last Snapshot didn't show. */
export const typesUnseen = (tool: string, input: Record<string, unknown>, elements: DesktopElement[]) =>
  tool === `${PREFIX}Type` && !elementAt(input, elements);

export function desktopRisk(
  tool: string,
  input: Record<string, unknown>,
  elements: DesktopElement[],
  /** Harv typed into a field it can't see since its last Snapshot (Discord, Chrome: no elements). */
  afterUnseenType = false,
): DesktopRisk | null {
  const name = tool.slice(PREFIX.length);
  const el = elementAt(input, elements);
  const where = el ? ` in ${el.window || 'a window'}` : '';
  switch (name) {
    case 'Click': {
      if (input.clicks === 0) return null;
      // Type a message, then click Send, in an app that shows no elements (the full review, S13; the user's pick).
      if (!el) return afterUnseenType ? { kind: 'send', why: 'Clicks after typing in a window Harv can’t read: that may send it.' } : null;
      const kind = kindOf(el.name);
      return kind ? { kind, why: `Clicks “${el.name}”${where}.` } : null;
    }
    case 'Type': {
      if (el && SECRET_FIELD.test(el.name)) return { kind: 'secret', why: `Types into the “${el.name}” field${where}.` };
      if (!truthy(input.press_enter) || (el && isSearchField(el))) return null;
      if (!el) return { kind: 'send', why: 'Types and presses Enter in a field Harv can’t see: that may send it.' };
      return MESSAGE_FIELD.test(el.name) || MESSAGE_FIELD.test(el.type)
        ? { kind: 'send', why: `Types into “${el.name || el.type}”${where} and presses Enter: that sends it.` }
        : null;
    }
    case 'Shortcut': {
      const keys = typeof input.shortcut === 'string' ? input.shortcut.toLowerCase().replace(/\s+/g, '') : '';
      if (/(^|\+)(ctrl|control)\+(enter|return)$/.test(keys) || /^(enter|return)$/.test(keys))
        return { kind: 'send', why: `Presses ${input.shortcut as string}: that may send or submit what's open.` };
      if (/(^|\+)(delete|del)$/.test(keys) && keys.includes('shift'))
        return { kind: 'delete', why: `Presses ${input.shortcut as string}: deletes for good, past the Recycle Bin.` };
      return null;
    }
    case 'MultiEdit': {
      const fields = Array.isArray(input.locs) ? input.locs : [];
      for (const loc of fields) {
        const f = elementAt({ loc }, elements);
        if (f && SECRET_FIELD.test(f.name)) return { kind: 'secret', why: `Fills in the “${f.name}” field${where}.` };
      }
      return null;
    }
  }
  return null;
}

/** The user's own message asked for this kind of action outright ("send him hi", "buy it", "zmaž to"). */
/** Whole words or phrases in any language, with inflections listed (the full review, S12). */
const words = (body: string) => new RegExp(`(?<![\\p{L}\\d])(?:${body})(?![\\p{L}\\d])`, 'iu');

/**
 * What in the user's message asks for each risky kind outright. Stricter than the button words (KINDS):
 * whole words ("postgres" isn't "post", "bookmark" isn't "book"), "order"/"book"/"pin" only as a
 * request, and not after a "don't" (saidWithoutNo). Slovak verbs keep their stem match (their endings vary).
 */
const ASKED: Record<RiskKind, RegExp[]> = {
  send: [
    words(
      'send|sends|sending|post|posts|posting|publish|publishes|publishing|tweet|reply|replies|replying|comment on|share|shares|sharing|write (to|back)|dm|submit|submits|submitting',
    ),
    /(?<![\p{L}])(pošli|posli|pošlite|odošli|odosli|(napíš|napis) (mu|jej|im|na)|odpovedz|zdieľaj|zdielaj|zverejni)/iu,
  ],
  buy: [
    words(
      'buy|buys|buying|purchase|purchases|purchasing|order (it|this|that|them|a|an|the|one|some|me)|check ?out|pay|pays|paying|subscribe|subscribes|donate|book (a|an|the|it|this|that|me|us)|reserve|transfer',
    ),
    /(?<![\p{L}])(kúp|kup|objednaj|zaplať|zaplat|predplať|rezervuj|prevod|previesť|previest)/iu,
  ],
  delete: [
    words('delete|deletes|deleting|remove|removes|removing|erase|erases|uninstall|uninstalls|unsubscribe'),
    /(?<![\p{L}])(zmaž|zmaz|vymaž|vymaz|odstráň|odstran|odinštaluj|odinstaluj)/iu,
  ],
  commit: [
    words('confirm|accept|agree|apply|install|sign ?up|register|upload|transfer|save'),
    /(?<![\p{L}])(potvrď|potvrd|súhlas|nainštaluj|nainstaluj|zaregistruj|nahraj|ulož|uloz)/iu,
  ],
  secret: [words('password|passcode|pin (code|number)|card number'), /(?<![\p{L}])(heslo|kód karty)/iu],
};

export const askedForRisk = (risk: DesktopRisk, message: string) => ASKED[risk.kind].some((re) => saidWithoutNo(re, message));

// ── Monitors (the user's wish, 2026-11-06: Harv works on one monitor, the smaller one unless they
// pick another in Settings, and on the others only when they say so) ─────────────────────────────

/** A monitor in Windows-MCP's coordinates: one virtual desktop across all monitors, physical pixels. */
export interface Monitor {
  device: string;
  primary: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The monitor Harv works on, with a name the user would use ("right", "left · main"). */
export interface WorkArea extends Monitor {
  label: string;
  /** Snapshot/Screenshot's `region` for it: [left, top, right, bottom]. */
  region: [number, number, number, number];
  /** How many monitors there are (with one, nothing is limited). */
  count: number;
}

const area = (m: Monitor) => (m.right - m.left) * (m.bottom - m.top);

/** "left", "right" or "middle" by position, "· main" for the primary one ("your monitor" when there's one). */
export function monitorLabel(m: Monitor, all: Monitor[]): string {
  if (all.length < 2) return 'your monitor';
  const xs = all.map((x) => x.left);
  const where = m.left === Math.min(...xs) ? 'left' : m.left === Math.max(...xs) ? 'right' : 'middle';
  return m.primary ? `${where} · main` : where;
}

/** The monitor the user picked (Settings › Desktop control), else the smallest one. */
export function workArea(all: Monitor[], chosen = ''): WorkArea | null {
  if (!all.length) return null;
  const pick =
    all.find((m) => m.device === chosen) ?? [...all].sort((a, b) => area(a) - area(b) || Number(a.primary) - Number(b.primary))[0]!;
  return { ...pick, label: monitorLabel(pick, all), region: [pick.left, pick.top, pick.right, pick.bottom], count: all.length };
}

export const contains = (m: Monitor, [x, y]: [number, number]) => x >= m.left && x < m.right && y >= m.top && y < m.bottom;

/** A point from a tool's input: [x, y] or "x,y" / "[x, y]". */
function point(v: unknown): [number, number] | null {
  if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number')) return [v[0] as number, v[1] as number];
  if (typeof v === 'string') {
    const m = /^\s*\[?\s*(-?\d+)\s*,\s*(-?\d+)\s*\]?\s*$/.exec(v);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  return null;
}

/** Every screen point a desktop action lands on or moves a window to (labels from a Snapshot have none). */
export function pointsOf(input: Record<string, unknown>): [number, number][] {
  const out: [number, number][] = [];
  for (const key of ['loc', 'from_loc', 'window_loc']) {
    const p = point(input[key]);
    if (p) out.push(p);
  }
  let locs = input.locs;
  if (typeof locs === 'string') {
    try {
      locs = JSON.parse(locs);
    } catch {
      locs = undefined;
    }
  }
  if (Array.isArray(locs))
    for (const l of locs) {
      const p = point(l);
      if (p) out.push(p);
    }
  return out;
}

/**
 * The user's message names a monitor ("on the left monitor", "the main screen", "both displays",
 * "na ľavom monitore"): then Harv may work on any of them in this reply.
 */
const NAMES_A_MONITOR = [
  /(?<![\p{L}])(left|right|middle|main|primary|other|second|first|big(ger)?|large(r)?|small(er)?|both|all|each)\s+(monitor|screen|display)s?(?![\p{L}])/iu,
  /(?<![\p{L}])(monitor|screen|display)\s*(#?\d)(?![\p{L}\d])/iu,
  /(?<![\p{L}])(ľav|lav|prav|hlavn|druh|prv|veľk|velk|men[sš]|ob[ae]|obidv|v[sš]etk)\p{L}*\s+(monitor|obrazovk|displej)\p{L}*/iu,
];
export const namesAMonitor = (message: string) => NAMES_A_MONITOR.some((re) => re.test(message));
