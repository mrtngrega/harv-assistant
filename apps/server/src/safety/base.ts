import type { Tier } from '@harv/shared';

export interface Verdict {
  tier: Tier;
  /** Why it got this tier, in plain words. */
  reason: string;
  /** What the call does, in plain words. */
  summary: string;
  /** Paths to back up before it runs (yellow and red). */
  targets: string[];
  /** Held in the chat for the user's yes (`gate.ts` hold): the reason shown. Red without it runs. */
  ask?: string;
  /** Refused only by this tool, not as an action: the reason names the tool to use instead. */
  route?: boolean;
  /** Folders backed up whole before it runs, even though the command doesn't name them (a repo's `.git`). */
  keep?: string[];
  /** The ask is about commands that run on this other computer (as written: `user@host`), not this one. */
  remote?: string;
  /** The call runs with this input instead (a Grep with the secret files left out). */
  rewrite?: Record<string, unknown>;
}

/** Harv's own tool that types a command into the chat's visible terminal (PowerShell on Windows, the user's shell elsewhere). */
export const TERMINAL_RUN = 'mcp__harv__terminal_run';

/** Formats a USB drive: always a card, the one action card left (the user's wish, 2026-11-09). */
export const FORMAT_DRIVE = 'mcp__harv__format_drive';

/** Built-in tools Harv may use; anything else is refused. Every tool that runs a shell command is checked as one. */
export const SHELL_TOOLS = ['Bash', 'PowerShell', TERMINAL_RUN];

export const FILE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch'];

/**
 * Claude Code's own bookkeeping tools (every chat has Claude Code's toolset since 2026-10-27):
 * task lists, subagents (whose tool calls pass the gate themselves), plan mode, watching or
 * stopping a shell Harv started in the background.
 */
export const AGENT_TOOLS = [
  'TodoWrite',
  'Task',
  'Agent',
  'ExitPlanMode',
  'EnterPlanMode',
  'BashOutput',
  'KillShell',
  'KillBash',
  // Background agents: listing them, messaging them, reading or stopping their output (the user's wish 2026-10-25).
  'ListAgents',
  'SendMessage',
  'TaskOutput',
  'TaskStop',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  // Skills and slash commands only load instructions; what they then do is checked tool by tool.
  'Skill',
  'SlashCommand',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  // Asking the user a question shows a question card (gate.ts); nothing runs.
  'AskUserQuestion',
];

/**
 * Claude Code's own schedulers live only as long as the session (or run in the cloud, billed
 * per run on some plans): Harv schedules with its own tools instead, run by Harv's server.
 */
export const SCHEDULER_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger'];

// hand_off only starts a turn in another chat; everything that chat does passes the gate itself.
export const HARV_TOOLS = [
  'mcp__harv__remember',
  'mcp__harv__recall',
  'mcp__harv__forget',
  'mcp__harv__list_chats',
  'mcp__harv__read_chat',
  'mcp__harv__hand_off',
  'mcp__harv__list_projects',
  'mcp__harv__report_note',
  'mcp__harv__project_status',
  'mcp__harv__harv_db',
  'mcp__harv__start_project',
  'mcp__harv__open_project',
  'mcp__harv__schedule_task',
  'mcp__harv__list_scheduled',
  'mcp__harv__cancel_scheduled',
  'mcp__harv__terminal_read',
  // Sends the prompt (and pictures the user gave for it) to Gemini, like a web search.
  'mcp__harv__generate_image',
  'mcp__harv__list_drives',
  // Changes this chat's model pick, like the header switcher.
  'mcp__harv__set_model',
  // Reads a recording or video and writes text, all on this computer (voice/stt.ts).
  'mcp__harv__transcribe',
  // Reads the plan meters Harv already holds.
  'mcp__harv__plan_usage',
];

export const verdict = (tier: Tier, reason: string, summary: string, targets: string[] = []): Verdict => ({
  tier,
  reason,
  summary,
  targets,
});

export const str = (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');

/** Where a call runs: in a project chat, the project folder (trusted, and the base for relative paths). */
export interface ClassifyContext {
  project?: string;
  /**
   * Every registered project folder. Any chat working inside one gets the project's
   * trust (a command that starts with `cd <project>`, or a file in it).
   */
  projects?: string[];
  /** Which shell runs a command: PowerShell commands get the read-only analysis below. */
  shell?: 'powershell' | 'bash';
  /** Files and folders on the PC the user attached to this chat (the user gave them, so they're trusted). */
  attached?: string[];
  /** The attached file or folder a command works in (set by `classify`). */
  attachedRoot?: string;
  /** Programs Harv started himself in this chat (lines of earlier commands): his own to stop (`dropOwnKills`). */
  started?: readonly string[];
}

/** Words that change something, wherever they appear in a command. */
export const CHANGING_WORDS = new Set(
  (
    'rm rmdir rd del erase mv move cp copy xcopy robocopy ren rename mkdir md touch chmod chown ln kill taskkill pkill shutdown reg regedit sc net netsh ' +
    'schtasks wmic msiexec winget choco scoop npm npx pnpm yarn pip pip3 curl wget powershell pwsh cmd bash sh python python3 py node deno bun start ' +
    'sudo runas iex icacls takeown attrib cipher bcdedit powercfg setx tee dd sed awk perl ruby git -exec -delete -ok ' +
    'dnf yum rpm apt apt-get snap flatpak systemctl pkexec crontab mount umount useradd userdel usermod passwd shred truncate killall'
  ).split(' '),
);

export const CHANGING_CMDLET =
  /\b(remove|set|new|add|clear|stop|start|restart|install|uninstall|move|rename|copy|invoke|enable|disable|register|unregister|update|export|import|reset|suspend|resume|mount|dismount|initialize|expand|compress|send|publish|grant|revoke|block|unblock|lock|unlock|protect|unprotect|restore|backup|save|submit|edit|merge|push|pop|out-file)-[a-z]+\b|\b(write|format)-(?!output\b|host\b|table\b|list\b|wide\b|custom\b)[a-z]+\b/i;

/** Linux package managers installing, removing or upgrading software. */
export const LINUX_INSTALL =
  /\b(dnf|yum|apt|apt-get|snap|flatpak)\s+(\S+\s+)*?(install|remove|erase|uninstall|reinstall|upgrade|autoremove)\b|\brpm\s+-[a-z]*[iue]/i;

/** Linux system changes: services, scheduled jobs, mounts, users, kernel and network settings. */
export const LINUX_SYSTEM =
  /\b(systemctl\s+(?!(status|list-\S+|is-\S+|show|cat)\b)\S+|crontab|mount|umount|useradd|userdel|usermod|passwd|hostnamectl\s+set-\S+|timedatectl\s+set-\S+|nmcli\s+(con|connection|dev|device|radio|networking)\s+(?!(show|status)\b)\S+|sysctl\s+-w|grubby|modprobe|rmmod)\b/i;

/** A pattern, or a check that needs more than one (like reading curl's flags). */
export type Rule = RegExp | ((command: string) => boolean);

export const matches = (rule: Rule, text: string) => (typeof rule === 'function' ? rule(text) : rule.test(text));
