import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { FILE_WRITE_TOOLS, SHELL_TOOLS, type ClassifyContext, type Verdict } from './base.ts';
import { planBackup } from './backup.ts';
import { fullPath, isInside, isTempDir, WORKSPACE } from './paths.ts';
import { splitHeredocs } from './shell.ts';
import { type Resolved, type Segment, targetsOf, walkCommand } from './targets.ts';
import { DELETERS } from './wipe.ts';

// "Backed up, then it runs" only holds when the backup can cover it (the full review, S4). A destructive
// call runs without asking only when every target was copied, or can be rebuilt (D5: temp, git-ignored,
// node_modules and the like). Otherwise it waits for the user's yes: the gate can't see what it deletes
// (a variable it can't follow, a piped list, `find … -delete`), or it's too big to copy.

/** Folders that are rebuilt, not restored (outside a git repo, where git can't tell). */
const REBUILDABLE = /^(node_modules|\.venv|venv|__pycache__|\.cache|\.next|\.nuxt|\.turbo|\.parcel-cache|dist|build|target|out|coverage)$/i;
/** Git commands that destroy what the reflog could bring back. */
const DESTROYS_HISTORY = /\bgit\s+(-C\s+\S+\s+)?(reflog\s+(expire|delete)|gc\b[^|;&\n]*--prune|filter-branch|filter-repo|stash\s+clear)\b/i;

const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/** Git ignores it (one quick `git check-ignore`; false outside a repo or when git can't tell). */
function gitIgnored(path: string): boolean {
  try {
    const r = spawnSync('git', ['-C', dirname(path), 'check-ignore', '-q', path], { timeout: 2000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Can be rebuilt instead of restored: the temp folder, what git ignores, node_modules and friends. */
export function rebuildable(path: string): boolean {
  if (isTempDir(path)) return true;
  if (path.split(/[\\/]/).some((part) => REBUILDABLE.test(part))) return true;
  return gitIgnored(path);
}

/** A wildcard target expanded on disk (one folder level); the matches are what gets deleted. */
function expand(t: Resolved): string[] {
  const name = basename(t.path);
  if (!/[*?[]/.test(name)) return [t.path];
  const dir = dirname(t.path);
  const re = new RegExp(
    `^${name
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i',
  );
  try {
    return readdirSync(dir)
      .filter((n) => re.test(n))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** What a part deletes, as far as the gate can see: `blind` when it can't tell. */
function deletes(seg: Segment, before: Segment | undefined): { blind: string | null; paths: string[] } | null {
  const ws = seg.words;
  const xargsDeletes = seg.program === 'xargs' && ws.some((w) => DELETERS.test(w));
  if (seg.program === 'find') {
    if (!ws.some((w) => w === '-delete') && !(ws.includes('-exec') && /\b(rm|shred|unlink)\b/.test(ws.join(' ')))) return null;
    return { blind: 'find … -delete picks the files as it goes', paths: [] };
  }
  if (seg.piped && before && (DELETERS.test(seg.program) || xargsDeletes)) return { blind: `a list from ${before.program}`, paths: [] };
  if (!DELETERS.test(seg.program)) return null;
  if (seg.base === undefined) return { blind: 'a folder after a cd Harv can’t follow', paths: [] };
  const targets = targetsOf(seg);
  const opaque = targets.find((t) => t.opaque);
  if (opaque) {
    const word = seg.words.find((w) => /[$`%]/.test(w)) ?? '';
    return { blind: word || 'a variable', paths: [] };
  }
  return { blind: null, paths: targets.flatMap(expand) };
}

export interface Coverage {
  /** Why the backup can't cover this call (the held line says it), or null when it can. */
  gap: string | null;
  /** Files a wildcard named, found on disk: backed up too. */
  more: string[];
  /** Targets that are rebuilt, not backed up (the action log says so). */
  rebuilt: string[];
}

/**
 * Can the backup cover what this call destroys? Only yellow/red calls that change files are looked at.
 * The project's own files are git's (a project chat's deletes inside it are covered by git and the backup).
 */
export function coverage(tool: string, input: Record<string, unknown>, verdict: Verdict, ctx: ClassifyContext = {}): Coverage {
  const none: Coverage = { gap: null, more: [], rebuilt: [] };
  if (verdict.tier === 'green' || verdict.tier === 'blocked') return none;
  const cwd = ctx.project ?? WORKSPACE;
  let destroyed: string[] = [];
  const more: string[] = [];
  if (SHELL_TOOLS.includes(tool)) {
    const command = String(input.command ?? '');
    const shell = splitHeredocs(command).shell;
    const segments = walkCommand(shell, cwd);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const d = deletes(seg, segments[i - 1]);
      if (!d) continue;
      if (d.blind !== null) {
        // Inside the temp folder nothing needs a backup.
        if (seg.base !== undefined && isTempDir(seg.base) && !seg.piped) continue;
        // Inside the project, git has it (the user's choice for project chats, 2026-10-25).
        if (seg.base !== undefined && ctx.project && isInside(seg.base, ctx.project) && d.blind.startsWith('find')) continue;
        return { ...none, gap: `Harv can't see what it deletes (${d.blind}), so it can't be backed up.` };
      }
      destroyed.push(...d.paths);
      more.push(...d.paths.filter((p) => !verdict.targets.some((t) => isInside(p, t) && isInside(t, p))));
    }
    if (verdict.keep?.length && DESTROYS_HISTORY.test(command)) {
      const big = planBackup(verdict.keep).skipped[0];
      if (big) return { ...none, gap: `Too big to back up first: ${big.path} (${size(big.bytes)}), and this can't be undone through git.` };
    }
  } else if (FILE_WRITE_TOOLS.includes(tool)) {
    const file = String(input.file_path ?? input.notebook_path ?? '');
    if (file) destroyed = [fullPath(file, cwd)];
  } else return none;

  // Too big to copy: fine when it can be rebuilt (D5), else it waits for the user's yes.
  const skipped = planBackup(destroyed.filter((p) => statSync(p, { throwIfNoEntry: false }))).skipped;
  const rebuilt = skipped.filter((s) => rebuildable(s.path)).map((s) => s.path);
  const big = skipped.find((s) => !rebuilt.includes(s.path));
  if (big)
    return {
      gap: `Too big to back up: ${big.path} (${size(big.bytes)}${big.files > 1 ? `, ${big.files}+ files` : ''}).`,
      more,
      rebuilt,
    };
  return { gap: null, more, rebuilt };
}
