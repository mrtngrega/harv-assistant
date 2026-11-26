import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { IS_WINDOWS } from '../platform.ts';
import { fullPath, tempDirs } from './paths.ts';
import { isSensitivePath } from './sensitive.ts';
import { unquote, words } from './shell.ts';

// Where a command really points (the full review, shared change A): one resolver for a word and one
// walker for a command, so the secret, wipe and delete checks judge the place on disk, not the
// spelling (`~`, `$HOME`, `%USERPROFILE%`, `/c/…`, `/mnt/c/…`, a `cd` first, a short name, a link).

const home = homedir();

/** `~`, `$HOME`, `${HOME}`, `$env:NAME`, `${env:NAME}`, `%NAME%`, `$NAME` replaced by their values (unknown ones stay). */
export function expandVars(word: string, vars: Map<string, string> = new Map()): string {
  const value = (name: string) =>
    vars.get(name.toLowerCase()) ?? (/^(home|userprofile)$/i.test(name) ? home : (process.env[name] ?? process.env[name.toUpperCase()]));
  return word
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/\$\{?env:(\w+)\}?/gi, (m, n: string) => value(n) ?? m)
    .replace(/%(\w+)%/g, (m, n: string) => value(n) ?? m)
    .replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a: string | undefined, b: string | undefined) => value((a ?? b)!) ?? m);
}

export interface Resolved {
  /** The absolute path (the folder itself when `all`). */
  path: string;
  /** Where it really is on disk (short names, junctions, links expanded), when it exists. */
  real?: string;
  /** A variable, substitution or backtick is still in it: the gate can't see where it points. */
  opaque: boolean;
  /** The last part was only wildcards or dots (`*`, `*.*`, `.`, `.*`): everything in the folder. */
  all: boolean;
}

const ONLY_WILDCARDS = /^(\*+|\*\.\*|\.|\.\*|\*\*)$/;

/** The real path of an existing file or folder, or undefined. */
export function realPath(p: string): string | undefined {
  try {
    return existsSync(p) ? realpathSync.native(p) : undefined;
  } catch {
    return undefined;
  }
}

/** One word of a command, resolved against `base` (and the command's own simple variables). */
export function resolveWord(word: string, base: string, vars?: Map<string, string>): Resolved {
  let w = expandVars(unquote(word.trim()), vars);
  const opaque = /\$|`|%\w+%/.test(w);
  // WSL's view of a Windows drive.
  if (IS_WINDOWS) w = w.replace(/^\/mnt\/([a-z])(?=\/|$)/i, '/$1');
  const parts = w.split(/[\\/]+/);
  let all = false;
  while (parts.length > 1 && ONLY_WILDCARDS.test(parts.at(-1)!)) {
    parts.pop();
    all = true;
  }
  if (parts.length === 1 && ONLY_WILDCARDS.test(parts[0]!)) {
    parts[0] = '.';
    all = true;
  }
  let joined = parts.join('/');
  if (joined === '' || /^[a-z]:$/i.test(joined)) joined += '/';
  const path = fullPath(joined, base);
  return { path, real: opaque ? undefined : realPath(path), opaque, all };
}

/** A login secret by its path or by where it really is (a short name, a junction, a link: the full review, S2). */
export function isSecretFile(p: string): boolean {
  if (isSensitivePath(p)) return true;
  const real = realPath(p);
  return real !== undefined && real !== p && isSensitivePath(real);
}

export interface Segment {
  /** The words, unquoted, with sudo/env/`&` and assignments in front taken off. */
  words: string[];
  /** The program, lowercased, without `.exe`. */
  program: string;
  /** The folder it runs in (after any `cd` before it); undefined after a `cd` the gate can't follow. */
  base: string | undefined;
  /** It receives the output of the segment before it (a pipe). */
  piped: boolean;
  /** The segment's text as written. */
  text: string;
  /** The command's own simple variables known at this point. */
  vars: Map<string, string>;
}

/** A command split at `;`, `&&`, `||`, newlines and pipes, keeping which parts read a pipe. Quotes don't split. */
export function splitWithPipes(command: string): { text: string; piped: boolean }[] {
  const out: { text: string; piped: boolean }[] = [];
  let current = '';
  let quote = '';
  let piped = false;
  const push = (nextPiped: boolean) => {
    if (current.trim()) out.push({ text: current.trim(), piped });
    current = '';
    piped = nextPiped;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = '';
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '|' && command[i + 1] !== '|') push(true);
    else if (ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      i++;
      push(false);
    } else if (ch === ';' || ch === '\n' || ch === '\r') push(false);
    else current += ch;
  }
  push(false);
  return out;
}

/** A word put back in quotes when it has spaces, so an unwrapped command splits as it was written. */
const requote = (w: string) => (/\s/.test(w) && !/^["']/.test(w) ? `"${w}"` : w);

const CD = /^(cd|chdir|set-location|sl|pushd)$/i;
const PREFIX = /^(sudo|doas|env|nohup|time|nice|&|command|exec|builtin)$/i;
/** `x=1`, `$x = 'a'`, `$x='a'`. */
const ASSIGN_BASH = /^([A-Za-z_]\w*)=(.*)$/;

/**
 * The text another shell runs: `cmd /c X`, `wsl [-d n] [-e|--] X`, `bash -c 'X'`, `sh -c`, `powershell
 * [-NoProfile…] -Command X`, `pwsh -c X`. Undefined when the segment isn't one of those.
 */
function innerCommand(ws: string[], program: string): string | undefined {
  const rest = ws.slice(1);
  if (program === 'cmd') {
    const i = rest.findIndex((w) => /^\/[ck]$/i.test(w));
    return i >= 0
      ? rest
          .slice(i + 1)
          .map(requote)
          .join(' ')
      : undefined;
  }
  if (program === 'wsl') {
    let i = 0;
    while (i < rest.length && /^(-d|--distribution|-u|--user|--cd)$/i.test(rest[i]!)) i += 2;
    if (/^(-e|--exec|--)$/.test(rest[i] ?? '')) i++;
    return rest.slice(i).map(requote).join(' ') || undefined;
  }
  if (/^(bash|sh|zsh|dash|ksh)$/.test(program)) {
    const i = rest.findIndex((w) => /^-\w*c$/.test(w));
    return i >= 0 ? rest[i + 1] : undefined;
  }
  if (program === 'powershell' || program === 'pwsh') {
    const i = rest.findIndex((w) => /^-(c|command)$/i.test(w));
    if (i >= 0)
      return rest
        .slice(i + 1)
        .map(requote)
        .join(' ');
    // `powershell "Remove-Item …"`: the first plain word starts the command.
    const first = rest.findIndex((w) => !w.startsWith('-'));
    const flagValue = first > 0 && /^-(executionpolicy|ep|windowstyle|w|file|f|encodedcommand|e\w*)$/i.test(rest[first - 1]!);
    return first >= 0 && !flagValue && !/\.ps1$/i.test(rest[first]!) ? rest.slice(first).map(requote).join(' ') : undefined;
  }
  return undefined;
}

/**
 * Each part of a command with the folder it runs in: follows `cd`, unwraps sudo/env/`cmd /c`/`wsl`/
 * `bash -c`/`powershell -Command` (two levels), and follows the command's own simple variables
 * (`tmp=/x`, `$f = 'a.txt'`, `d=$(mktemp -d)`: the temp folder).
 */
export function walkCommand(command: string, cwd: string, depth = 0, vars = new Map<string, string>()): Segment[] {
  const out: Segment[] = [];
  let base: string | undefined = cwd;
  for (const { text, piped } of splitWithPipes(command)) {
    let raw: string[] = [...words(text)];
    // PowerShell `$x = 'a'` / `$x='a'`.
    const ps = /^\$([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(text);
    if (ps) {
      const value = unquote(ps[2]!.trim());
      if (!/[$`(]/.test(value)) vars.set(ps[1]!.toLowerCase(), value);
      continue;
    }
    // Bash assignments in front (`x=1 y=2 cmd`, or alone).
    while (raw.length && ASSIGN_BASH.test(raw[0]!)) {
      const [, name, value] = ASSIGN_BASH.exec(raw[0]!)!;
      const v = unquote(value!);
      if (/^\$\(\s*mktemp\b/.test(v)) vars.set(name!.toLowerCase(), tempDirs()[0]!);
      else if (!/[$`]/.test(v)) vars.set(name!.toLowerCase(), v);
      raw = raw.slice(1);
    }
    while (raw.length && PREFIX.test(unquote(raw[0]!))) {
      raw = raw.slice(1);
      while (raw.length && /^-/.test(raw[0]!)) raw = raw.slice(1);
      while (raw.length && ASSIGN_BASH.test(raw[0]!)) raw = raw.slice(1);
    }
    if (raw.length === 0) continue;
    const ws = raw.map((w) => unquote(w));
    const program = (ws[0] ?? '').toLowerCase().replace(/\.exe$/, '');
    if (CD.test(program)) {
      const target = ws.slice(1).find((w) => !w.startsWith('-'));
      if (!target || target === '-') base = target ? undefined : home;
      else if (base !== undefined) {
        const r = resolveWord(target, base, vars);
        base = r.opaque ? undefined : r.path;
      }
      continue;
    }
    const inner = depth < 2 ? innerCommand(ws, program) : undefined;
    if (inner !== undefined && base !== undefined) {
      out.push(...walkCommand(inner, base, depth + 1, vars));
      continue;
    }
    out.push({ words: ws, program, base, piped, text, vars: new Map(vars) });
  }
  return out;
}

/** cmd.exe programs, whose `/s` `/q` are options, not paths. */
const CMD_FLAGS = /^(rd|rmdir|del|erase|dir|copy|xcopy|robocopy|findstr|type|move|attrib|cipher|format|takeown|icacls|more)$/;

/** The words of a segment that name a place (not flags), each resolved. */
export function targetsOf(segment: Segment): Resolved[] {
  if (segment.base === undefined) return [];
  const out: Resolved[] = [];
  const ws = segment.words;
  for (let i = 1; i < ws.length; i++) {
    let w = ws[i]!;
    if (/^-(path|literalpath|lp)$/i.test(w)) continue;
    if (/^--?[\w-]+=/.test(w)) w = w.slice(w.indexOf('=') + 1);
    else if (w.startsWith('-') || (CMD_FLAGS.test(segment.program) && /^\/[a-z?]+(:\S*)?$/i.test(w))) continue;
    for (const part of w.split(/\s*,\s*/)) if (part) out.push(resolveWord(part, segment.base, segment.vars));
  }
  return out;
}

export const HOME = home;
