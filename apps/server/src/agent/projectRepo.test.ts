import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pullNotice, pullProject, remoteKey, remoteOf, repoName, sameRemote } from './projectRepo.ts';

// Real git against a bare repo standing in for GitHub (start_project's GitHub repos, docs/PLAN.md §6f).
const root = mkdtempSync(join(tmpdir(), 'harv-projects-sync-'));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Harv', '-c', 'user.email=harv@example.com', ...args], { cwd, stdio: 'pipe' }).toString();
let n = 0;

/** A "GitHub" repo with one commit, and two checkouts of it: this device's and the other one's. */
function setup() {
  const dir = join(root, String(n++));
  const bare = join(dir, 'remote.git');
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const other = join(dir, 'other');
  git(dir, 'clone', '-q', bare, other);
  writeFileSync(join(other, 'a.txt'), 'one\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'one');
  git(other, 'push', '-q', '-u', 'origin', 'main');
  const here = join(dir, 'here');
  git(dir, 'clone', '-q', bare, here);
  const push = (file: string, text: string) => {
    writeFileSync(join(other, file), text);
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', file);
    git(other, 'push', '-q');
  };
  return { dir, bare, here, other, push };
}

describe('remotes', () => {
  it('knows the same GitHub repo however it is written', () => {
    expect(remoteKey('https://github.com/someone/garden_app.git')).toBe('github.com/someone/garden_app');
    expect(sameRemote('git@github.com:someone/garden_app.git', 'https://github.com/someone/garden_app')).toBe(true);
    expect(sameRemote('https://user@github.com/Someone/Garden_App/', 'https://github.com/someone/garden_app')).toBe(true);
    expect(sameRemote('https://github.com/someone/garden_app', 'https://github.com/someone/harv')).toBe(false);
  });

  it('makes a GitHub repo name from a project name', () => {
    expect(repoName('weather-app')).toBe('weather-app');
    expect(repoName('My cool app!')).toBe('My-cool-app');
    expect(repoName('***')).toBe('project');
  });

  it("reads a folder's origin", async () => {
    const { here, bare, dir } = setup();
    expect(await remoteOf(here)).toBe(bare);
    expect(await remoteOf(dir)).toBeNull();
  });
});

describe('pulling a project', () => {
  it("fast-forwards to the other device's pushes", async () => {
    const { here, push } = setup();
    expect(await pullProject(here)).toBe('up-to-date');
    push('b.txt', 'two\n');
    expect(await pullProject(here)).toBe('pulled');
    expect(git(here, 'log', '--oneline').split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('never touches work in progress', async () => {
    const { here, push } = setup();
    push('b.txt', 'two\n');
    writeFileSync(join(here, 'a.txt'), 'edited here\n');
    expect(await pullProject(here)).toBe('dirty');
    git(here, 'add', '-A');
    git(here, 'commit', '-q', '-m', 'local');
    expect(await pullProject(here)).toBe('diverged');
    expect(pullNotice('garden_app', 'diverged')).toMatch(/both here and on the other device/);
  });

  it('leaves unpushed commits alone', async () => {
    const { here } = setup();
    writeFileSync(join(here, 'c.txt'), 'three\n');
    git(here, 'add', '-A');
    git(here, 'commit', '-q', '-m', 'local');
    expect(await pullProject(here)).toBe('unpushed');
    expect(pullNotice('x', 'unpushed')).toMatch(/aren't pushed/);
    expect(pullNotice('x', 'up-to-date')).toBeUndefined();
    expect(pullNotice('x', 'pulled')).toMatch(/Pulled the other device's new work into "x"/);
  });

  it('says no-remote for a folder without one', async () => {
    const { dir } = setup();
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    git(plain, 'init', '-q');
    expect(await pullProject(plain)).toBe('no-remote');
  });
});
