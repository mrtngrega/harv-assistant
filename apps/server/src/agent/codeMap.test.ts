import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCodeMap, codeMapPath, purpose, refreshCodeMap, symbols } from './codeMap.ts';

const root = mkdtempSync(join(tmpdir(), 'harv-codemap-'));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

function project(name: string, files: Record<string, string>, gitInit = false): string {
  const dir = join(root, name);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  if (gitInit) {
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'one']);
  }
  return dir;
}

describe('what a file holds', () => {
  it('reads the top comment or docstring, skipping shebangs and lint lines', () => {
    expect(purpose('#!/usr/bin/env node\n// Sends one message to a chat.\nconst a = 1;')).toBe('Sends one message to a chat.');
    expect(purpose('"""Render a video report."""\nimport os')).toBe('Render a video report.');
    expect(purpose('/**\n * The live preview next to a chat.\n */')).toBe('The live preview next to a chat.');
    expect(purpose('/* eslint-disable */\nexport const x = 1;')).toBe('');
    expect(purpose('import x from "y";\n// later comment')).toBe('');
    expect(purpose('// Tool lists and chat-log descriptions. The safety checks themselves live in\n// safety/. More.\n')).toBe(
      'Tool lists and chat-log descriptions.',
    );
    expect(purpose('// A code map for the user projects, built\n// from the files alone. Then more.\n')).toBe(
      'A code map for the user projects, built from the files alone.',
    );
  });

  it('lists the main names per language', () => {
    expect(symbols('export function a() {}\nexport const B = 1;\nfunction c() {}\nclass D {}\n  function inner() {}', 'js')).toEqual([
      'a',
      'B',
      'c',
      'D',
    ]);
    expect(symbols('def main():\n    pass\nclass Kit:\n    def method(self): ...\nasync def fetch(): ...', 'py')).toEqual(['Kit', 'fetch']);
    expect(symbols('pub fn harv_pill() {}\npub(crate) struct Pill;\nfn helper() {}', 'rs')).toEqual(['harv_pill', 'Pill', 'helper']);
    expect(symbols('func (s *Server) Start() {}\ntype Config struct{}', 'go')).toEqual(['Start', 'Config']);
  });
});

describe('the code map', () => {
  it('groups files by folder with their purpose and names, and leaves out build output and lockfiles', async () => {
    const dir = project('app', {
      'src/server.ts': '// The HTTP server.\nexport function start() {}\n',
      'src/lib/util.py': '"""Small helpers."""\ndef slug(s): ...\n',
      'src/server.test.ts': 'function fake() {}\n',
      'README.md': '# App',
      'package-lock.json': '{}',
      'node_modules/x/index.js': 'export const no = 1;',
      'dist/out.js': 'export const no = 1;',
    });
    const map = await buildCodeMap(dir, 'App', 'abc');
    expect(map).toContain('# Code map: App');
    expect(map).toContain('<!-- fingerprint: abc -->');
    expect(map).toContain('## src/\n- `server.ts`: The HTTP server. [start]\n- tests: server.test.ts');
    expect(map).toContain('## src/lib/\n- `util.py`: Small helpers. [slug]');
    expect(map).toContain('- also: README.md');
    expect(map).not.toMatch(/package-lock|node_modules|dist\//);
  });

  it('is made once, then again only after files change (git project)', async () => {
    const dir = project('repo', { 'a.ts': '// First.\nexport const a = 1;\n' }, true);
    const home = join(root, 'home');
    expect(await refreshCodeMap(dir, 'Repo', home)).toBe(true);
    expect(await refreshCodeMap(dir, 'Repo', home)).toBe(false);
    writeFileSync(join(dir, 'b.ts'), '// Second.\nexport function b() {}\n');
    expect(await refreshCodeMap(dir, 'Repo', home)).toBe(true);
    const map = readFileSync(codeMapPath(dir, home), 'utf8');
    expect(map).toContain('`b.ts`: Second. [b]');
    // A second edit to an already-changed file counts too.
    writeFileSync(join(dir, 'b.ts'), '// Second, edited.\nexport function b2() {}\n');
    expect(await refreshCodeMap(dir, 'Repo', home)).toBe(true);
    expect(readFileSync(codeMapPath(dir, home), 'utf8')).toContain('[b2]');
  });

  it('lives outside the project, one file per project path', () => {
    const p = codeMapPath(join(root, 'My Game'), '/h');
    expect(p).toMatch(/codemaps[\\/]My-Game-[0-9a-f]{8}\.md$/);
    expect(codeMapPath(join(root, 'other', 'My Game'), '/h')).not.toBe(p);
  });
});
