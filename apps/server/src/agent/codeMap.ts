// A code map for the user's projects (docs/PLAN.md §6ae item 2, in the spirit of Graphify and seed's BASE,
// without their hooks or cloud): every file with what it holds (its top comment, its main functions and
// classes), grouped by folder. Made from the files alone, no model call, so it costs no plan usage. It lives
// in ~/.harv/codemaps (never in the user's repo); a project chat is told where, and reads the part it needs
// instead of searching wide. Built when a project chat starts, refreshed after a turn that changed files.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { HARV_HOME } from '../paths.ts';

const run = promisify(execFile);

/** Folders never mapped when the project isn't a git repo (git's own ignore list covers the rest). */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'out',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.idea',
  '.vscode',
  'coverage',
  '.godot',
  'bin',
  'obj',
]);
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|.*\.min\.(js|css)|.*\.map)$/i;
const TEST_FILE = /(\.(test|spec)\.\w+$|^test_.*\.py$|_test\.(py|go)$)/i;
const MAX_FILES = 2500;
const MAX_FILE_BYTES = 400_000;
const MAX_SYMBOLS = 14;
const MAX_MAP_CHARS = 90_000;

type Lang = 'js' | 'py' | 'rs' | 'go' | 'cs' | 'lua' | 'gd' | 'sh' | 'ps';
const LANG: Record<string, Lang> = {
  '.ts': 'js',
  '.tsx': 'js',
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.vue': 'js',
  '.svelte': 'js',
  '.py': 'py',
  '.rs': 'rs',
  '.go': 'go',
  '.cs': 'cs',
  '.java': 'cs',
  '.kt': 'cs',
  '.lua': 'lua',
  '.gd': 'gd',
  '.sh': 'sh',
  '.ps1': 'ps',
};

const SYMBOLS: Record<Lang, RegExp[]> = {
  js: [
    /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|abstract\s+class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
    /^class\s+([A-Za-z_$][\w$]*)/,
  ],
  py: [/^(?:async\s+)?def\s+(\w+)/, /^class\s+(\w+)/],
  rs: [/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|mod|type)\s+(\w+)/, /^(?:async\s+)?fn\s+(\w+)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, /^type\s+(\w+)/],
  cs: [
    /^\s*(?:public|internal|protected)?\s*(?:static\s+|abstract\s+|sealed\s+|partial\s+|data\s+)*(?:class|interface|record|enum|struct|object)\s+(\w+)/,
  ],
  lua: [/^(?:local\s+)?function\s+([\w.:]+)/],
  gd: [/^class_name\s+(\w+)/, /^func\s+(\w+)/],
  sh: [/^(?:function\s+)?([\w-]+)\s*\(\)\s*\{/],
  ps: [/^function\s+([\w-]+)/i],
};

/** The file's purpose: its first comment (or docstring) line near the top, if it has one. */
export function purpose(text: string): string {
  const lines = text.split(/\r?\n/).slice(0, 20);
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? '').trim();
    if (!l || l.startsWith('#!') || /^(['"])use (strict|client)\1;?$/.test(l) || /^# -\*-/.test(l)) continue;
    const m =
      /^(?:\/\/+|#+|--+|\*)\s*(.+)$/.exec(l) ?? /^\/\*\*?\s*(.*?)\s*(?:\*\/)?$/.exec(l) ?? /^(?:"""|''')\s*(.*?)\s*(?:"""|''')?$/.exec(l);
    if (!m) return '';
    // The comment's first sentence, over its next few lines when it wraps.
    let s = (m[1] ?? '').replace(/\*\/\s*$/, '').trim();
    for (let j = i + 1; j < Math.min(lines.length, i + 4) && !/[.!?:]$/.test(s); j++) {
      const next = /^\s*(?:\/\/+|#+|--+|\*(?!\/))\s*(.*)$/
        .exec(lines[j] ?? '')?.[1]
        ?.replace(/\*\/\s*$/, '')
        .trim();
      if (!next) break;
      s = s ? `${s} ${next}` : next;
    }
    if (!s || /^(eslint|prettier|@ts-|type:|noqa|pylint|-\*-|region|SPDX|Copyright|\(c\))/i.test(s)) return '';
    const sentence = /^(.{20,}?[.!?])(?:\s|$)/.exec(s)?.[1];
    if (sentence && sentence.length <= 160) s = sentence;
    return s.length > 160 ? `${s.slice(0, 157)}…` : s;
  }
  return '';
}

/** Top-level names a file defines (exported ones first in JS/TS), at most MAX_SYMBOLS. */
export function symbols(text: string, lang: Lang): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const re of SYMBOLS[lang]) {
      const m = re.exec(line);
      const name = m?.[1];
      if (name && !out.includes(name) && name !== 'main' && name !== '__init__') {
        out.push(name);
        break;
      }
    }
    if (out.length > MAX_SYMBOLS) break;
  }
  return out.length > MAX_SYMBOLS ? [...out.slice(0, MAX_SYMBOLS), '…'] : out;
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    return (await run('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true })).stdout;
  } catch {
    return null;
  }
}

/** The project's files (relative, forward slashes): git's tracked and new ones, else a walk. */
async function listFiles(root: string): Promise<string[]> {
  const listed = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
  if (listed !== null)
    return listed
      .split('\n')
      .filter(Boolean)
      .slice(0, MAX_FILES * 2);
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 12 || out.length >= MAX_FILES * 2) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
      } else if (e.isFile()) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  await walk(root, 0);
  return out;
}

/** What changes when files change: git's HEAD and status, else the newest modified time. */
export async function fingerprint(root: string): Promise<string> {
  const head = await git(root, ['rev-parse', 'HEAD']);
  const status = head !== null ? await git(root, ['status', '--porcelain', '--untracked-files=all']) : null;
  if (head !== null && status !== null) {
    // Status alone misses a second edit to an already-changed file: add those files' sizes and times.
    const changed = status
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .slice(0, 400);
    const stamps = await Promise.all(
      changed.map(async (f) => {
        try {
          const s = await stat(join(root, f.replace(/^"|"$/g, '')));
          return `${f}:${s.size}:${Math.round(s.mtimeMs)}`;
        } catch {
          return `${f}:gone`;
        }
      }),
    );
    return createHash('sha1').update(head).update(status).update(stamps.join('|')).digest('hex').slice(0, 16);
  }
  const files = await listFiles(root);
  let newest = 0;
  for (const f of files.slice(0, MAX_FILES)) {
    try {
      newest = Math.max(newest, (await stat(join(root, f))).mtimeMs);
    } catch {
      /* gone meanwhile */
    }
  }
  return createHash('sha1')
    .update(`${files.length}:${Math.round(newest)}`)
    .digest('hex')
    .slice(0, 16);
}

/** The map as Markdown. */
export async function buildCodeMap(root: string, name = basename(root), print = ''): Promise<string> {
  const all = (await listFiles(root)).filter((f) => !SKIP_FILES.test(f));
  const files = all.slice(0, MAX_FILES);
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
    byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
  }
  const lines = [
    `# Code map: ${name}`,
    '',
    `<!-- fingerprint: ${print} -->`,
    `Made by Harv from the files (no model; ${new Date().toISOString().slice(0, 16).replace('T', ' ')}): each folder, its files, a file's top comment and the main names it defines. The project's own docs (CLAUDE.md, a plan, a code map it keeps) come first; this is for finding where things are.`,
    '',
  ];
  if (all.length > files.length) lines.push(`(${all.length} files; the first ${files.length} are mapped.)`, '');
  for (const dir of [...byDir.keys()].sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)))) {
    const inDir = byDir.get(dir)!.sort();
    lines.push(`## ${dir === '.' ? '(root)' : `${dir}/`}`);
    const plain: string[] = [];
    const tests: string[] = [];
    for (const f of inDir) {
      const lang = LANG[extname(f).toLowerCase()];
      const file = basename(f);
      if (lang && TEST_FILE.test(file)) {
        tests.push(file);
        continue;
      }
      if (!lang) {
        plain.push(file);
        continue;
      }
      let text = '';
      try {
        const full = join(root, f);
        if ((await stat(full)).size <= MAX_FILE_BYTES) text = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      const what = purpose(text);
      const names = symbols(text, lang);
      lines.push(`- \`${file}\`${what ? `: ${what}` : ''}${names.length ? ` [${names.join(', ')}]` : ''}`);
    }
    if (tests.length) lines.push(`- tests: ${tests.join(', ')}`);
    if (plain.length) {
      const shown = plain.slice(0, 25);
      lines.push(`- also: ${shown.join(', ')}${plain.length > shown.length ? `, +${plain.length - shown.length} more` : ''}`);
    }
    lines.push('');
  }
  let map = lines.join('\n');
  if (map.length > MAX_MAP_CHARS) {
    map = `${map.slice(0, map.lastIndexOf('\n## ', MAX_MAP_CHARS))}\n\n(Cut here: the project is large. Search for the rest.)\n`;
  }
  return map;
}

/** Where a project's map lives: ~/.harv/codemaps/<name>-<hash of its path>.md (per computer, not synced). */
export function codeMapPath(root: string, home = HARV_HOME): string {
  const key = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 8);
  const safe =
    basename(root)
      .replace(/[^\w.-]+/g, '-')
      .slice(0, 40) || 'project';
  return join(home, 'codemaps', `${safe}-${key}.md`);
}

const running = new Map<string, Promise<boolean>>();

/**
 * Makes or refreshes a project's map when its files changed since the last one. One at a time per
 * project; never throws (a map is a help, not a need). Resolves true when it wrote a new map.
 */
export function refreshCodeMap(root: string, name?: string, home = HARV_HOME): Promise<boolean> {
  const busy = running.get(root);
  if (busy) return busy;
  const job = (async () => {
    try {
      const path = codeMapPath(root, home);
      const print = await fingerprint(root);
      let old = '';
      try {
        old = readFileSync(path, 'utf8');
      } catch {
        /* none yet */
      }
      if (old.includes(`<!-- fingerprint: ${print} -->`)) return false;
      const map = await buildCodeMap(root, name, print);
      mkdirSync(join(home, 'codemaps'), { recursive: true });
      writeFileSync(path, map);
      return true;
    } catch {
      return false;
    } finally {
      running.delete(root);
    }
  })();
  running.set(root, job);
  return job;
}
