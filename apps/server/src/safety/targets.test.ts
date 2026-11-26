import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isInside } from './paths.ts';
import { isSecretFile, resolveWord, splitWithPipes, targetsOf, walkCommand } from './targets.ts';

const onWindows = process.platform === 'win32';
const work = mkdtempSync(join(tmpdir(), 'harv-targets-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const home = homedir();
const same = (a: string, b: string) => expect(isInside(a, b) && isInside(b, a)).toBe(true);

describe('resolveWord: every spelling ends at the same place', () => {
  it.each(['~', '$HOME', '${HOME}', '"$HOME"', '~/', '~/*', '~/.', '$HOME/*', '~/.*'])('home: %s', (w) => {
    same(resolveWord(w, work).path, home);
  });

  it.runIf(onWindows).each(['%USERPROFILE%', '$env:USERPROFILE', '$env:USERPROFILE\\*', `/c/Users/${home.split('\\').at(-1)}`])(
    'home on Windows: %s',
    (w) => {
      same(resolveWord(w, work).path, home);
    },
  );

  it.runIf(onWindows).each(['C:\\', 'C:\\*', 'C:', '/c/', '/c', '/c/*', '/mnt/c', 'C:/'])('the C: drive root: %s', (w) => {
    expect(resolveWord(w, work).path.toLowerCase()).toBe('c:\\');
  });

  it('marks what it cannot see', () => {
    expect(resolveWord('$X/y', work).opaque).toBe(true);
    expect(resolveWord('$(pwd)/y', work).opaque).toBe(true);
    expect(resolveWord('build/out', work).opaque).toBe(false);
    expect(resolveWord('*', work).all).toBe(true);
  });
});

describe('walkCommand: the folder each part runs in', () => {
  it('follows cd and pushd', () => {
    const [seg] = walkCommand('cd ~/.ssh && cat id_ed25519', work);
    same(seg!.base!, join(home, '.ssh'));
    expect(seg!.program).toBe('cat');
  });

  it('loses the folder after a cd it cannot follow', () => {
    expect(walkCommand('cd $X && rm -rf *', work)[0]!.base).toBeUndefined();
  });

  it('unwraps sudo, env, cmd /c, wsl, bash -c and powershell -Command', () => {
    expect(walkCommand('sudo -n rm -rf /tmp/x', work)[0]!.program).toBe('rm');
    expect(walkCommand('env A=1 rm x', work)[0]!.program).toBe('rm');
    expect(walkCommand('cmd /c rd /s /q C:\\x', work)[0]!.program).toBe('rd');
    expect(walkCommand('wsl -d Ubuntu -- rm -rf /mnt/c/x', work)[0]!.program).toBe('rm');
    expect(walkCommand("bash -c 'cd ~ && rm -rf *'", work)[0]!.program).toBe('rm');
    expect(walkCommand('powershell -NoProfile -Command Remove-Item C:\\x -Recurse', work)[0]!.program).toBe('remove-item');
  });

  it("follows the command's own simple variables", () => {
    const [seg] = walkCommand('tmp=/x/y; rm -rf "$tmp"', work).filter((s) => s.program === 'rm');
    expect(targetsOf(seg!)[0]!.opaque).toBe(false);
    const [ps] = walkCommand("$f = 'a.txt'; Remove-Item $f", work).filter((s) => s.program === 'remove-item');
    same(targetsOf(ps!)[0]!.path, join(work, 'a.txt'));
    const [mk] = walkCommand('d=$(mktemp -d); rm -rf "$d"', work).filter((s) => s.program === 'rm');
    expect(targetsOf(mk!)[0]!.opaque).toBe(false);
  });

  it('keeps which parts read a pipe', () => {
    expect(splitWithPipes('ls ~ | xargs rm; echo a || echo b').map((p) => p.piped)).toEqual([false, true, false, false]);
  });

  it("treats cmd's /s as an option and bash's /c as a path", () => {
    const [rd] = walkCommand('rd /s /q D:\\x', work);
    expect(targetsOf(rd!).length).toBe(1);
    const [rm] = walkCommand('rm -rf /c', work);
    expect(targetsOf(rm!).length).toBe(1);
  });
});

describe('isSecretFile: a link to a secret is the secret', () => {
  it('follows a link', () => {
    const fakeSsh = join(work, 'h', '.ssh');
    mkdirSync(fakeSsh, { recursive: true });
    writeFileSync(join(fakeSsh, 'id_ed25519'), 'x');
    const link = join(work, 'innocent');
    try {
      symlinkSync(join(fakeSsh, 'id_ed25519'), link, 'file');
    } catch {
      return; // no symlink rights on this Windows account
    }
    expect(isSecretFile(link)).toBe(true);
    expect(isSecretFile(join(work, 'other.txt'))).toBe(false);
  });
});
