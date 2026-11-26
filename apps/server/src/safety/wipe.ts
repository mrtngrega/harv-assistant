import { homedir } from 'node:os';
import { IS_WINDOWS } from '../platform.ts';
import { fullPath, isInside } from './paths.ts';
import { type Resolved, resolveWord, type Segment, targetsOf, walkCommand } from './targets.ts';

// Wiping the system or the home folder, judged on where the command really points, never on how it
// is spelled (the full review, S3: `Remove-Item C:\Users\x -Recurse`, `rm -rf /c/*`, `cd ~ && rm -rf *`,
// `find ~ -delete`, `gci C:\ | Remove-Item` all passed the old text rule).

/** Programs that delete what they're given. */
export const DELETERS = /^(rm|rmdir|rd|del|erase|remove-item|ri|unlink|shred|rimraf|trash|gio)$/;
/** Programs that list a folder (what a piped deleter then deletes). */
const LISTERS = /^(ls|dir|gci|get-childitem|find)$/;
/** A name or age filter: it picks some files, not the whole folder (then S4 holds it, not this). */
const FILTERS = /^(-name|-iname|-path|-ipath|-regex|-mtime|-mmin|-newer|-size|-type|-filter|-include|-exclude)$/i;
/** Deleting from code given inline (`python -c "shutil.rmtree('~')"`, `node -e "fs.rmSync(…)"`). */
const INLINE_DELETE = /\b(?:rmtree|rmSync|rmdirSync|unlinkSync|remove|unlink|rmdir|removedirs)\(\s*(["'])([^"']+)\1/g;

const home = homedir();
const SYSTEM_DIRS = IS_WINDOWS
  ? [process.env.SystemRoot ?? 'C:\\Windows', process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
  : ['/boot', '/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/sys', '/dev', '/root', '/var', '/opt', '/home'];
const SYSTEM_DRIVE = IS_WINDOWS ? `${(process.env.SystemDrive ?? 'C:').toUpperCase()}\\` : '/';

const same = (a: string, b: string) => isInside(a, b) && isInside(b, a);
const driveRoot = (p: string) => (IS_WINDOWS && /^[a-z]:\\?$/i.test(p) ? `${p.slice(0, 2).toUpperCase()}\\` : null);

export type Wipe = { kind: 'system' | 'drive'; path: string };

/** What deleting `target` whole would be: the system (never), another drive (ask), or nothing special. */
function judge(target: Resolved): Wipe | null {
  if (target.opaque) return null;
  for (const p of [target.path, target.real].filter((x): x is string => !!x)) {
    // Home, or any folder home sits in (C:\Users, /home, the drive itself).
    if (isInside(home, p)) return { kind: 'system', path: p };
    if (same(p, SYSTEM_DRIVE)) return { kind: 'system', path: p };
    if (SYSTEM_DIRS.some((d) => d && same(p, fullPath(d)))) return { kind: 'system', path: p };
    const root = driveRoot(p);
    if (root) return { kind: 'drive', path: root };
  }
  return null;
}

/** The folders a `find` starts in, unless a name or age filter picks only some files (`-type` doesn't). */
function findRoots(seg: Segment): Resolved[] {
  const ws = seg.words;
  if (seg.base === undefined || ws.some((w) => FILTERS.test(w) && !/^-type$/i.test(w))) return [];
  const end = ws.findIndex((w, i) => i > 0 && (w.startsWith('-') || w === '(' || w === '!'));
  const roots = ws.slice(1, end < 0 ? undefined : end);
  return (roots.length ? roots : ['.']).map((r) => resolveWord(r, seg.base!, seg.vars));
}

/** The places a deleting segment would delete whole, or [] when it isn't a whole-folder delete. */
function deletedWhole(seg: Segment, before: Segment | undefined): Resolved[] {
  const ws = seg.words;
  if (seg.program === 'find') {
    if (!ws.some((w) => w === '-delete' || w === '-exec' || w === '-execdir')) return [];
    if (ws.includes('-exec') && !/\b(rm|shred|unlink)\b/.test(ws.slice(ws.indexOf('-exec')).join(' '))) return [];
    return findRoots(seg);
  }
  // `ls ~ | xargs rm -rf`, `Get-ChildItem C:\ | Remove-Item -Recurse`: the listing's folder is deleted.
  const piped = seg.piped && before && LISTERS.test(before.program);
  if (piped && (DELETERS.test(seg.program) || (seg.program === 'xargs' && ws.some((w) => DELETERS.test(w))))) {
    if (before.program === 'find') return findRoots(before);
    if (before.words.some((w) => FILTERS.test(w))) return [];
    const listed = targetsOf(before);
    return listed.length ? listed : before.base !== undefined ? [resolveWord('.', before.base)] : [];
  }
  if (!DELETERS.test(seg.program)) return [];
  if (seg.program === 'gio' && ws[1] !== 'trash') return [];
  return targetsOf(seg);
}

/**
 * Would this command delete the system, the home folder (or anything it sits in), or another drive's
 * root, whole? `system` is a hard stop; `drive` is asked first. Null for anything else (smaller deletes
 * are the backup's business: S4).
 */
export function wipeTarget(command: string, cwd: string): Wipe | null {
  const segments = walkCommand(command, cwd);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    for (const t of deletedWhole(seg, segments[i - 1])) {
      const hit = judge(t);
      if (hit) return hit;
    }
    // Inline code that deletes a folder by its literal name.
    if (/^(python3?|py|node|deno|bun|ruby|perl)$/.test(seg.program) && seg.base !== undefined) {
      for (const m of seg.text.matchAll(INLINE_DELETE)) {
        const hit = judge(resolveWord(m[2]!, seg.base, seg.vars));
        if (hit) return hit;
      }
    }
  }
  return null;
}
