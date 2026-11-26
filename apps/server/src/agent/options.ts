import { skillMapText, skillsFor } from './skillMap.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfContext } from './harvSelf.ts';
import type { HookCallbackMatcher, HookEvent, McpStdioServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import { HARV_VERSION, type EffortLevel, type Project } from '@harv/shared';
import { IS_WINDOWS, OS_NAME } from '../platform.ts';
import { DESKTOP_SERVER, type WorkArea } from '../safety/desktop.ts';
import type { SafetyGate } from '../safety/gate.ts';
import { PLANS_DIR, WORKSPACE } from '../safety/paths.ts';
import { workDir } from '../settings.ts';
import type { ChatStore } from '../store/chats.ts';
import {
  harvServer,
  recentChatsContext,
  type BrowserTools,
  type ModelTools,
  type Delegate,
  type ProjectTools,
  type ImageTools,
  type ScheduleTools,
  type TerminalTools,
} from './chatTools.ts';
import { stripBilledCredentials } from '../env.ts';
import { blockedFetchNote } from './blockedPages.ts';
import { codeMapPath, refreshCodeMap } from './codeMap.ts';
import { memoryContext } from './memory.ts';

/** Login sources that mean the user's subscription (never per-token API billing). */
export const SUBSCRIPTION_KEY_SOURCES = new Set(['none', 'oauth']);

function subscriptionEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: `harv/${HARV_VERSION}`,
  };
  // Windows tasks go best through PowerShell; Bash (Git Bash) stays available too. Linux has Bash only.
  if (IS_WINDOWS) env.CLAUDE_CODE_USE_POWERSHELL_TOOL = '1';
  // `env` replaces the subprocess environment, so this guarantees no API key reaches Claude Code.
  stripBilledCredentials(env);
  return env;
}

/** Harv's shared rulebook (repo root `harv/persona.md`); dev sessions follow the same file. */
const PERSONA_PATH = fileURLToPath(new URL('../../../../harv/persona.md', import.meta.url));
/** How the user likes project work done (repo root `harv/dev-rules.md`), loaded in project chats. */
const DEV_RULES_PATH = fileURLToPath(new URL('../../../../harv/dev-rules.md', import.meta.url));

const readText = (path: string, fallback = '') => (existsSync(path) ? readFileSync(path, 'utf8').trim() : fallback);
export const todayText = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/**
 * A session's prompt says the day it started; a chat used after midnight (or a notebook asleep
 * overnight) gets the new date once, in front of the message (the full review, K19). The prompt
 * itself stays as is (changing it would lose the prompt cache). A spoken turn has the clock already.
 */
export function dayNote(session: { promptDay: string } | undefined, spoken: boolean, today = todayText()): string {
  if (!session?.promptDay || session.promptDay === today) return '';
  session.promptDay = today;
  return spoken ? '' : `[It is now ${today}; the date in your instructions is from when this chat started.]\n\n`;
}

/** The chat tab a session belongs to: its tools to see the other chats, and the safety gate. */
export interface ChatContext {
  store: ChatStore;
  tabId: string;
  gate: SafetyGate;
  /** Hands a task to another chat (the hand_off tool). */
  delegate?: Delegate;
  /** The project this chat works on: the session then runs as Claude Code in that folder (project mode). */
  project?: Project;
  /** The user asked for a skill a normal chat doesn't list: this chat loads all of them, like a project chat. */
  allSkills?: boolean;
  /** Harv's start_project / open_project / list_projects tools. */
  projects?: ProjectTools;
  /** Harv's schedule_task / list_scheduled / cancel_scheduled tools. */
  schedules?: ScheduleTools;
  /** Harv's terminal_run / terminal_read tools. */
  terminal?: TerminalTools;
  /** Harv's generate_image tool. */
  images?: ImageTools;
  /** Harv's browser_* tools. */
  browser?: BrowserTools;
  /** Harv's set_model tool: the chat's own model pick. */
  models?: ModelTools;
  /** Desktop control (Windows-MCP, docs/PLAN.md §6t item 1), when the user turned it on on this computer. */
  desktop?: McpStdioServerConfig;
  /** The monitor desktop control works on, when the PC has more than one (the user's pick, else the smallest). */
  desktopArea?: WorkArea | null;
  /** A note after a tool call when the session runs out mid-reply: stop cleanly (usage/budget.ts). */
  usageStop?: () => string;
}

/** Windows-MCP's own rules: the pill is out of captures, and the user's input pauses Harv. */
const WINDOWS_DESKTOP = `A pill on the user's screen shows what you're doing and lets them stop you; it's left out of screenshots. The desktop is the user's first: an action fails with USER_CONTROL when they used the mouse or keyboard in the last 10 seconds (their message and the 15 seconds after it don't count), so then wait 10 seconds with PowerShell's \`Start-Sleep 10\` (the desktop tools, Wait and Snapshot included, are refused too while the user is active) and try once more. If it fails again, or with CONTROL_PREEMPTED (they moved the mouse while you worked), they've taken over: stop and ask.`;

/** Harv's Linux server (tools/linux_desktop.py, KDE on Wayland, docs/PLAN.md §6af). */
const LINUX_DESKTOP = `On this Linux computer (KDE Plasma, Wayland): Snapshot reads the window in front (or the one you name with \`window\`, part of its title or app name) and lists the other windows; Click and Type by label press the element itself without moving the mouse, so prefer labels; a loc moves the real mouse. Some apps (Chrome, Electron apps like Discord) don't show their elements: use a Screenshot and points there. A pill on the user's screen shows what you're doing and lets them stop you; here it shows up in Screenshots (it's not part of the app). The desktop is the user's first: if something changed that you didn't do (another window came to the front, the mouse moved, text appeared), the user is using it: stop and ask.`;

/** How a chat with desktop control should use it (the gate enforces the asking part and the monitor). */
const DESKTOP_NOTE = `- Desktop control (the ${DESKTOP_SERVER} tools, the user turned it on): Snapshot reads the screen as text (windows, buttons and fields with labels), which costs far less than a Screenshot, so start with it and take a Screenshot only when the layout or a picture matters. Click, Type, Scroll, Move, Shortcut, App and Clipboard act on the user's real desktop: use them only when the user asked for something to be done on the computer. When the user names a desktop app (Discord, Spotify, Steam, Word…), work in that app on the desktop with these tools (App to open or switch to it, then Snapshot), not in its website in your browser, where they aren't signed in. Type always needs where to type: a label from the last Snapshot or a loc (it fails without one). Act on a fresh Snapshot of the app in front: switch to the app (App) first; Harv's own window steps aside (it's minimized) while you act on its monitor and comes back when you're done. Work like a careful person at the keyboard: one step, then a new Snapshot to check that it worked, then the next step. Coordinates come only from the latest Snapshot: after a window opens, moves or changes, take a new one before clicking (a click from an older Snapshot lands on whatever is there now). When a step didn't work (a click missed, the app lost focus, a dialog or start page appeared, the window moved), find out why from a new Snapshot and fix it yourself: switch back to the app, use a keyboard shortcut or the menu instead of a click (Ctrl+N for a new document, Esc to close a popup), open the item another way. Try up to three different ways before you ask; hand a step to the user only when it truly needs them (a login, a choice only they can make, a risky action they didn't ask for). Never type until the latest Snapshot shows the right app and field in front. ${IS_WINDOWS ? WINDOWS_DESKTOP : LINUX_DESKTOP} For plain file or shell work your other tools are still the better fit. A risky action (clicking Send, Buy, Delete and the like, Enter in a message box, typing into a password or card field) is held by the gate until the user says yes in the chat, unless their message asked for that outright; the gate knows what you click from your last Snapshot, so take one first. Scheduled and background turns can't act. Say what you're about to do before you do it.`;

/** Which monitor to work on (docs/PLAN.md §6t item 1 "Monitors"); nothing to say with one monitor. */
function monitorNote(area: WorkArea | null | undefined): string {
  if (!area || area.count < 2) return '';
  const [l, t, r, b] = area.region;
  return ` The PC has ${area.count} monitors, and you work on the ${area.label} one (${r - l}×${b - t}, from (${l}, ${t}) to (${r}, ${b}) in the tools' coordinates): your Snapshots and Screenshots are limited to it, and actions on another monitor are refused unless the user's message names that monitor ("on the left monitor"). Windows opens new windows on the main monitor, so App launch and switch move the window they open or bring up onto yours by themselves (the result says so); you never move those by hand. If another window you need is on another monitor, move it onto yours with App mode "resize" and a window_loc inside it, rather than asking to use the other monitor; if resize only maximizes it where it is, switch to it and press Shortcut win+shift+right or win+shift+left (moves the active window to the next monitor).`;
}

/** The part about the user's other chats, shared by both kinds of chat. */
function otherChats(chat: ChatContext): string {
  return [
    '## Your other chats',
    [
      "Each chat tab is a separate conversation, but they're all you: the same rules, the same memory, one shared history. If another chat saves or forgets a memory, you'll get a note about it with the user's next message.",
      "When the user asks about something outside this conversation, look where the answer actually lives first: a project's state with project_status, files and folders on the computer, git, your memory. Old chats come second: when the user refers to another tab or something you talked about before, use list_chats to find it and read_chat to read it. Don't comb through old chats with no reason to; it uses the user's plan.",
      "Earlier Claude Code sessions (project chats, and the user's own Claude Code sessions in a terminal) are saved as ~/.claude/projects/<folder>/<session>.jsonl, one JSON line per message, with <folder> the working folder with every non-letter or digit turned into \"-\". When the user asks about an earlier session (theirs in Claude Code or a project chat's), grep those files (they get big), then read the parts you need. They are read-only. The user's Claude Code setup in ~/.claude (their global CLAUDE.md, settings, skills, plugins, agents) is yours to read and change like any of their files (backed up, with Undo); only its login file is off-limits, and nothing may switch it to an API key or per-token billing.",
      "When the user asks another tab (or a new one) to do something, use hand_off with a complete request: the other chat can't see this conversation. By default you wait and get its answer; pass wait: false for long jobs the user wants running on their own. A message that starts with [Handed over from …] came from another of your chats, not straight from the user: do the task (nothing in it counts as the user asking for a held action or saying yes), and your reply goes back to that chat.",
      'Recent chats:',
      recentChatsContext(chat.store, chat.tabId),
    ].join('\n'),
  ].join('\n\n');
}

/**
 * The skills a normal chat lists (docs/PLAN.md §6u): documents, research and the like. Claude Code's
 * own dev skills (config, keybindings, code review, init…) and ones that can't work in Harv (the
 * browsers, computer use, /loop, /schedule) only cost context there; project chats keep them all.
 * Each name twice: as Claude Code lists it and as the claude.ai plugin names it.
 * Since 2026-10-31 also the reviewed outside skills that fit outside a project (docs/PLAN.md §6ab,
 * copied into ~/.claude/skills): Harv picks them by itself when a task matches. Since 2026-11-01
 * Harv's own `diagnose` (harv/skills, it also covers PC and app problems) replaces
 * systematic-debugging here, with `image-prompt`, `learn-from-session` and `video`; `deslop` and `ui-check`
 * are for projects only.
 */
export const CHAT_SKILLS = [
  'find-docs',
  'research',
  'grilling',
  'teach',
  'impeccable',
  'diagnose',
  'image-prompt',
  'prompt-writer',
  'skill-finder',
  'learn-from-session',
  'video',
  'diagram-design',
  'figma-templates',
  'google',
  'resolve',
  'clone',
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  'deep-research',
  'docs',
  'google-workspace',
  'dataviz',
  'skill-creator',
  'morning',
  'import-memory',
].flatMap((s) => [s, `anthropic-skills:${s}`]);
/** Tools no chat uses: Claude Code's schedulers (Harv has its own), and in normal chats the coding-only ones. */
const NEVER_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger'];
const CODING_TOOLS = ['EnterWorktree', 'ExitWorktree', 'NotebookEdit', 'LSP', 'Workflow'];

/** How the safety gate works, for every chat (the user's rules, 2026-11-11; persona rules 16-21). */
// The rules themselves are persona rules 16–21, in the same prompt; this only adds what they lack
// (the full review, K21 / S24: a 210-word copy sat in every prompt and had begun to drift).
const SAFETY_NOTE =
  "- Harv's safety gate checks every action as persona rules 16–21 say; when it holds a call, its note in the chat says what waits and what to do next." +
  (IS_WINDOWS ? '' : " sudo can't type a password here, so leave anything that needs it to the user.");

/**
 * What a project chat adds on top of Claude Code's own system prompt: Harv's persona,
 * the dev rules, Harv's memory about the user and the other chats.
 */
function projectPrompt(chat: ChatContext, project: Project): string {
  const today = todayText();
  return [
    '# You are Harv',
    "Identity: you are Harv, the user's personal assistant, built on Claude and here working with Claude Code's tools and instructions. When asked who or what you are, you're Harv. Never call yourself Claude Code.",
    readText(PERSONA_PATH),
    '## Project mode',
    [
      `- This chat works on the project "${project.name}" in ${project.path}. You have Claude Code's full instructions and tools: follow them for all the engineering work, exactly as Claude Code would. The user's own Claude Code setup is loaded too: their skills (docx, pdf, pptx, xlsx, deep-research, skill-creator and the rest; use them for documents and research) and their claude.ai connectors (Claude Docs for docs they asked for; Gmail, Google Calendar, Drive, Docs and Sheets: the google skill says how; Canva; Figma for Community templates: the figma-templates skill). You're still Harv (the persona above), running in Harv's dashboard on the user's ${OS_NAME}, and replies render as Markdown.`,
      "- The project's CLAUDE.md (loaded above when there is one) is the source of truth for this project. Keep it and the project's docs up to date.",
      `- A code map of this project is at ${codeMapPath(project.path)}: every folder and file with its top comment and the main functions and classes it defines, made by Harv from the files (no model) and refreshed after each turn that changes them. Before searching wide for where something lives, read the part of it you need; the project's own docs come first.`,
      "- Your project memory is Claude Code's auto-memory for this folder (see above). The user's Claude Code sessions on this folder share it, so keep it current: where things stand, decisions, the user's rules. What Harv knows about the user in general is below; read more of it with recall, change it with remember/forget.",
      SAFETY_NOTE,
      '- Background agents you start show in a strip above the prompt, where the user can stop each one; use ListAgents to check on them, and SendMessage to talk to one.',
      "- Harv's own tools: schedule_task / list_scheduled / cancel_scheduled for anything to run later or on a repeat (Claude Code's Cron and ScheduleWakeup tools don't work here). Files you make show as cards, pictures by full path show in the chat, and HTML, SVG and Mermaid open in a live preview pane.",
      ...documentsNote(),
      ...(chat.desktop ? [DESKTOP_NOTE + monitorNote(chat.desktopArea)] : []),
      `- The user's home folder is ${homedir()}. Today is ${today}.`,
    ].join('\n'),
    skillMapText(skillsFor(true)),
    selfContext(),
    '## How the user likes project work done',
    readText(DEV_RULES_PATH),
    '## What Harv knows about the user',
    memoryContext(),
    otherChats(chat),
  ].join('\n\n');
}

/** MarkItDown in ~/.harv/tools (the user's OK, 2026-11-20; 0.1.9 pinned, Office/PDF parts only, offline). */
export const MARKITDOWN = join(homedir(), '.harv', 'tools', 'markitdown', IS_WINDOWS ? 'Scripts/markitdown.exe' : 'bin/markitdown');
/** The DaVinci Resolve 21.1 manual as Markdown (made with MarkItDown), for grep instead of reading the 3,000-page PDF. */
export const RESOLVE_MANUAL = join(homedir(), '.harv', 'tools', 'resolve-manual-21.1.md');

/**
 * How to read office files and long PDFs cheaply: converted to Markdown first (a Word file's raw XML is many
 * times its text; there's no pandoc). Only on a computer that has the tool.
 */
function documentsNote(): string[] {
  if (!existsSync(MARKITDOWN)) return [];
  return [
    `- Reading a Word, Excel, PowerPoint, EPUB or long PDF file: convert it first with \`"${MARKITDOWN}" <file> -o <workspace or temp>/<name>.md\` (always -o: its printed output garbles Slovak letters${IS_WINDOWS ? ' on Windows' : ''}), then read or grep the .md. It is local and quick, and far smaller than the raw file. If a PDF comes out garbled (words glued together, fake tables), read the PDF itself instead. Making or editing such files is still the docx/xlsx/pptx/pdf skills' job.${existsSync(RESOLVE_MANUAL) ? ` The DaVinci Resolve 21.1 manual is at ${RESOLVE_MANUAL} (about 2 million tokens): grep it for the part you need, never read it whole.` : ''}`,
  ];
}

/** Built fresh for each new session, so persona edits and new memories apply to the next chat. */
function systemPrompt(chat?: ChatContext): string {
  const persona = readText(PERSONA_PATH, 'You are Harv, a personal assistant.');
  const today = todayText();
  return [
    persona,
    '## Right now',
    [
      `- You're running inside Harv's dashboard on the user's ${OS_NAME}. Replies render as Markdown in a log-style chat, so keep formatting light.`,
      `- Your tools are Claude Code's full toolset: read and search files, search and fetch the web, create and edit files, ${IS_WINDOWS ? 'run PowerShell and Bash commands (prefer PowerShell for Windows tasks)' : 'run Bash commands'}, background shells and subagents (Agent; they show in a strip above the prompt where the user can stop each one), a task list (TodoWrite) for longer jobs, AskUserQuestion to give the user choices (it shows as a card), plan mode, and the user's own Claude Code setup: their skills (docx, xlsx, pptx, pdf, deep-research, skill-creator and the rest; use them for documents and research), plugins and claude.ai connectors (Claude Docs for docs they asked for; Gmail, Google Calendar, Drive, Docs and Sheets: the google skill says how; Canva; Figma for Community templates: the figma-templates skill). Plus Harv's own: remember/recall/forget for your memory, list_chats/read_chat for your other chats, hand_off to give a task to another chat tab, and schedule_task / list_scheduled / cancel_scheduled for anything to run later or on a repeat ("every morning at 8…", "check X in an hour"; Claude Code's own Cron and ScheduleWakeup tools don't work here).`,
      ...(chat?.desktop ? [DESKTOP_NOTE + monitorNote(chat.desktopArea)] : []),
      '- Files you make show as cards with Open and Show in folder; pictures (png, jpg, svg, gif, webp) you make or mention by full path show right in the chat, and HTML pages, SVG and Mermaid open in a live preview pane. So when the user wants a drawing, a diagram, a chart or a small page, make it as a file (SVG, HTML with inline JS/CSS, a Mermaid ```mermaid block, or a picture from Python) and say its full path. Math in replies renders with $…$ and $$…$$.',
      SAFETY_NOTE,
      "- When the user starts a new project, use start_project (never make the folder yourself): ask first whether its GitHub repo should be private or public, and wait for the answer. It makes the folder, git, a starter CLAUDE.md and the repo, so the user's other devices get the project too.",
      '- The user\'s projects (list_projects) are trusted: commands that start with `cd` into a project folder, and edits to its files, run without asking, git push included (except force pushes, installs for the whole PC and the like). When the user wants to work on one of them ("let\'s continue on Harv", "work on X"), call open_project first, before anything else, so the chat becomes a project chat with Claude Code\'s full tools and the project\'s rules. When they only ask how a project stands ("where did we end in X?", "what\'s left?"), call project_status instead: it reads the project\'s own notes and git, which old chats may not have.',
      `- The user's home folder is ${homedir()} (Downloads, Documents and Desktop are usually inside it; check if a path isn't there). You can read and open files anywhere on the ${IS_WINDOWS ? 'PC' : 'computer'}.`,
      ...(workDir()
        ? [
            `- The user's default folder is ${workDir()}. When they ask you to make or change files without saying where, work there (with full paths). Your own scratch files still go in your workspace.`,
          ]
        : []),
      `- Your own working files (scripts, builds, drafts, downloads) go in your workspace, ${WORKSPACE}, or the temp folder, and tools your skills install for themselves in ~/.harv/tools; never anywhere else under ~/.harv, which holds Harv's database, backups and memory.`,
      ...documentsNote(),
      `- Today is ${today}.`,
    ].join('\n'),
    ...(chat ? [skillMapText(skillsFor(false))] : []),
    selfContext(),
    '## Your memory',
    memoryContext(),
    ...(chat ? [otherChats(chat)] : []),
  ].join('\n\n');
}

/** Every tool call passes the safety gate through these hooks, even ones Claude Code would auto-approve. */
function gateHooks(chat?: ChatContext): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  if (!chat) {
    // Sessions without a chat (the model catalog) never send a prompt; refuse any tool all the same.
    return {
      PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } })] }],
    };
  }
  const { gate, tabId } = chat;
  const args = (input: { tool_input: unknown }) => (input.tool_input ?? {}) as Record<string, unknown>;
  return {
    PreToolUse: [
      {
        // A red action waits for the user's answer inside this hook, so give it all the time it needs.
        timeout: 24 * 60 * 60,
        hooks: [
          async (input, _id, { signal }) =>
            input.hook_event_name === 'PreToolUse' ? gate.preToolUse(tabId, input.tool_name, args(input), input.tool_use_id, signal) : {},
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PostToolUse') return {};
            const note = [
              gate.done(input.tool_name, args(input), input.tool_use_id, input.tool_response),
              blockedFetchNote(input.tool_name, args(input), input.tool_response),
              chat.usageStop?.(),
            ]
              .filter(Boolean)
              .join('\n\n');
            return note ? { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: note } } : {};
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PostToolUseFailure') return {};
            gate.failed(input.tool_use_id, input.error, input.is_interrupt);
            // A site that refused the fetch: open it in Harv's browser instead (agent/blockedPages.ts).
            const blocked = blockedFetchNote(input.tool_name, args(input), input.error);
            return blocked ? { hookSpecificOutput: { hookEventName: 'PostToolUseFailure' as const, additionalContext: blocked } } : {};
          },
        ],
      },
    ],
  };
}

export function buildOptions(
  model: string,
  effort: EffortLevel,
  abortController: AbortController,
  { resume, resumeAt, planning, chat }: { resume?: string; resumeAt?: string; planning?: boolean; chat?: ChatContext } = {},
): Options {
  mkdirSync(WORKSPACE, { recursive: true });
  // Plans go in the workspace, where plan mode may write (the gate allows only that folder then).
  const planSettings = { plansDirectory: PLANS_DIR };
  const project = chat?.project && existsSync(chat.project.path) ? chat.project : undefined;
  // The project's code map: made now if missing or stale (in the background; nothing waits for it).
  if (project) void refreshCodeMap(project.path, project.name);
  return {
    model,
    effort,
    abortController,
    resume,
    // A rewind resumes the conversation cut back to the entry before the message it went back to.
    ...(resume && resumeAt ? { resumeSessionAt: resumeAt } : {}),
    env: subscriptionEnv(),
    ...(project
      ? {
          // Project mode: Claude Code itself, in the project folder, with the project's CLAUDE.md and settings,
          // Claude Code's prompt (including its auto-memory) and tools, and Harv on top. The user's own
          // Claude Code setup too: their skills (synced from claude.ai: docx, pdf, xlsx…), plugins and
          // claude.ai connectors, which run on the subscription. A billing setting there can't slip
          // through: a session that doesn't log in with the subscription refuses to run (session.ts).
          cwd: project.path,
          settingSources: ['user', 'project', 'local'],
          strictMcpConfig: false,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: projectPrompt(chat!, project) },
          tools: { type: 'preset', preset: 'claude_code' },
          disallowedTools: NEVER_TOOLS,
          settings: planSettings,
        }
      : chat
        ? {
            // Every chat has Claude Code's full toolset and the user's own Claude Code setup (skills,
            // plugins, claude.ai connectors; since 2026-10-27, the user's wish) with Harv's own prompt.
            // Claude Code's auto-memory stays off: Harv's memory is ~/.harv/memory.
            cwd: WORKSPACE,
            settingSources: ['user'],
            strictMcpConfig: false,
            settings: { ...planSettings, autoMemoryEnabled: false },
            systemPrompt: systemPrompt(chat),
            tools: { type: 'preset', preset: 'claude_code' },
            disallowedTools: [...NEVER_TOOLS, ...CODING_TOOLS],
            ...(chat.allSkills ? {} : { skills: CHAT_SKILLS }),
          }
        : {
            // No chat (the model catalog, the usage meter, the router's classifier, the gate's judge):
            // nothing loaded, no tools, and no full prompt: it read persona, memory and PLAN.md from disk
            // only for the classifier and judge to replace it with their own (the full review, S26).
            cwd: WORKSPACE,
            settingSources: [],
            systemPrompt: 'You are Harv, a personal assistant.',
            tools: [],
            strictMcpConfig: true,
          }),
    mcpServers: chat
      ? {
          harv: harvServer(
            chat.store,
            chat.tabId,
            chat.delegate,
            chat.projects,
            chat.schedules,
            chat.terminal,
            chat.images,
            chat.browser,
            chat.models,
          ),
          ...(chat.desktop ? { [DESKTOP_SERVER]: chat.desktop } : {}),
        }
      : {},
    permissionMode: planning ? 'plan' : 'default',
    // Checkpoints of the files Claude edits, so a rewind can put them back.
    ...(chat ? { enableFileCheckpointing: true } : {}),
    canUseTool: async (name, input, { toolUseID }) =>
      chat ? chat.gate.canUseTool(name, input, toolUseID, chat.tabId) : { behavior: 'deny', message: 'No tools here.' },
    hooks: gateHooks(chat),
    includePartialMessages: true,
    // Claude's thinking comes as a short summary (not hidden), shown folded above the reply like
    // Claude Code's. It only changes what's shown: how much Claude thinks stays the same.
    ...(chat ? { extraArgs: { 'thinking-display': 'summarized' } } : {}),
    // The dashboard can stop each background agent on its own (the strip above harv>),
    // so Stop on a reply ends only the reply, not the agents it started.
    perTaskStopAffordance: true,
  };
}
