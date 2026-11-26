import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Tier } from '@harv/shared';
import { IS_WINDOWS } from '../platform.ts';
import { fullPath, isHarvData, isInside, isProgramDir, isSystemDir, isTempDir, loadSettings, WORKSPACE } from './paths.ts';
import { BROWSER_TOOLS, classifyBrowser } from './browser.ts';
import { classifyDesktop, isDesktopTool } from './desktop.ts';
import { globMayReadSecret, reachesSecret, SECRET_EXCLUDE_GLOB, substitutionReadsSecret, withSecretExclusion } from './secrets.ts';
import { expandVars, isSecretFile, walkCommand } from './targets.ts';
import { wipeTarget } from './wipe.ts';
import { judgeDisks } from './disks.ts';
import { formatSummary } from '../tools/drives.ts';
import {
  AGENT_TOOLS,
  CHANGING_CMDLET,
  CHANGING_WORDS,
  type ClassifyContext,
  FILE_WRITE_TOOLS,
  FORMAT_DRIVE,
  HARV_TOOLS,
  LINUX_INSTALL,
  LINUX_SYSTEM,
  READ_TOOLS,
  type Rule,
  SCHEDULER_TOOLS,
  SHELL_TOOLS,
  TERMINAL_RUN,
  type Verdict,
  matches,
  str,
  verdict,
} from './base.ts';
import { classifyInAttached, classifyInProject, pathLikeWords } from './project.ts';
import { onlyReachesOut, runsSsh, splitRemote, type RemotePart } from './remote.ts';
import { isGreenSegment, isReadOnlyPowerShell, isReadOnlyProgram, withoutAssignments } from './readOnly.ts';
import { connectorCall, referencedFiles } from './connectors.ts';
import { MCP_READ, PRIVATE_MCP, scriptSends, sendsData } from './sending.ts';
import {
  setsBillingEnv,
  isClaudeHistory,
  isClaudeMemory,
  isClaudeSetup,
  isSensitivePath,
  mentionsSecret,
  writesBillingSetting,
} from './sensitive.ts';
import {
  CODE_RUNNERS,
  DELETE_API,
  EXECUTABLE,
  PROCESS_API,
  QUOTED,
  START_OPTION,
  WINDOWS_PROGRAM,
  commandsIn,
  copyDestination,
  maskHereStrings,
  pathsInCommand,
  runningParts,
  runningText,
  runsAsShell,
  hidesCode,
  inertInlineCode,
  scriptPaths,
  splitCommand,
  splitHeredocs,
  dropOwnKills,
  DATA_RUNNERS,
  unquote,
  words,
} from './shell.ts';

// Moved out of this file (2026-11-15, audit part 3 item 2), still importable from here.
export {
  AGENT_TOOLS,
  type ClassifyContext,
  FILE_WRITE_TOOLS,
  FORMAT_DRIVE,
  HARV_TOOLS,
  READ_TOOLS,
  SHELL_TOOLS,
  TERMINAL_RUN,
  type Verdict,
} from './base.ts';
export { classifyInAttached, classifyInProject, installsPythonPackages } from './project.ts';
export { isPrintOnlySed, isReadOnlyPowerShell, isReadOnlyProgram } from './readOnly.ts';
export { askedToSend, asksToSend, isSending, scriptSends, sendsData } from './sending.ts';
export { isClaudeHistory, isClaudeMemory, isClaudeSetup, isSensitivePath, writesBillingSetting } from './sensitive.ts';
export {
  type Heredoc,
  backupTargets,
  pathsInCommand,
  runningParts,
  runningText,
  splitCommand,
  splitHeredocs,
  startedLines,
} from './shell.ts';

/** How the OS folders are named in reasons. */
const SYSTEM_FOLDER = IS_WINDOWS ? 'the Windows folder' : "the system's own folders";

// Sorts every tool call into green / yellow / red / blocked (CLAUDE.md "Harv's
// safety model"). It is deliberately conservative: a shell command is green only
// when every part of it is clearly read-only, and anything unclear is red: it runs backed up and
// logged with Undo; only `ask` (held in the chat) and `blocked` stop it (docs/PLAN.md §4).

/**
 * Desktop control's App `launch_executable`: judged as the same `Start-Process` command. What the
 * shell runs at once (opening an app or a Control Panel page) runs here too; a blocked one stays
 * blocked; anything that changes things goes through the PowerShell tool, which backs it up.
 */
function launchVerdict(input: Record<string, unknown>, summary: string, ctx: ClassifyContext): Verdict {
  const exe = str(input, 'executable');
  const args = Array.isArray(input.args) ? input.args.map(String) : typeof input.args === 'string' && input.args ? [input.args] : [];
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const command = `Start-Process -FilePath ${q(exe)}${args.length ? ` -ArgumentList ${args.map(q).join(',')}` : ''}`;
  const v = classifyCommand(command, summary, { ...ctx, project: undefined, attachedRoot: undefined, shell: 'powershell' });
  if (v.tier === 'green' || v.tier === 'blocked') return { ...v, summary };
  return {
    ...verdict(
      'blocked',
      `Desktop control only opens programs that change nothing. Run it with your PowerShell tool instead (\`${command}\`): that's the right way, not a way around a block, and it's checked and backed up there.`,
      summary,
    ),
    route: true,
  };
}

/**
 * The attached file or folder a command works in: it `cd`s into one, or names a path inside
 * one (the most specific attachment wins). Other paths it names are judged as usual below.
 */
export function attachedOfCommand(command: string, attached: string[]): string | undefined {
  if (attached.length === 0) return undefined;
  const viaCd = projectOfCommand(command, attached);
  if (viaCd) return viaCd;
  const named = pathLikeWords(splitHeredocs(command).shell, WORKSPACE);
  return [...attached].sort((a, b) => b.length - a.length).find((root) => named.some((p) => isInside(p, root)));
}

/** The registered project a command works in: it starts with `cd`/`Set-Location`/`pushd` (or `git -C`) into one. */
export function projectOfCommand(command: string, projects: string[]): string | undefined {
  const [first = ''] = splitCommand(command);
  const ws = words(first).map(unquote);
  const cmd = (ws[0] ?? '').toLowerCase();
  let target: string | undefined;
  if (['cd', 'chdir', 'set-location', 'sl', 'pushd'].includes(cmd)) target = ws.slice(1).find((w) => !w.startsWith('-'));
  else if (cmd === 'git' && ws[1] === '-C') target = ws[2];
  if (!target || /[$`%*?]/.test(target)) return undefined;
  const path = fullPath(target);
  return projects.find((p) => isInside(path, p));
}

export function classify(tool: string, input: Record<string, unknown>, ctx: ClassifyContext = {}): Verdict {
  if (tool === FORMAT_DRIVE)
    return verdict('red', 'Erases a USB drive: everything on it is lost, with no backup and no Undo.', formatSummary(input));
  if (HARV_TOOLS.includes(tool)) return verdict('green', "Harv's own memory and chat tools.", tool.replace('mcp__harv__', ''));
  if (AGENT_TOOLS.includes(tool)) return verdict('green', 'Planning and bookkeeping; anything it runs is checked on its own.', tool);

  if (READ_TOOLS.includes(tool)) {
    // Grep's `pattern` is the text it looks for, not a path.
    const keys = tool === 'Grep' ? ['path'] : ['file_path', 'path', 'pattern', 'glob'];
    const paths = keys.map((k) => str(input, k)).filter(Boolean);
    const base = ctx.project ?? WORKSPACE;
    // The real place too: a short name (CREDEN~1.JSO), a junction or a link to a secret (the full review, S1/S2).
    const secret =
      paths.find(isSensitivePath) ?? ['file_path', 'path'].map((k) => str(input, k)).find((p) => p && isSecretFile(fullPath(p, base)));
    if (secret) return verdict('blocked', `${secret} may contain credentials or secrets, which Harv never reads.`, `read ${secret}`);
    const summary = `${tool} ${paths[0] ?? str(input, 'pattern') ?? str(input, 'query') ?? str(input, 'url')}`;
    if (tool === 'Grep') return grepVerdict(input, summary);
    return verdict('green', 'Reading and searching is always allowed.', summary);
  }

  if (FILE_WRITE_TOOLS.includes(tool)) {
    const file = str(input, 'file_path') || str(input, 'notebook_path');
    const inProject = ctx.project ?? (file ? ctx.projects?.find((p) => isInside(fullPath(file), p)) : undefined);
    if (file && writesBillingSetting(file, input))
      return verdict('blocked', 'It would switch Claude Code to per-token billing; Harv only runs on the subscription.', `${tool} ${file}`);
    return classifyFileWrite(tool, file, { ...ctx, project: inProject });
  }

  if (SHELL_TOOLS.includes(tool)) {
    const command = str(input, 'command');
    const inProject = ctx.project ?? projectOfCommand(command, ctx.projects ?? []);
    return classifyCommand(command, str(input, 'description'), {
      ...ctx,
      project: inProject,
      attachedRoot: inProject ? undefined : attachedOfCommand(command, ctx.attached ?? []),
      shell: tool === 'PowerShell' || (tool === TERMINAL_RUN && IS_WINDOWS) ? 'powershell' : 'bash',
    });
  }

  // Monitor watches a shell command's output lines (or a WebSocket): the command is checked like any other.
  if (tool === 'Monitor') {
    const command = str(input, 'command');
    if (!command) return verdict('green', 'Watches a WebSocket for events.', `monitor ${str(input, 'description')}`);
    return classifyCommand(command, str(input, 'description'), { ...ctx, shell: 'bash' });
  }

  if (BROWSER_TOOLS.includes(tool)) {
    const v = classifyBrowser(tool, input);
    return verdict(v.tier, v.reason, v.summary);
  }

  if (isDesktopTool(tool)) {
    const v = classifyDesktop(tool, input);
    if (input.mode === 'launch_executable') return launchVerdict(input, v.summary, ctx);
    return verdict(v.tier, v.reason, v.summary);
  }

  if (tool.startsWith('mcp__')) return classifyMcp(tool, input);

  if (SCHEDULER_TOOLS.includes(tool))
    return verdict('blocked', "Claude Code's scheduler only lives as long as this session. Use Harv's schedule_task tool instead.", tool);

  return verdict('blocked', `${tool} isn't one of Harv's tools.`, tool);
}

/**
 * The Grep tool searches inside files, hidden ones too: it may search anywhere, with the login secrets
 * left out (the full review, S1; the user's pick, 2026-11-17). A file pattern of Harv's own that could
 * still open a secret (`*.json` matches .credentials.json) is sent back with how to narrow it.
 */
function grepVerdict(input: Record<string, unknown>, summary: string): Verdict {
  const glob = str(input, 'glob');
  if (glob && !glob.startsWith('!') && globMayReadSecret(glob)) {
    return {
      ...verdict(
        'blocked',
        `That search's file pattern (${glob}) also matches login-secret files, which Harv never reads. Search a narrower folder or pattern (like *.md, *.ts, or a subfolder), or leave the pattern out: the search then skips the secret files by itself.`,
        summary,
      ),
      route: true,
    };
  }
  if (glob && !glob.startsWith('!')) return verdict('green', 'Reading and searching is always allowed.', summary);
  return {
    ...verdict('green', 'Searching is allowed; login-secret files are left out of it.', summary),
    rewrite: { ...input, glob: glob ? withSecretExclusion(glob) : SECRET_EXCLUDE_GLOB },
  };
}

/**
 * A tool from an MCP server a chat loads (the user's claude.ai connectors, a project's
 * .mcp.json). Reading is free; changing things elsewhere asks first, except the user's private docs.
 */
function classifyMcp(tool: string, input: Record<string, unknown>): Verdict {
  const [, server = '', ...rest] = tool.split('__');
  const name = rest.join('__');
  const summary = `${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')}: ${name}`;
  // A file attached by reference is read off this computer: login secrets never leave (hard stop 2).
  const secret = referencedFiles(input).find((p) => isSensitivePath(p));
  if (secret) return verdict('blocked', `It would attach or upload ${secret}, a login secret: Harv never sends those.`, summary);
  const connector = connectorCall(tool, input);
  if (connector) {
    const { service, kind } = connector;
    if (kind === 'read') return verdict('green', 'Only reads through a connected service.', summary);
    const v = verdict('red', `Changes something through ${service}.`, summary);
    if (kind === 'delete') v.ask = `Deletes it for good through ${service}: there is no way to bring it back.`;
    if (kind === 'public') v.ask = `Makes it public through ${service}: anyone with the link can open it.`;
    return v;
  }
  if (MCP_READ.test(name)) return verdict('green', 'Only reads through a connected service.', summary);
  if (PRIVATE_MCP.test(server) && /delete|remove/i.test(name)) {
    const v = verdict('red', 'Deletes a doc in your claude.ai account.', summary);
    v.ask = 'Deletes the doc for good: there is no way to bring it back.';
    return v;
  }
  if (PRIVATE_MCP.test(server)) return verdict('green', 'Changes a private doc in your own claude.ai account.', summary);
  return verdict('red', `Changes something through an outside service (${server.replace(/^claude_ai_/, '')}).`, summary);
}

function classifyFileWrite(tool: string, rawPath: string, ctx: ClassifyContext = {}): Verdict {
  const path = fullPath(rawPath, ctx.project);
  const verb = tool === 'Write' ? (existsSync(path) ? 'overwrite' : 'create') : 'edit';
  const summary = `${verb} ${path}`;
  const protectedDir = loadSettings().protectedPaths.find((p) => isInside(path, p));
  if (protectedDir) return askFirst(`${protectedDir} is on your read-only list.`, summary, [path]);
  if (isClaudeHistory(path) && !isClaudeMemory(path)) return askFirst("It changes Claude Code's session history.", summary, [path]);
  // A project's `.env` may be written when a task needs it (the user, 2026-11-17), never read, never
  // with a billing key (checked before this). Every other secret file stays a hard stop.
  if (isSensitivePath(path) && !(tool === 'Write' && isEnvFile(path)))
    return verdict('blocked', 'That file may hold credentials or secrets.', summary);
  if (isSystemDir(path)) return askFirst(`It writes inside ${SYSTEM_FOLDER}.`, summary);
  if (isHarvData(path)) return askFirst(HARV_DATA_REASON, summary, [path]);
  if (AUTOSTART.test(path)) return askFirst(AUTOSTART_ASK, summary, [path]);
  if (isInside(path, WORKSPACE)) return verdict('green', "Inside Harv's own workspace.", summary);
  if (isClaudeMemory(path)) return verdict('green', 'Harv’s notes about the project (shared with Claude Code).', summary);
  if (ctx.project && isInside(path, ctx.project)) return verdict('green', 'Inside the project folder (git can undo it).', summary);
  if (isProgramDir(path)) return verdict('red', 'It changes an installed program’s files.', summary, [path]);
  return verdict('yellow', verb === 'create' ? 'Creates a new file outside the workspace.' : 'Changes one of your files.', summary, [path]);
}

/** A `.env` file (`.env`, `.env.local`…) outside Harv's own data and Claude's setup, and nothing else secret on its path. */
const isEnvFile = (path: string) =>
  /[\\/]\.env(\.[\w-]+)*$/i.test(path) && !isHarvData(path) && !isClaudeSetup(path) && !isSensitivePath(path.replace(/[\\/][^\\/]+$/, ''));

// ── Shell commands ──────────────────────────────────────────────────────────

// The user's read-only folders and the system's own folders are asked first (askFirst, 2026-11-11; they were blocks).

/** Harv's own data (backups, the action log, the database): asked first, since changing it can take Undo away. */
const HARV_DATA_REASON = "It changes Harv's own data (backups, the action log, the database): that can delete the Undo history.";

/**
 * The hard stops and the old blocks that ask now. The third part: null = never (one of the three
 * hard stops), 'ask' = held for the user's yes, 'disk' = never on the system disk (or one Harv
 * can't tell), asked first on any other disk (judgeDisks).
 */
/** Commands that format, repartition or raw-write a disk (the gate looks the disks up first). */
export const DISK_WIPE =
  /\bformat(\.com)?\s+[a-z]:|\b(format-volume|clear-disk|initialize-disk|remove-partition)\b|\bdiskpart\b|\bmkfs\b|\b(wipefs|sfdisk|sgdisk|gdisk|parted|blkdiscard)\b|\bfdisk\s+(?!-l\b)|\bdd\b[^|;&\n]*\bof=(\/dev\/|\\\\\.\\)|\bsdelete\b|(>|\b(tee|cp|shred)\b[^|;&\n]*\s)\s*\/dev\/(sd|nvme|mmcblk|vd|hd|dm-|mapper\/|disk\/)/i;

/** Commands that print a stored login (a token, a password) to the screen (the full review, S2). */
const PRINTS_LOGIN =
  /\bgh\s+auth\s+(token\b|status\b[^|;&\n]*(--show-token|\s-t\b))|\bglab\s+(auth\s+token\b|config\s+get\s+token\b)|\bgit\s+(credential\s+fill|credential-manager\s+get)\b|\baz\s+account\s+get-access-token\b|\bgcloud\s+auth\s+print-(access|identity)-token\b|\baws\s+configure\s+get\s+\w*secret\w*|\bnpm\s+config\s+get\s+\S*_authtoken\b|\bdocker-credential-\w+\s+get\b/;

const BLOCKED_COMMANDS: [RegExp, string, null | 'ask' | 'disk'][] = [
  [DISK_WIPE, 'formats or wipes a drive', 'disk'],
  [
    /\brm\s+(-\S+\s+)*(\/|\/\*|--no-preserve-root|~\/?|~\/\*|"?\$\{?HOME\}?\/?"?)(\s|$)|\b(remove-item|ri|rd|rmdir|del)\b[^|;&\n]*\s["']?([a-z]:\\?|\$env:userprofile\\?|~\\?|\$home\\?)["']?(\s|$)/i,
    'deletes the whole system or home folder',
    null,
  ],
  // Asked first since 2026-11-11 (the user: only three hard stops; the rest asks): 'ask'.
  [
    /set-mppreference\b.*-disable|add-mppreference\b.*exclusion|\b(sc(\.exe)?|stop-service|set-service)\b.*\b(windefend|mpssvc|wscsvc|sense)\b|\bsetenforce\s+(0|permissive)\b/i,
    'turns off antivirus protection',
    'ask',
  ],
  [
    /set-netfirewallprofile\b.*-enabled\s+\$?(false|0)|netsh\s+(advfirewall\s+set\b.*\bstate\s+off|firewall\s+set\s+opmode\s+disable)|\b(remove|disable)-netfirewallrule\b|netsh\s+advfirewall\s+firewall\s+delete|\bsystemctl\s+(stop|disable|mask|kill)\b.*\b(firewalld|ufw|nftables|iptables)\b|\bufw\s+disable\b|\bip6?tables\s+(-F|--flush)\b|\bnft\s+flush\s+ruleset\b/i,
    'turns off or removes firewall protection',
    'ask',
  ],
  [
    new RegExp(
      String.raw`\bcmdkey\b|\bvaultcmd\b|get-storedcredential|\bmimikatz\b|\blsass\b|reg(\.exe)?\s+save\s+hklm\\(sam|security|system)|\.credentials\.json|\bwlan\s+show\s+prof\w*\b.*\bkey\s*=\s*clear|protecteddata|\bunprotect\(|hklm[\\:]+(sam|security)\b|\bsecret-tool\s+lookup\b|\bkwallet-query\b|${PRINTS_LOGIN.source}`,
      'i',
    ),
    'reads stored credentials',
    null,
  ],
];

/**
 * Why a blocked command can't run, said to the chat. There's no setting that allows these, so it
 * says so (it used to point at Harv's settings, where nothing unblocks them), and that a script
 * file or another shell is no way around it (the Win11 install chat, 2026-11-09).
 */
export function blockedReason(what: string, instead = ''): string {
  const drive = what.includes('drive') ? ' To erase a USB drive, use the format_drive tool.' : '';
  // It never tells Harv to hand the command to the user: Harv obeyed that and gave click-by-click steps (2026-11-11).
  return (
    `Never: this ${what}. It's one of Harv's three hard stops (per-token billing, reading login secrets, wiping the system), ` +
    `nothing lifts it and no other way (a script file, another shell) is allowed. Do the rest of the task, and say plainly what ` +
    `you couldn't do and why.${instead ? ` ${instead}` : ''}${drive}`
  );
}

// ── What really runs (the user's rule, 2026-11-09: blocks count only what runs) ──

/** The first hard stop (or old block that asks now) in what would run. */
function blockedIn(text: string): Verdict | null {
  for (const [re, what, kind] of BLOCKED_COMMANDS) {
    if (!re.test(text)) continue;
    if (kind === 'ask') return askFirst(`It ${what}.`, '');
    if (kind === 'disk') {
      const disks = judgeDisks(text);
      if (disks.kind === 'other')
        return askFirst(`It formats or wipes ${disks.names.join(' and ')}: everything on it is lost (not the system disk).`, '');
      return verdict(
        'blocked',
        blockedReason(
          disks.kind === 'system' ? 'wipes the disk the system runs from' : 'formats or wipes a drive Harv can’t identify',
          disks.kind === 'system'
            ? ''
            : 'Name the disk literally (a drive letter, Get-Disk number or /dev device, no variables or diskpart scripts) and it is asked first instead.',
        ),
        '',
      );
    }
    return verdict('blocked', blockedReason(what), '');
  }
  return null;
}

/**
 * Not a hard stop, but nothing Harv does on his own say-so: the user is asked first, even with
 * cards off (the user's rule, 2026-11-11: three hard stops, the rest that can't be undone asks).
 */
function askFirst(reason: string, summary: string, targets: string[] = []): Verdict {
  return { ...verdict('red', reason, summary, targets), ask: `${reason} Asked first: it can't simply be undone.` };
}

// ── Scripts a command runs (the user's rule, 2026-11-09: the gate reads them first) ──

const SCRIPT_FILE = /\.(ps1|psm1|sh|bash|zsh|bat|cmd|py|js|mjs|cjs|ts|mts|cts|tsx|rb|pl|php|vbs|wsf|lua)$/i;

const INTERPRETERS =
  /^(powershell|pwsh|bash|sh|zsh|dash|ksh|python3?|py|node|deno|bun|tsx|npx|ruby|perl|php|lua|luajit|cscript|wscript|cmd|source|\.|&|call)$/i;

/** Programs besides the interpreters that run the command they're given (so a quoted word after them may be a script). */
const RUNS_ITS_ARGS =
  /^(ssh|plink|wsl|invoke-command|icm|xargs|eval|exec|time|nohup|setsid|timeout|watch|nice|ionice|chroot|su|runuser|flatpak-spawn|toolbox|distrobox|docker|podman)(\.exe)?$/i;

/** Interpreter options that only check or print, never run the file (`bash -n x.sh`). */
const NOT_RUNNING = /^(-n|--check|-m|-c|-e|--version|-v|-h|--help)$/i;

/** Code that hides what it runs: the gate can't read it, so the user is asked. */
const HIDES_CODE =
  /frombase64string|-encodedcommand|\s-enc\s|\binvoke-expression\b|\biex\b|scriptblock\]::create|\beval\s*[("'$`]|\bexec\s*\(\s*(base64|codecs|zlib|bytes\.fromhex|marshal)|base64\s+(-d|--decode)\s*\|\s*(ba|z)?sh/i;

/**
 * The script files a command runs: one named as the program (`./x.sh`, `.\x.ps1`), the file an
 * interpreter runs (`python x.py`, `powershell -File x.ps1`), also inside quoted text
 * (`Start-Process powershell -ArgumentList '-File "x.ps1"'`, the Win11 chat's make-usb.ps1).
 * Copying, checking (`bash -n`) or reading a script isn't running it. Simple `$f = "x.ps1"`
 * variables are followed.
 */
export function scriptsRun(command: string, cwd = WORKSPACE, depth = 0): string[] {
  const vars = new Map<string, string>();
  for (const m of command.matchAll(/\$?([A-Za-z_]\w*)\s*=\s*(["'])([^"'\n]+)\2/g)) vars.set(m[1]!.toLowerCase(), m[3]!);
  const value = (w: string) => {
    const bare = unquote(w);
    const v = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(bare);
    return v ? (vars.get(v[1]!.toLowerCase()) ?? bare) : bare;
  };
  const found = new Set<string>();
  const add = (w: string | undefined) => {
    if (!w) return;
    const file = value(w);
    if (SCRIPT_FILE.test(file)) found.add(fullPath(file, cwd));
  };
  for (const segment of splitCommand(command)) {
    const ws = words(segment);
    let i = 0;
    while (i < ws.length && (/^(sudo|doas|env|start-process|saps|runas)$/i.test(unquote(ws[i]!)) || /^\w+=/.test(ws[i]!))) i++;
    const program = unquote(ws[i] ?? '').replace(/\.exe$/i, '');
    if (SCRIPT_FILE.test(value(ws[i] ?? ''))) add(ws[i]);
    else if (INTERPRETERS.test(program)) {
      // `npx tsx x.mts`: the runner after npx.
      const rest = ws.slice(i + 1).filter((w, k) => !(program === 'npx' && k === 0 && /^(tsx|ts-node)$/i.test(unquote(w))));
      const fileFlag = rest.findIndex((w) => /^-file$/i.test(w));
      if (fileFlag >= 0) add(rest[fileFlag + 1]);
      // Only the interpreter's own options count (`node x.mjs run -e …`: that -e is the script's).
      else if (
        !rest
          .slice(
            0,
            Math.max(
              0,
              rest.findIndex((w) => !w.startsWith('-')),
            ),
          )
          .some((w) => NOT_RUNNING.test(w))
      )
        add(rest.find((w) => !w.startsWith('-')));
      // Every further script handed to the first one is read too (`node resolve.mjs run x.lua`: the full review, R14).
      for (const w of rest.filter((x) => !x.startsWith('-')).slice(1, 6)) add(w);
    }
    // -File anywhere (Start-Process … -ArgumentList '-File "x.ps1"'), and commands inside quoted text.
    const flag = /-file\s+("[^"]+"|'[^']+'|\S+)/i.exec(segment);
    if (flag) add(flag[1]);
    // Quoted text is a command only when it reads like one (`'-File "x.ps1"'`, `'bash x.sh'`) or goes to
    // something that runs what it's given (`bash -c "./x.sh"`, `nohup "./x.sh"`). A lone quoted name
    // is just an argument: a file to copy, move, send, read, pack or hash (the Windows debloat chat,
    // 2026-11-22: `Move-Item "…\cleanup.ps1" …` and a Taildrop send were held for what the script does).
    const runsGiven = INTERPRETERS.test(program) || RUNS_ITS_ARGS.test(program.split(/[\\/]/).pop() ?? '');
    if (depth < 2)
      for (const q of segment.match(QUOTED) ?? []) {
        const inner = q.slice(1, -1);
        if (runsGiven || /\s/.test(inner.trim())) for (const f of scriptsRun(inner, cwd, depth + 1)) found.add(f);
      }
  }
  return [...found];
}

const TIER_ORDER: Tier[] = ['green', 'yellow', 'red', 'blocked'];

const worse = (a: Tier, b: Tier) => (TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b);

const MAX_SCRIPT_BYTES = 512 * 1024;

/**
 * What a command's scripts do, read before they run (scripts outside a project; a project's own
 * code is the project's business). A blocked line inside is blocked like a typed one; a script
 * that changes things is red; one that hides its code asks. Null when it runs no readable script.
 */
function scriptVerdict(command: string, ctx: ClassifyContext): Verdict | null {
  const cwd = ctx.project ?? WORKSPACE;
  const projects = [...(ctx.projects ?? []), ...(ctx.project ? [ctx.project] : [])];
  const found: Verdict[] = [];
  for (const path of scriptsRun(command, cwd)) {
    // A Resolve request runs inside Resolve, not in the project: always read (the full review, R14).
    if (!/\.lua$/i.test(path) && projects.some((p) => isInside(path, p))) continue;
    const name = path.split(/[\\/]/).pop() ?? path;
    // A script the gate can't read is never run unread (the full review, S7): one this same command
    // writes or downloads first is sent back (two calls, so it's read in between); one too big or unreadable asks.
    // Written by a heredoc in this same command (`cat > make.js <<'EOF' … EOF; node make.js`): its text is right here.
    const heredoc = existsSync(path) ? [] : splitHeredocs(command).bodies.filter((b) => DATA_RUNNERS.has(b.runner));
    const inline = heredoc.length > 0 && writtenBy(command, name) ? heredoc.map((b) => b.text).join('\n') : undefined;
    if (inline === undefined && !existsSync(path)) {
      if (writtenBy(command, name)) {
        const v = verdict(
          'blocked',
          `Write or download ${name} first, then run it in a separate call, so the gate can read it before it runs.`,
          `run ${name}`,
        );
        return { ...v, route: true };
      }
      continue;
    }
    let text: string;
    try {
      if (inline !== undefined) text = inline;
      else if (statSync(path).size > MAX_SCRIPT_BYTES) throw new Error('too big');
      else text = readFileSync(path, 'utf8');
    } catch {
      found.push({
        ...verdict('red', `${name} is too big (or unreadable) for Harv to check before it runs.`, `run ${name}`),
        ask: `${name} is too big (or unreadable) for Harv to check before it runs.`,
      });
      continue;
    }
    const ext = (/\.(\w+)$/.exec(name)?.[1] ?? '').toLowerCase();
    const runner =
      {
        ps1: 'powershell',
        psm1: 'powershell',
        bat: 'cmd',
        cmd: 'cmd',
        py: 'python',
        js: 'node',
        mjs: 'node',
        cjs: 'node',
        rb: 'ruby',
        pl: 'perl',
        php: 'php',
        ts: 'node',
        mts: 'node',
        cts: 'node',
        tsx: 'node',
        vbs: 'wscript',
        wsf: 'wscript',
        lua: 'lua',
      }[ext] ?? 'bash';
    const inside = (v: Verdict): Verdict => ({ ...v, reason: `Inside ${name}: ${v.reason}`, summary: `run ${name}` });
    if (runner === 'lua') {
      const lua = luaVerdict(text);
      if (lua.tier === 'blocked') return inside(lua);
      found.push(inside(lua));
      continue;
    }
    const blocked = blockedIn(runner === 'powershell' ? runningParts(maskHereStrings(text)) : commandsIn(runner, text));
    if (blocked) return inside(blocked);
    let v: Verdict;
    if (CODE_RUNNERS.has(runner)) {
      const changes =
        DELETE_API.test(text) ||
        PROCESS_API.test(text) ||
        /\b(shutil\.(move|copy\w*)|os\.(rename|replace)|writeFile\w*|open\([^)]*['"][wa])/i.test(text);
      v = changes
        ? verdict('red', 'The script changes files or starts other programs.', '', [])
        : verdict('yellow', 'The script runs code, but nothing in it changes files or starts programs.', '');
    } else v = classifyCommandAsIs(text, '', { ...ctx, ...(runner === 'powershell' || runner === 'cmd' ? { shell: 'powershell' } : {}) });
    if (HIDES_CODE.test(text) || hidesCode(text))
      v = { ...v, tier: worse(v.tier, 'red'), ask: `${name} hides what it runs (encoded or built at runtime), so Harv can't check it.` };
    found.push(inside(v));
  }
  if (found.length === 0) return null;
  // The worst script speaks for all of them (one that hides its code first); every target is backed up.
  const rank = (v: Verdict) => TIER_ORDER.indexOf(v.tier) * 2 + (v.ask ? 1 : 0);
  const top = found.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  return { ...top, targets: found.flatMap((v) => v.targets) };
}

/** The strings of Lua code ('…', "…", [[…]]). */
const luaStrings = (text: string) =>
  [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"|\[\[([\s\S]*?)\]\]/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');

/**
 * A Lua request for DaVinci Resolve (the resolve skill's bridge runs it inside Resolve, where the gate
 * can't see it: the full review, R14). Harv keeps full editing access (the user, 2026-11-17); the gate
 * refuses only the hard stops (a login secret, a wipe, a blocked shell command), and asks for a delete
 * outside Resolve (nothing backs it up) and for code built at runtime. Everything else runs.
 */
export function luaVerdict(text: string): Verdict {
  const summary = 'a DaVinci Resolve request';
  const shellCmds = [...text.matchAll(/\b(?:os\.execute|io\.popen)\s*\(\s*(?:'([^']*)'|"([^"]*)"|\[\[([\s\S]*?)\]\])/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? '',
  );
  for (const cmd of shellCmds) {
    const blocked = blockedIn(cmd);
    if (blocked) return { ...blocked, summary };
    if (wipeTarget(cmd, WORKSPACE)?.kind === 'system')
      return verdict('blocked', blockedReason('deletes the system or the home folder (from inside Resolve)'), summary);
  }
  const strings = luaStrings(text);
  if (strings.some((s) => isSensitivePath(s) || (/[\\/~]/.test(s) && isSecretFile(fullPath(expandVars(s))))))
    return verdict('blocked', blockedReason('reads login secrets (from inside Resolve)'), summary);
  for (const m of text.matchAll(/\b(?:os\.remove|ffi\.C\.(?:remove|unlink|rmdir))\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (wipeTarget(`rm -rf "${m[1]}"`, WORKSPACE)?.kind === 'system')
      return verdict('blocked', blockedReason('deletes the system or the home folder (from inside Resolve)'), summary);
  }
  const v = verdict('red', 'Runs a request inside DaVinci Resolve.', summary);
  if (
    /\bos\.(remove|rename)\s*\(|\bffi\.C\.(remove|unlink|rmdir|rename)\b/.test(text) ||
    shellCmds.some((c) => /(?<![\w.-])(rm|del|rd|rmdir|erase|remove-item|ri|shred|mv|move)\b/i.test(c))
  )
    return { ...v, ask: 'The request deletes or moves files outside Resolve, and nothing backs them up.' };
  if (/\b(loadstring|load)\s*\(\s*[^'"[\s)]|\bdofile\s*\(|\bloadfile\s*\(|:Execute\s*\(\s*[^'"[\s)]/.test(text))
    return { ...v, ask: "The request runs code built at runtime or from another file, which Harv can't check." };
  return v;
}

/** Does the command write or download a file of this name (`curl -o x.sh`, `> x.sh`, `tee x.sh`, `-OutFile x.ps1`)? */
function writtenBy(command: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // ssh's `-o Option=value` isn't an output file (the debloat chat: every scp was sent back as "write it first").
  const text = splitCommand(command)
    .map((s) => (runsSsh(s) ? s.replace(/\s-o\s*\S+/g, ' ') : s))
    .join('\n');
  return new RegExp(
    String.raw`(>>?|\btee\b|\bset-content\b|\badd-content\b|\bout-file\b|-outfile\b|\s-o\s|\s-O\s|--output\b|--output-document\b|-OutFile)\s*[^|;&\n]*?["']?[^\s"'|;&]*\b${n}\b`,
    'i',
  ).test(text);
}

/**
 * Where a plain curl/wget download saves to, as written (`.` for a file named by the
 * server in the current folder; none when it prints to the screen), or null when it isn't one.
 */
export function downloadTargets(segment: string): string[] | null {
  const ws = words(segment).map(unquote);
  const program = (ws[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  if ((program !== 'curl' && program !== 'wget') || sendsData(segment) || /[$`]/.test(segment)) return null;
  const out: string[] = [];
  let intoCwd = program === 'wget';
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i]!;
    if (program === 'curl') {
      if (w === '--output' || w === '--output-dir') out.push(ws[++i] ?? '');
      else if (/^--(output|output-dir)=/.test(w)) out.push(w.slice(w.indexOf('=') + 1));
      else if (w === '--remote-name' || w === '--remote-name-all') intoCwd = true;
      else if (/^-[a-zA-Z]+$/.test(w)) {
        if (w.includes('O')) intoCwd = true;
        if (w.endsWith('o')) out.push(ws[++i] ?? '');
      } else if (/^-o./.test(w)) out.push(w.slice(2));
    } else if (w === '-O' || w === '-P' || w === '-o' || w === '-a') {
      out.push(ws[++i] ?? '');
      if (w === '-O') intoCwd = false;
    } else if (/^--(output-document|directory-prefix|output-file|append-output)=/.test(w)) {
      out.push(w.slice(w.indexOf('=') + 1));
    }
  }
  if (intoCwd) out.push('.');
  return out.filter((t) => t !== '-' && t !== '/dev/null');
}

/** Red-action categories, for a clear reason in the held line and the action log. */
const RED_REASONS: [Rule, string][] = [
  // (?<![\w.-]): a word, not a flag or part of a name (`java -cp`, `docker run --rm`).
  [/(?<![\w.-])(rm|rmdir|rd|del|erase|remove-item|ri)\b/i, 'Deletes files or folders.'],
  [
    /\b(winget|choco|scoop|msiexec)\b|\b(npm|pnpm|yarn|pip3?)\s+(i|install|add|uninstall|remove)\b|\b(install|uninstall)-\w+/i,
    'Installs or uninstalls software.',
  ],
  [LINUX_INSTALL, 'Installs or uninstalls software.'],
  [/(?<![\w.-])(taskkill|kill|pkill|killall|stop-process|spps)\b/i, 'Stops running programs.'],
  [/(?<![\w.-])reg\b(?!\s+(query|export)\b)|\bregedit\b|-itemproperty\b|\bhk(lm|cu|cr|u|cc):?\\/i, 'Changes the Windows registry.'],
  [/\b(netsh|sc|bcdedit|powercfg|schtasks|setx|set-service|set-netadapter|set-executionpolicy)\b/i, 'Changes system settings.'],
  [LINUX_SYSTEM, 'Changes system settings.'],
  [/\b(sudo|pkexec)\b/i, 'Runs as administrator.'],
  [/\bgit\s+push\b/i, 'Pushes to a git remote.'],
  [sendsData, 'Sends data over the network.'],
  [scriptSends, 'Sends data over the network (from a script).'],
  [/(?<![\w.-])(mv|move|ren|rename|move-item|rename-item|cp|copy|xcopy|robocopy|copy-item)\b/i, 'Moves, renames or copies files.'],
  [/\.(ps1|bat|cmd|vbs|js|py|sh)\b|\b(python3?|py|node|powershell|pwsh|cmd|bash)\b/i, 'Runs a script or another shell.'],
  [/\b(set-content|add-content|out-file|new-item|tee)\b|>/i, 'Writes files.'],
];

/**
 * A command as it runs, for judging (the Bluetooth chat, 2026-11-10: opening the Sound window was
 * blocked): `Start-Process x -ArgumentList a,b` is `x a b` (so `Start-Process format -ArgumentList D:`
 * is a drive wipe), and a program run by its full path in the Windows folder is that program, not a
 * change to the folder. Other paths a command names are still judged as usual.
 */
export function asRun(command: string): string {
  let out = command;
  for (const segment of splitCommand(command)) {
    const text = segmentAsRun(segment);
    if (text !== null) out = out.replace(segment, text);
  }
  return out;
}

/** One segment as it runs, or null when it runs as written. */
function segmentAsRun(segment: string): string | null {
  let ws: string[] = words(segment);
  let changed = false;
  if (unquote(ws[0] ?? '') === '&') ws = ws.slice(1);
  {
    const first = unquote(ws[0] ?? '').toLowerCase();
    if (['start-process', 'saps'].includes(first) && !isOpenApp(segment) && !/-verb\s+runas|-credential/i.test(segment)) {
      let file = '';
      const args: string[] = [];
      for (let i = 1; i < ws.length; i++) {
        const w = ws[i]!;
        if (/^-(filepath|fi\w*)$/i.test(w)) file = unquote(ws[++i] ?? '');
        else if (/^-(argumentlist|args|a\w*)$/i.test(w)) {
          while (i + 1 < ws.length && !START_OPTION.test(ws[i + 1]!)) args.push(ws[++i]!);
        } else if (START_OPTION.test(w)) {
          if (!/^-(wait|nonewwindow|passthru|loaduserprofile|usenewenvironment)$/i.test(w)) i++;
        } else if (!file) file = unquote(w);
        else args.push(w);
      }
      if (!file) return null;
      const list = args
        .join(' ')
        .split(/\s*,\s*/)
        .map((a) => unquote(a.trim()))
        .filter(Boolean);
      ws = [file, ...list];
      changed = true;
    }
  }
  const program = WINDOWS_PROGRAM.exec(unquote(ws[0] ?? ''));
  if (program) {
    ws = [program[1]!, ...ws.slice(1)];
    changed = true;
  } else if (changed && /[\\/\s]/.test(ws[0] ?? '')) {
    // A program started by its path runs with the call operator, which is never read-only (the full review, S6).
    return `& "${ws[0]}"${ws.length > 1 ? ` ${ws.slice(1).join(' ')}` : ''}`;
  }
  if (!changed) return null;
  return ws.map((w, i) => (i === 0 && /\s/.test(w) ? `"${w}"` : w)).join(' ');
}

/** `start notepad`, `Start-Process https://…`, `explorer C:\…`, `control mmsys.cpl`: opening an app, page or document. */
function isOpenApp(segment: string): boolean {
  const [first = '', ...rest] = words(segment).map(unquote);
  const cmd = first.toLowerCase().replace(/^(notepad|calc|code)\.exe$/, '$1');
  // A Control Panel page: `control`, `control mmsys.cpl`, `control /name Microsoft.Sound`.
  if (/^control(\.exe)?$/.test(cmd))
    return rest.length === 0 || /^[\w.-]+\.cpl$/i.test(rest[0]!) || (rest[0] === '/name' && rest.length === 2);
  const windows = ['start', 'start-process', 'saps', 'invoke-item', 'ii', 'explorer', 'explorer.exe', 'notepad', 'calc', 'code'];
  if (![...windows, 'xdg-open', 'kde-open', 'kde-open5', 'dolphin', 'kate'].includes(cmd)) return false;
  if (/-verb\s+runas|-credential|-argumentlist/i.test(segment)) return false;
  const target = rest.filter((w) => !w.startsWith('-') && w !== '""')[0] ?? '';
  if (/^https?:\/\//i.test(target)) return true;
  if (EXECUTABLE.test(target)) return false;
  // A bare app name (no folder) or a document/folder path.
  return true;
}

/**
 * The new folders a command creates (`mkdir x`, `md x`, `New-Item -ItemType Directory -Path x [-Name y]`),
 * or null when it does anything else or a folder already exists.
 */
export function newFolders(command: string, cwd = WORKSPACE): string[] | null {
  const segments = splitCommand(command);
  if (segments.length === 0 || /\$\(|`|>/.test(command)) return null;
  const out: string[] = [];
  for (const segment of segments) {
    const ws = words(segment).map(unquote);
    const cmd = (ws[0] ?? '').toLowerCase();
    let targets: string[];
    if (cmd === 'mkdir' || cmd === 'md') {
      targets = ws.slice(1).filter((w) => !w.startsWith('-'));
    } else if (cmd === 'new-item' || cmd === 'ni') {
      const opts: Record<string, string> = {};
      const positional: string[] = [];
      for (let i = 1; i < ws.length; i++) {
        const w = ws[i]!;
        if (!w.startsWith('-')) positional.push(w);
        else if (w.toLowerCase() !== '-force') opts[w.slice(1).toLowerCase()] = ws[++i] ?? '';
      }
      if (!/^(directory|dir|container)$/i.test(opts.itemtype ?? opts.type ?? '')) return null;
      const base = opts.path ?? opts.literalpath ?? positional[0];
      if (!base && !opts.name) return null;
      targets = [opts.name ? join(base ?? '.', opts.name) : base!];
    } else {
      return null;
    }
    if (targets.length === 0) return null;
    for (const target of targets) {
      const path = fullPath(target, cwd);
      if (/[*?$]/.test(target) || existsSync(path)) return null;
      out.push(path);
    }
  }
  return out;
}

/** Making new folders can't destroy anything, so it's yellow (logged, Undo removes them) unless it's somewhere off-limits. */
function classifyNewFolders(folders: string[], summary: string, project?: string): Verdict {
  const protectedDir = loadSettings().protectedPaths.find((dir) => folders.some((f) => isInside(f, dir)));
  if (protectedDir) return askFirst(`It makes a folder in ${protectedDir}, which is on your read-only list.`, summary);
  if (folders.some(isSystemDir)) return askFirst(`It makes a folder in ${SYSTEM_FOLDER}.`, summary);
  if (folders.some(isHarvData)) return askFirst(HARV_DATA_REASON, summary);
  if (folders.every((f) => isInside(f, WORKSPACE))) return verdict('green', "Inside Harv's own workspace.", summary);
  if (project && folders.every((f) => isInside(f, project))) return verdict('green', 'Inside the project folder.', summary);
  if (folders.some(isProgramDir)) return verdict('red', 'It changes an installed program’s folder.', summary, folders);
  return verdict('yellow', 'Creates new folders.', summary, folders);
}

/** A system folder named in a Linux command (/etc, /usr…). */
const LINUX_SYSTEM_PATH = /(^|[\s"'=>])\/(boot|usr|etc|bin|sbin|lib|lib64|proc|sys|dev|root)(\/|\s|$)/;

/** Redirection into a file (`> out.txt`), ignoring harmless `2>&1` and `> $null`. */
const writesFile = (command: string) => />/.test(command.replace(/\d?>\s*(&\d|\$null|\/dev\/null|nul\b)/gi, ''));

/** A package manager installing (sudo for that runs: "normal installs just run", the user's rule 2026-11-11). */
const PACKAGE_INSTALL = /^(dnf|yum|apt|apt-get|zypper|pacman|flatpak|snap|rpm-ostree)\s+(-y\s+)?(install|-S\b|in\b)/i;

/** Runs something elevated, unless every elevated part is only a package install. */
function elevates(text: string): boolean {
  if (/-verb\s+runas\b|(?<![\w.-])runas(\.exe)?\s/i.test(text)) return true;
  // Each line on its own: `sudo -u root bash -c 'a; b'` comes here with its quoted part on new lines (S9).
  return splitCommand(text).some((segment) => {
    const m = /(?<![\w.-])(sudo|pkexec|doas)\s+((?:-[ugCh]\s+\S+\s+|-\S+\s+)*)([\s\S]*)$/i.exec(segment.trim());
    if (!m) return false;
    const rest = m[3]!.trim();
    // A package install runs; anything chained to it (`dnf install x; rm -rf …`) doesn't. `2>&1` is no chain.
    return !PACKAGE_INSTALL.test(rest) || /[;&|\n]/.test(rest.replace(/^["']|["']$/g, '').replace(/\d?>&\d/g, ''));
  });
}

/** Commits as another author: `--author=…`, `-c user.name=…`, or setting user.name/email. */
function signsAsSomeoneElse(text: string): boolean {
  return /\bgit\b[^|;&\n]*(\s--author[=\s]|\s-c\s+user\.(name|email)=)|\bgit\s+config\s+(--(global|local|system)\s+)?user\.(name|email)\s+["']?[^\s"'-]/i.test(
    text,
  );
}

/**
 * What the gate holds for the user's yes beyond the old blocks (persona rule 17): things that can't
 * simply be undone or backed up. Reads (`reg query`, `systemctl status`) and normal installs run.
 */
/** The folders whose programs start at login (Windows' Startup, Linux autostart): persona rule 22 (the full review, S15). */
const AUTOSTART =
  /[\\/]start menu[\\/]programs[\\/]startup\b|\bshell:(common\s*)?startup\b|[\\/]\.config[\\/]autostart\b|[\\/]etc[\\/]xdg[\\/]autostart\b/i;
const AUTOSTART_ASK = 'It adds or changes something that starts at login (persona rule 22: never by yourself). Asked first.';

const ASK_LIST: [Rule, string][] = [
  // Persona rule 22: Harv opens nothing to the network by himself (the full review, S15). Reading the state is fine.
  [/\btailscale(\.exe)?\s+(funnel|serve)\b(?!\s+(status|--help)\b)/i, 'It opens this computer to the network (Tailscale serve or Funnel).'],
  [
    /\bwinget\s+uninstall\b|\bmsiexec\b[^|;&\n]*\s[/-]x\b|\b(choco|scoop)\s+uninstall\b|\buninstall-(package|module|script)\b|\b(dnf|yum|apt|apt-get|zypper)\s+(-y\s+)?(remove|erase|autoremove|purge)\b|\bpacman\s+-R|\bflatpak\s+(uninstall|remove)\b|\bsnap\s+remove\b|\brpm\s+-e\b|\b(npm|pnpm|yarn|bun)\s+(uninstall|remove|rm)\b[^|;&\n]*(\s-g\b|--global)|(^|[\\/"'\s])(unins\d*|uninst[^\\/"'\n|;&]*)\.exe\b/i,
    'It uninstalls software.',
  ],
  [
    /\bpnputil\b|\badd-windowsdriver\b|\bdism\b[^|;&\n]*\/add-driver|(?<![\w.-])(modprobe|rmmod|insmod|dkms|akmods)\b/i,
    'It installs or removes a driver.',
  ],
  [
    /(?<![\w.-])reg(\.exe)?\s+(add|delete|import|load|unload|restore|copy)\b|\bregedit\b|\b(set|new|remove|rename)-itemproperty\b|\bremove-item\b[^|;&\n]*\bhk(lm|cu|cr|u|cc):/i,
    'It changes the Windows registry.',
  ],
  [
    /(?<![\w.-])sc(\.exe)?\s+(config|delete|stop|create|failure)\b|\b(set-service|stop-service|new-service|remove-service)\b|\bbcdedit\b|\bpowercfg\s+[/-](set|change|delete|h|hibernate|import)|\bset-executionpolicy\b|\bsystemctl\s+(--\S+\s+)*(stop|disable|mask|enable|restart|kill|isolate|set-default)\b|(?<![\w.-])(shutdown|reboot|poweroff|restart-computer|stop-computer)\b|\bschtasks\b[^|;&\n]*\/(create|delete|change)\b|\b(register|unregister)-scheduledtask\b/i,
    'It changes a system setting, a service, startup or power.',
  ],
  [/(?<![\w.-])(taskkill|pkill|killall|stop-process|spps)\b|(?<![\w.-])kill\s+(-\S+\s+)*\d/i, 'It stops running programs.'],
  [elevates, 'It runs as administrator.'],
  [
    /\bgit\s+push\b[^|;&\n]*(\s(-f|-d)\b|--force|--delete|--mirror|\s\+\S|\s:\S)|\b(gh|glab)\s+repo\s+delete\b|\b(gh|glab)\s+api\b[^|;&\n]*(-X|--method)[\s=]*(DELETE|PATCH|PUT|POST)\b/i,
    'It rewrites or deletes history or settings on the git server.',
  ],
  [signsAsSomeoneElse, 'It signs the work as someone else (another author).'],
  // The forms the first rows missed (the full review, S9): aliases, .NET and WMI calls, other cmdlets.
  [
    /\.kill\(\s*\)|\bwmic\b[^|;&\n]*\bprocess\b[^|;&\n]*\b(delete|terminate)\b|(?<![\w.-])xkill\b|(?<![\w.-])kill\s+(-\S+\s+)*\$\(|(^|\n)\s*kill\s*($|\n)|(?<![\w.-])kill\s+-name\b/i,
    'It stops running programs.',
  ],
  [/\bwmic\b[^|;&\n]*\bproduct\b[^|;&\n]*\buninstall\b|\bremove-appx(provisioned)?package\b/i, 'It uninstalls software.'],
  [
    /(?<![\w.-])sp\s+["']?hk(lm|cu|cr|u|cc):|\bnew-item\b[^|;&\n]*\bhk(lm|cu|cr|u|cc):|\[(microsoft\.win32\.)?registry(key)?\]::\w*(set|delete|create)\w*|\.(setvalue|deletevalue|deletesubkey\w*|createsubkey)\(/i,
    'It changes the Windows registry.',
  ],
  [
    /\b(re)?start-service\b|\bsuspend-service\b|(?<![\w.-])net\s+(stop|start)\b|\b(disable|enable|set)-scheduledtask\b|\bcrontab\s+(-e|-r|(?!-l\b)\S+)|\brundll32\b[^|;&\n]*powrprof/i,
    'It changes a system setting, a service, startup or power.',
  ],
  [
    /\b(new|set)-netfirewallrule\b|\bnetsh\s+advfirewall\s+firewall\s+(add|set)\b|\bfirewall-cmd\b[^|;&\n]*--(add|remove)|\bufw\s+(allow|deny|delete)\b/i,
    'It changes the firewall.',
  ],
  [/\bGIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)\s*=/i, 'It signs the work as someone else (another author).'],
  [/\b(gh|glab)\s+(release|repo|gist|secret|variable|label)\s+delete\b/i, 'It deletes something on the git server.'],
  [
    /\bsqlite3\b[^|;&\n]*\.harv[\\/][^|;&\n]*\b(delete|update|insert|drop|alter|vacuum|create|replace)\b/i,
    "It changes Harv's own data (the database): that can delete the Undo history.",
  ],
  // Not a hard stop (D7, the user's OK 2026-11-17): it overwrites only free space, no file is lost.
  [
    /\bcipher(\.exe)?\s+\/w\b/i,
    "It overwrites the drive's free space: deleted files can never be recovered after it, and it runs for hours.",
  ],
];

/** Local git commands that throw work away or rewrite history: backed up first, then they run. */
const LOCAL_GIT_REWRITE =
  /\bgit\s+(-C\s+\S+\s+)?(branch\s+(-D|--delete\s+--force|-d\s+-f|-df)\b|reflog\s+(expire|delete)\b|gc\b[^|;&\n]*--prune|filter-branch\b|filter-repo\b|update-ref\s+-d\b|stash\s+(drop|clear)\b|reset\s+--hard\b|clean\b|checkout\s+(--\s|\.(\s|$)|-f\b)|restore\s+(?!--staged)|rebase\b|commit\b[^|;&\n]*--amend|tag\s+-d\b)/i;

/** The git repo a command works in: `git -C x`, a leading `cd x`, or where it runs; null outside a repo. */
function gitRoot(command: string, cwd: string): string | null {
  const dashC = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command)?.[1];
  const [first = ''] = splitCommand(command);
  const ws = words(first).map(unquote);
  const cd = /^(cd|chdir|set-location|sl|pushd)$/i.test(ws[0] ?? '') ? ws.slice(1).find((w) => !w.startsWith('-')) : undefined;
  let dir = fullPath(unquote(dashC ?? cd ?? cwd), cwd);
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = join(dir, '..');
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** A repo's changed and new files (what reset --hard or clean would lose), at most 200. */
function dirtyFiles(root: string): string[] {
  const r = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all', '-z'], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split('\0')
    .filter((e) => e.length > 3 && !e.startsWith('D'))
    .map((e) => join(root, e.slice(3)))
    .filter((p) => existsSync(p))
    .slice(0, 200);
}

const SECRETS_BLOCKED = 'Blocked: it touches files that may hold credentials or secrets.';

/** The shell a remote command is written for (the notebook's Windows side answers in PowerShell). */
const remoteShell = (text: string): 'powershell' | 'bash' =>
  /\$env:|\b(Get|Set|New|Remove|Test|Select|Where|ForEach|Start|Stop|Invoke|Add|Out|Write)-[A-Z]\w+|-ErrorAction\b/.test(text)
    ? 'powershell'
    : 'bash';

/** What a command does on another computer (over ssh), judged with that computer's paths, not this one's. */
interface RemoteJudged {
  part: RemotePart;
  verdict: Verdict;
  running: string;
}

function judgeRemote(part: RemotePart, summary: string, ctx: ClassifyContext): RemoteJudged {
  let text = part.text;
  if (part.input) {
    const file = fullPath(part.input, ctx.project ?? WORKSPACE);
    try {
      if (existsSync(file) && statSync(file).size <= MAX_SCRIPT_BYTES) text = `${text}\n${readFileSync(file, 'utf8')}`;
    } catch {
      /* Unreadable: judged by what's typed. */
    }
  }
  const shell = remoteShell(text);
  // That computer's folders aren't this one's project, attachment or workspace.
  const there: ClassifyContext = { ...ctx, project: undefined, attachedRoot: undefined, shell };
  let v = classifyCommandAsIs(asRun(text), summary, there);
  // Which files exist there is unknown here, so only a secret named outright counts (a search
  // reaching this PC's secrets says nothing about that computer: the debloat chat's part 1).
  if (v.tier === 'blocked' && v.reason === SECRETS_BLOCKED && !mentionsSecret(text, shell === 'powershell'))
    v = verdict('red', 'Runs a command that could change things there.', summary);
  return { part, verdict: v, running: runningText(text, there) };
}

export function classifyCommand(command: string, description = '', ctx: ClassifyContext = {}): Verdict {
  const summary = description || command.split(/\r?\n/)[0]!.slice(0, 120);
  // Commands that run on another computer (ssh) are judged apart: their paths are that computer's
  // (the Windows debloat chat, 2026-11-22: a log read on the notebook was held as a change to this
  // PC's Windows folder). The hard stops count there too.
  const { local, remote } = splitRemote(command);
  const there = remote.map((part) => judgeRemote(part, summary, ctx));
  const stop = there.find((r) => r.verdict.tier === 'blocked');
  if (stop) return { ...stop.verdict, summary, targets: [] };
  const typed = classifyCommandAsIs(asRun(local), summary, ctx);
  const script = typed.tier === 'blocked' ? null : scriptVerdict(local, ctx);
  let v: Verdict =
    script && (TIER_ORDER.indexOf(script.tier) >= TIER_ORDER.indexOf(typed.tier) || script.ask)
      ? { ...script, tier: worse(script.tier, typed.tier), summary: typed.summary, targets: [...typed.targets, ...script.targets] }
      : typed;
  if (v.tier === 'blocked') return v;
  // Only ssh here: what runs there decides (a read there is a read; nothing here to back up).
  if (there.length && onlyReachesOut(local) && !v.ask) {
    const top = there.reduce((a, b) => (TIER_ORDER.indexOf(b.verdict.tier) > TIER_ORDER.indexOf(a.verdict.tier) ? b : a));
    const host = top.part.host;
    v =
      top.verdict.tier === 'green'
        ? verdict('green', `Only reads, on ${host}.`, summary)
        : // An ask there about its own folders isn't this PC's (the asks that count are taken below).
          verdict('red', top.verdict.ask ? `Runs commands on ${host}.` : `On ${host}: ${top.verdict.reason}`, summary);
  }
  const running = runningText(local, ctx);
  // Code the gate can't read (the full review, S7; D3, the user's OK 2026-11-17): a download run in one
  // go is sent back (download to a file, then run it: the gate reads it in between); encoded or
  // runtime-built code asks. Prints and searches don't count (`echo "curl x | bash"`).
  const written = ctx.shell === 'powershell' ? local : splitHeredocs(local).shell;
  const hidden = hidesCode(written, running);
  if (hidden?.kind === 'fetched') {
    return {
      ...verdict(
        'blocked',
        'That downloads a script and runs it unread. Download it to a file in the workspace first, then run the file in a separate call: the gate reads it before it runs.',
        v.summary,
      ),
      route: true,
    };
  }
  // Inline Lua for the Resolve bridge (`resolve.mjs run -e "…"`), read like a request file (R14).
  const inlineLua = /resolve\.mjs["']?\s+run\s+-e\s+([\s\S]+)$/i.exec(command);
  if (inlineLua) {
    const lua = luaVerdict(unquote(inlineLua[1]!.trim()));
    if (lua.tier === 'blocked') return { ...lua, summary: v.summary };
    if (lua.ask && !v.ask) v = { ...v, tier: worse(v.tier, 'red'), ask: lua.ask };
  }
  if (hidden?.kind === 'encoded' && !v.ask)
    v = { ...v, tier: worse(v.tier, 'red'), ask: `${hidden.why} Harv can't check what it does, so it's asked first.` };
  // Persona rule 17's list, in project chats too (the user's rules, 2026-11-11): held until the user says yes.
  // A program this same command started in the background is Harv's own to stop (dropOwnKills).
  const kind = ASK_LIST.find(([rule]) => matches(rule, dropOwnKills(running, ctx.started, ctx.project)));
  if (kind && !v.ask) v = { ...v, tier: 'red', ask: `${kind[1]} Asked first: it can't simply be undone.` };
  // The same list on the other computer (it held only by accident before: a registry write there ran
  // unasked while a read was held), and what can't be undone there: a whole drive, code it hides.
  for (const r of there) {
    if (v.ask) break;
    const hidden = hidesCode(r.part.text, r.running);
    const theirs = ASK_LIST.find(([rule]) => matches(rule, r.running));
    const ask = theirs
      ? `${theirs[1]} Asked first: it can't simply be undone.`
      : hidden
        ? `${hidden.why} Harv can't check what it does, so it's asked first.`
        : AUTOSTART.test(r.running)
          ? AUTOSTART_ASK
          : /^It deletes everything on /.test(r.verdict.reason)
            ? r.verdict.ask
            : undefined;
    if (ask) v = { ...v, tier: 'red', ask: `On ${r.part.host}: ${ask}`, remote: r.part.host };
  }
  // Persona rule 22: nothing starts at login unless the user asks (reading the folder is fine).
  if (!v.ask && v.tier !== 'green' && AUTOSTART.test(running)) v = { ...v, tier: 'red', ask: AUTOSTART_ASK };
  // Throwing away local git work runs, after a backup of the repo's .git and its changed files (the ShopNotes chat's branch -D).
  if (LOCAL_GIT_REWRITE.test(running)) {
    const root = gitRoot(command, ctx.project ?? WORKSPACE);
    if (root) {
      v = {
        ...v,
        tier: worse(v.tier, 'yellow'),
        reason: v.tier === 'green' ? 'Rewrites or throws away local git work (the repo is backed up first, Undo).' : v.reason,
        keep: [join(root, '.git')],
        targets: [...v.targets, ...dirtyFiles(root)],
      };
    }
  }
  return v;
}

function classifyCommandAsIs(command: string, description: string, ctx: ClassifyContext): Verdict {
  const cwd = ctx.project ?? WORKSPACE;
  const summary = description || command.split(/\r?\n/)[0]!.slice(0, 120);
  const blocked = blockedIn(runningText(command, ctx));
  if (blocked) return { ...blocked, summary };
  // Before the green paths: `$env:ANTHROPIC_BASE_URL = …` alone could otherwise pass as harmless (S8).
  if (setsBillingEnv(command, runningText(command, ctx)))
    return verdict('blocked', blockedReason('would switch Claude Code to per-token billing'), summary);
  // Deleting home, the system or a drive whole, however it is spelled (the full review, S3).
  // The command as written (the "what runs" text loses pipes), and the shell heredocs it runs.
  const written = ctx.shell === 'powershell' ? { shell: command, bodies: [] } : splitHeredocs(command);
  const wipe = [written.shell, ...written.bodies.filter((b) => runsAsShell(b.runner)).map((b) => b.text)]
    .map((text) => wipeTarget(text, cwd))
    .find(Boolean);
  if (wipe?.kind === 'system')
    return verdict('blocked', blockedReason(`deletes ${wipe.path} whole (the system or the home folder)`), summary);
  if (wipe?.kind === 'drive') return { ...askFirst(`It deletes everything on ${wipe.path}.`, summary), summary };
  // Heredoc bodies are scripts or data: the shell rules below read only the shell lines around them.
  const { shell, bodies } = ctx.shell === 'powershell' ? { shell: command, bodies: [] } : splitHeredocs(command);
  // Judged from the starting folder only up to the first `cd`: after it the walk below knows where each
  // part runs (2026-11-25: `cd ~/tools/decomp/x && grep -rn y ../..` was read from the project as home).
  // The walk skips PowerShell's `$x = …` lines, so the parts before a `cd` are still read this way too.
  const allParts = splitCommand(shell).map((segment) => words(segment).map(unquote));
  const firstCd = allParts.findIndex((ws) => /^(cd|chdir|set-location|sl|pushd)$/i.test(ws[0] ?? ''));
  const parts = firstCd < 0 ? allParts : allParts.slice(0, firstCd);
  if (
    mentionsSecret(shell, ctx.shell === 'powershell') ||
    reachesSecret(parts, cwd, ctx.shell === 'powershell') ||
    // The same, part by part where each really runs (after a `cd`, inside `bash -c` or `cmd /c`): the full review, S2.
    reachesSecret(walkCommand(shell, cwd), cwd, ctx.shell === 'powershell') ||
    substitutionReadsSecret(shell, cwd) ||
    bodies.some((b) => scriptPaths(b.text).some(isSensitivePath))
  ) {
    return verdict('blocked', SECRETS_BLOCKED, summary);
  }

  const segments = splitCommand(shell);
  const substitutes = /\$\(|`|\binvoke-expression\b|\biex\b|-encodedcommand|\s-enc\s/i.test(shell);
  const tokens = segments.flatMap((s) => words(withoutAssignments(s) || s).map((w) => unquote(w).toLowerCase()));

  // git's read-only subcommands, print-only sed and awk are fine although they're on the changing list.
  const readOnly = (part: string) => {
    const segment = withoutAssignments(part);
    if (segment === '') return true;
    const ws = words(segment).map((w) => unquote(w).toLowerCase());
    if (isReadOnlyProgram(ws[0] ?? '', ws.slice(1))) return true;
    if (!isGreenSegment(segment)) return false;
    return ['git', 'sed', 'awk', 'gawk', 'journalctl', 'ip'].includes(ws[0] ?? '') || !ws.some((t) => CHANGING_WORDS.has(t));
  };
  // A plain download into the workspace, the temp folder or the project. After a `cd`, a file named by the server could land anywhere.
  const changesDir = segments.some((s) => /^(cd|chdir|set-location|sl|pushd)$/i.test(words(s)[0] ?? ''));
  const download = (segment: string) => {
    const targets = downloadTargets(segment);
    if (!targets || (changesDir && targets.some((t) => !/^([a-z]:)?[\\/]|^~[\\/]/i.test(t)))) return false;
    return targets
      .map((t) => fullPath(t, cwd))
      .every((t) => isInside(t, WORKSPACE) || isTempDir(t) || (ctx.project !== undefined && isInside(t, ctx.project)));
  };

  if (!substitutes && !writesFile(shell) && segments.length > 0 && bodies.length === 0) {
    if (segments.length === 1 && isOpenApp(segments[0]!)) return verdict('green', 'Opens an app, page or document.', summary);
    if (segments.every(readOnly) && !CHANGING_CMDLET.test(shell)) return verdict('green', 'Only reads information.', summary);
    if (segments.every((s) => readOnly(s) || download(s)) && !CHANGING_CMDLET.test(shell)) {
      return verdict('green', 'Only reads, or downloads into the workspace, the temp folder or the project.', summary);
    }
  }
  if (ctx.shell === 'powershell' && !writesFile(command) && isReadOnlyPowerShell(command)) {
    return verdict('green', 'Only reads information.', summary);
  }

  const folders = bodies.length === 0 ? newFolders(shell, cwd) : null;
  if (folders) return classifyNewFolders(folders, summary, ctx.project);

  const paths = pathsInCommand(shell, cwd);
  const settings = loadSettings();
  const mentions = (test: (p: string) => boolean, pattern: RegExp) => paths.some(test) || pattern.test(command);
  const protectedDir = settings.protectedPaths.find((dir) => mentions((p) => isInside(p, dir), new RegExp(escapeRegExp(dir), 'i')));
  if (protectedDir)
    return askFirst(
      `It would change ${protectedDir}, which is on your read-only list.`,
      summary,
      paths.filter((p) => !isSystemDir(p)),
    );
  if (IS_WINDOWS && mentions(isSystemDir, /\b[a-z]:[\\/]windows\b|\/c\/windows\b|%windir%|%systemroot%|\$env:(windir|systemroot)/i)) {
    return askFirst('It changes the Windows folder.', summary);
  }
  // Linux guards its own folders (they belong to root), so only sudo could change them.
  const changesAsRoot = tokens.some((t) => CHANGING_WORDS.has(t) && t !== 'sudo' && t !== 'pkexec') || writesFile(shell);
  if (!IS_WINDOWS && /\b(sudo|pkexec)\b/.test(command) && changesAsRoot && mentions(isSystemDir, LINUX_SYSTEM_PATH)) {
    return askFirst(`It changes ${SYSTEM_FOLDER} as administrator.`, summary);
  }
  // Reading Harv's logs or settings is fine; anything that could change them asks first.
  // Separators can come doubled: code writes Windows paths with escaped backslashes ("C:\\Users\\…\\.harv\\workspace").
  // Judged per part: a temp folder deleted next to a search in ~/.harv/tools was held (2026-11-11).
  // A `cd` could move a changing part into ~/.harv, so then the whole command counts.
  // `~/.harv/…` (not the workspace), or `~/.harv` itself (`cd ~/.harv && rm -rf backups`).
  // ~/.harv/tools is the skills' own tools (the full review, K17), free like the workspace.
  const HARV_PATH = /\.harv(?:[\\/]+(?![\\/])(?!(?:workspace|tools)([\\/"'\s]|$))|[\\/]*(?=["'\s;&|)]|$))/i;
  const harvIn = (text: string) => HARV_PATH.test(text) || pathsInCommand(text, cwd).some(isHarvData);
  // A copy out of ~/.harv (a backup of harv.db to the temp folder) only reads Harv's data (2026-11-14 hold).
  const copiesOut = (s: string) => {
    const to = copyDestination(s);
    return to !== undefined && !harvIn(to);
  };
  // Inline code that only reads (`python -c "…open(p)…"`) reads Harv's data or a session log; it doesn't change them (2026-11-21).
  const inert = (s: string) => inertInlineCode(words(withoutAssignments(s) || s).map(unquote), HIDES_CODE);
  const changingPart = (s: string) =>
    !readOnly(s) &&
    !inert(s) &&
    !copiesOut(s) &&
    (words(withoutAssignments(s) || s).some((w) => CHANGING_WORDS.has(unquote(w).toLowerCase())) || CHANGING_CMDLET.test(s));
  // Judged per part: a `git ls-remote` doesn't make the `ls ~/.harv/sync` next to it a change (2026-11-10).
  // Not the copy-out exception: after a `cd ~/.harv` a copy's relative target lands in ~/.harv.
  const changingOwn = segments.some(
    (s) =>
      !readOnly(s) &&
      !inert(s) &&
      (words(withoutAssignments(s) || s).some((w) => CHANGING_WORDS.has(unquote(w).toLowerCase())) || CHANGING_CMDLET.test(s)),
  );
  const changesHarv = changesDir ? changingOwn && mentions(isHarvData, HARV_PATH) : segments.some((s) => changingPart(s) && harvIn(s));
  if (changesHarv || ((writesFile(shell) || bodies.length > 0) && mentions(isHarvData, HARV_PATH))) {
    return askFirst(HARV_DATA_REASON, summary);
  }
  if (
    (changingOwn || writesFile(shell) || bodies.length > 0) &&
    mentions((p) => isClaudeHistory(p) && !isClaudeMemory(p), /\.claude[\\/]+projects[\\/]+(?![^\\/\s"']+[\\/]+memory\b)/i)
  ) {
    return askFirst("It changes Claude Code's session history.", summary);
  }
  if (ctx.project) {
    const trusted = classifyInProject(command, summary, ctx.project, paths);
    if (trusted) return trusted;
  }
  if (ctx.attachedRoot) {
    const given = classifyInAttached(command, summary, ctx.attachedRoot, paths);
    if (given) return given;
  }

  const reason = RED_REASONS.find(([rule]) => matches(rule, shell))?.[1] ?? 'Runs a command that could change your PC.';
  return verdict(
    'red',
    reason,
    summary,
    paths.filter((p) => !isSystemDir(p) && !isProgramDir(p)),
  );
}

// ── Project chats: the project folder is trusted (the user's choice, docs/PLAN.md §6f) ──

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
