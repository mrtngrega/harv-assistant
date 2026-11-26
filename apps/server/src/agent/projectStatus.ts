import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Project } from '@harv/shared';

// Where a project stands, for any chat (docs/PLAN.md §6f): Siri's Phone chat was asked
// "where did we end in garden_app" and could only search old chats. This reads, without switching the
// chat to the project: its Claude Code memory (where the project's sessions write their state), the
// start of its CLAUDE.md and plan, and git (recent commits, uncommitted work, unpushed commits).

/** Caps so one call stays small in the chat's context. */
const MEMORY_FILE_MAX = 1800;
const MEMORY_MAX = 6000;
const DOC_MAX = 1500;
const GIT_TIMEOUT_MS = 5000;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}\n[…cut]` : s.trimEnd());

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

/** The memory notes, newest first, the index (MEMORY.md) first of all. */
function memorySection(dir: string): string {
  if (!existsSync(dir)) return 'No Claude Code memory for this project yet.';
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => (a.f === 'MEMORY.md' ? -1 : b.f === 'MEMORY.md' ? 1 : b.at - a.at));
  let out = '';
  for (const { f, at } of files) {
    const body = read(join(dir, f));
    if (body === null) continue;
    const part = `### ${f} (changed ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')})\n${cut(body, MEMORY_FILE_MAX)}\n\n`;
    if (out.length + part.length > MEMORY_MAX) {
      out += `[${files.length} notes in ${dir}; the rest weren't included: read them there if needed]\n`;
      break;
    }
    out += part;
  }
  return out.trimEnd() || 'No Claude Code memory for this project yet.';
}

/** A project by name as the model wrote it: exact, then ignoring case and punctuation ("car radio" → garden_app), then a part of it. */
export function findProject(list: Project[], name: string): Project | undefined {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const k = key(name);
  return (
    list.find((p) => p.name === name) ?? list.find((p) => key(p.name) === k) ?? (k ? list.find((p) => key(p.name).includes(k)) : undefined)
  );
}

export async function projectStatus(project: Project, home?: string): Promise<string> {
  const { path } = project;
  if (!existsSync(path)) return `${project.name}: its folder ${path} isn't on this computer.`;
  const parts = [`# ${project.name} (${path})`];

  parts.push(`## Project memory (Claude Code's notes, the newest state is usually here)\n${memorySection(claudeMemoryDir(path, home))}`);

  const claude = read(join(path, 'CLAUDE.md'));
  if (claude) parts.push(`## CLAUDE.md (start)\n${cut(claude, DOC_MAX)}`);
  const planPath = ['docs/PLAN.md', 'PLAN.md'].map((p) => join(path, p)).find(existsSync);
  const plan = planPath && read(planPath);
  if (plan) parts.push(`## ${planPath!.slice(path.length + 1).replace(/\\/g, '/')} (start)\n${cut(plan, DOC_MAX)}`);

  const log = await git(path, ['log', '-10', '--format=%h %cd %s', '--date=format:%Y-%m-%d %H:%M']);
  if (log === null) parts.push('## Git\nNot a git repository (or git failed).');
  else {
    const status = (await git(path, ['status', '--short'])) ?? '';
    const ahead = await git(path, ['rev-list', '--count', '@{u}..HEAD']);
    const changed = status ? status.split('\n').length : 0;
    parts.push(
      [
        '## Git',
        `Recent commits:\n${log || '(none yet)'}`,
        changed ? `Uncommitted: ${changed} file(s)\n${cut(status, 600)}` : 'Uncommitted: nothing',
        ahead === null ? 'No upstream branch.' : `Commits not pushed: ${ahead}`,
      ].join('\n'),
    );
  }
  parts.push(
    '(Read-only overview. Read more files from the folder if the question needs it; switch to the project chat only if the user asks to work on it.)',
  );
  return parts.join('\n\n');
}

/**
 * Claude Code's memory folder for a project: ~/.claude/projects/<folder>/memory, where <folder> is the
 * project's path with every character that isn't a letter or digit turned into "-".
 */
export function claudeMemoryDir(projectPath: string, home = homedir()): string {
  return join(home, '.claude', 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
}
