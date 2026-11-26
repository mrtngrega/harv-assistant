import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { HARV_REPO } from './harvSelf.ts';

// Harv's own skills (docs/PLAN.md §6ab "The skills plan"): their source is harv/skills/<name>/ in
// this repo, so a git pull updates both computers; Claude Code reads skills from ~/.claude/skills,
// so Harv copies them there when it starts, only the files that changed. A file removed from the
// repo is removed there too, but only one Harv installed itself (its list in .harv-own-skills.json).

export const OWN_SKILLS_SRC = join(HARV_REPO, 'harv', 'skills');
const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills');

/**
 * A skill the user has installed by that name: a folder in ~/.claude/skills, or a plugin's
 * `plugin:skill` name (plugins keep theirs elsewhere; the colon form only exists for them).
 */
export function isInstalledSkill(name: string, dir = USER_SKILLS_DIR): boolean {
  if (/^[\w-]+:[\w-]+$/.test(name)) return true;
  return /^[\w.-]+$/.test(name) && existsSync(join(dir, name, 'SKILL.md'));
}

/** Python's caches and dot-folders aren't part of a skill (a `.pyc` was installed: the full review, K27). */
const skipped = (name: string) => name.startsWith('.') || name === '__pycache__' || name.endsWith('.pyc');

function files(dir: string, base = ''): string[] {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) =>
    skipped(e.name) ? [] : e.isDirectory() ? files(dir, join(base, e.name)) : e.isFile() ? [join(base, e.name)] : [],
  );
}

/** What Harv installed last time (relative paths), so a file removed from the repo is removed there too. */
const MANIFEST = '.harv-own-skills.json';

function readManifest(dest: string): string[] {
  try {
    const list = JSON.parse(readFileSync(join(dest, MANIFEST), 'utf8')) as unknown;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Copies every skill folder (one with a SKILL.md) from `src` to `dest`; returns the files written.
 * A file Harv installed before that the repo no longer has is deleted (only those on its own list:
 * the user's own skills and files are never touched), so an old reference isn't read for ever.
 */
export function installOwnSkills(src = OWN_SKILLS_SRC, dest = USER_SKILLS_DIR): string[] {
  if (!existsSync(src)) return [];
  const written: string[] = [];
  const installed: string[] = [];
  for (const skill of readdirSync(src, { withFileTypes: true })) {
    if (!skill.isDirectory() || !existsSync(join(src, skill.name, 'SKILL.md'))) continue;
    for (const rel of files(join(src, skill.name))) {
      const from = join(src, skill.name, rel);
      const to = join(dest, skill.name, rel);
      installed.push(join(skill.name, rel));
      const bytes = readFileSync(from);
      if (existsSync(to) && statSync(to).size === bytes.length && readFileSync(to).equals(bytes)) continue;
      mkdirSync(join(to, '..'), { recursive: true });
      writeFileSync(to, bytes);
      written.push(join(skill.name, rel));
    }
  }
  const now = new Set(installed);
  for (const old of readManifest(dest)) {
    // Never outside dest (a hand-edited list): relative paths inside a skill folder only.
    if (now.has(old) || isAbsolute(old) || old.split(/[\\/]/).includes('..')) continue;
    rmSync(join(dest, old), { force: true });
  }
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, MANIFEST), JSON.stringify(installed));
  return written;
}
