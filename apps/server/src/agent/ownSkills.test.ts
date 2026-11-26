import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { installOwnSkills, OWN_SKILLS_SRC } from './ownSkills.ts';

describe("Harv's own skills", () => {
  const dir = mkdtempSync(join(tmpdir(), 'harv-skills-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'src');
  const dest = join(dir, 'dest');
  const put = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };

  it('copies skill folders with their references, then only what changed', () => {
    put(join(src, 'diagnose', 'SKILL.md'), 'v1');
    put(join(src, 'diagnose', 'references', 'gotchas.md'), 'traps');
    put(join(src, 'notes', 'README.md'), 'not a skill');
    put(join(src, 'CREDITS.md'), 'not a folder');
    expect(installOwnSkills(src, dest).sort()).toEqual([join('diagnose', 'SKILL.md'), join('diagnose', 'references', 'gotchas.md')]);
    expect(readFileSync(join(dest, 'diagnose', 'references', 'gotchas.md'), 'utf8')).toBe('traps');
    expect(existsSync(join(dest, 'notes'))).toBe(false);
    expect(installOwnSkills(src, dest)).toEqual([]);
    put(join(src, 'diagnose', 'SKILL.md'), 'v2');
    expect(installOwnSkills(src, dest)).toEqual([join('diagnose', 'SKILL.md')]);
  });

  it('a hand edit of the installed copy is replaced by the repo version', () => {
    put(join(dest, 'diagnose', 'SKILL.md'), 'edited by hand');
    expect(installOwnSkills(src, dest)).toEqual([join('diagnose', 'SKILL.md')]);
    expect(readFileSync(join(dest, 'diagnose', 'SKILL.md'), 'utf8')).toBe('v2');
  });

  it('skips caches and dot-folders, and removes a file the repo dropped (only its own)', () => {
    put(join(src, 'diagnose', 'scripts', '__pycache__', 'x.cpython-314.pyc'), 'cache');
    put(join(src, 'diagnose', '.cache', 'y'), 'cache');
    put(join(src, 'diagnose', 'references', 'old.md'), 'old');
    installOwnSkills(src, dest);
    expect(existsSync(join(dest, 'diagnose', 'scripts', '__pycache__'))).toBe(false);
    expect(existsSync(join(dest, 'diagnose', '.cache'))).toBe(false);
    expect(existsSync(join(dest, 'diagnose', 'references', 'old.md'))).toBe(true);
    put(join(dest, 'diagnose', 'mine.md'), 'the user’s own file');
    put(join(dest, 'theirs', 'SKILL.md'), 'the user’s own skill');
    rmSync(join(src, 'diagnose', 'references', 'old.md'));
    installOwnSkills(src, dest);
    expect(existsSync(join(dest, 'diagnose', 'references', 'old.md'))).toBe(false);
    expect(existsSync(join(dest, 'diagnose', 'mine.md'))).toBe(true);
    expect(existsSync(join(dest, 'theirs', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, 'diagnose', 'SKILL.md'))).toBe(true);
  });

  it('the repo’s skills each have a name matching their folder and a "Use …" description', () => {
    const names = readdirSync(OWN_SKILLS_SRC, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(names.sort()).toEqual([
      'clone',
      'deslop',
      'diagnose',
      'figma-templates',
      'google',
      'image-prompt',
      'learn-from-session',
      'prompt-writer',
      'resolve',
      'skill-finder',
      'ui-check',
      'video',
    ]);
    for (const name of names) {
      const text = readFileSync(join(OWN_SKILLS_SRC, name, 'SKILL.md'), 'utf8');
      expect(text).toMatch(new RegExp(`^---\\r?\\nname: ${name}\\r?\\ndescription: .*\\bUse `, 'm'));
    }
  });
});
