import { existsSync, writeFileSync } from 'node:fs';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { type EffortLevel, type HistoryItem, type Project, type StoredLine } from '@harv/shared';
import { z } from 'zod';
import type { ChatStore } from '../store/chats.ts';
import type { ScheduleInput } from '../schedule/schedule.ts';
import { memoryTools, text } from './memory.ts';
import { findProject, projectStatus } from './projectStatus.ts';
import { queryHarvDb } from './harvSelf.ts';
import { FILESYSTEMS, formatDrive, listDrives } from '../tools/drives.ts';
import { currentRemote, transcribeAnywhere } from '../voice/anywhere.ts';
import { voice } from '../voice/stt.ts';

// Every chat tab is its own Claude session, but they share one history. These
// tools let Harv look through its other chats (open tabs and past ones) when the
// user refers to them. They only read the database, so they cost no plan usage
// beyond the text they bring into the conversation.

/** Keeps a read chat from flooding the context (it counts against plan usage). */
const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_LINE_CHARS = 2_000;

const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** One line per chat: id, title, last activity and whether it's an open tab. */
export function chatList(items: HistoryItem[], currentId: string): string {
  return items
    .map((c) => {
      const flags = [day(c.updatedAt), c.open ? 'open tab' : 'closed', c.id === currentId ? 'this chat' : ''].filter(Boolean);
      return `- ${c.id} · "${c.title}" · ${flags.join(' · ')}${c.summary ? `\n  about: ${c.summary}` : ''}${c.snippet ? `\n  match: ${c.snippet}` : ''}`;
    })
    .join('\n');
}

const SPEAKER: Record<StoredLine['kind'], string> = {
  you: 'user',
  harv: 'harv',
  tool: '  tool',
  notice: '  note',
  error: '  error',
  thinking: '  thought',
};

/** A chat as plain text, newest lines kept when it's too long. */
export function formatTranscript(lines: StoredLine[]): string {
  const out: string[] = [];
  let total = 0;
  // Thinking summaries are Harv's scratch work, not part of the conversation.
  for (const line of [...lines].reverse().filter((l) => l.kind !== 'thinking')) {
    const body = line.text.length > MAX_LINE_CHARS ? `${line.text.slice(0, MAX_LINE_CHARS)}…` : line.text;
    const files = line.files?.length ? ` [attached: ${line.files.join(', ')}]` : '';
    const entry = `${SPEAKER[line.kind]}: ${body}${files}`;
    if (total + entry.length > MAX_TRANSCRIPT_CHARS) {
      out.push('(…earlier lines left out)');
      break;
    }
    out.push(entry);
    total += entry.length;
  }
  return out.reverse().join('\n');
}

/** A user message this long is a spec or a brief: worth carrying in full. */
const SPEC_CHARS = 600;
const MAX_SPEC_CHARS = 4_000;
const MAX_CARRY_CHARS = 16_000;

/**
 * What a chat carries into a new session (moved to the other computer, into or out of a project):
 * the user's first message and their long ones (specs) from before the last 30 lines, then the last
 * 30 lines. Only the last 30 lines (8,000 characters) went along before, and the ShopNotes chat forgot
 * the spec it had read that morning (2026-11-10).
 */
export function carryTranscript(lines: StoredLine[]): string {
  const recent = lines.slice(-30);
  const older = lines.slice(0, -30).filter((l, i) => l.kind === 'you' && (i === 0 || l.text.length >= SPEC_CHARS));
  const firstIsOlder = lines[0]?.kind === 'you' && older[0] === lines[0];
  const keep = older.map((l, i) => {
    const text = l.text.length > MAX_SPEC_CHARS ? `${l.text.slice(0, MAX_SPEC_CHARS)}…` : l.text;
    return `${i === 0 && firstIsOlder ? 'The user (first message)' : 'The user (earlier)'}: ${text}`;
  });
  let head = keep.join('\n');
  const tail = formatTranscript(recent);
  // The recent lines first; the earlier ones get what's left (newest specs kept when it's too long).
  const room = MAX_CARRY_CHARS - Math.min(tail.length, 10_000);
  if (head.length > room) head = head.slice(-room);
  const body = tail.length > 10_000 ? tail.slice(-10_000) : tail;
  return head ? `${head}\n(…)\n${body}` : body;
}

/** The list of recent chats that goes into every new session's system prompt (no model call needed). */
export function recentChatsContext(store: ChatStore, currentId: string, limit = 10): string {
  const others = store
    .history()
    .filter((c) => c.id !== currentId)
    .slice(0, limit);
  return others.length ? chatList(others, currentId) : 'No other chats yet.';
}

/** A task one chat hands to another (the `hand_off` tool). */
export interface HandOff {
  /** The chat to give it to; a new tab when left out. */
  to?: string;
  title?: string;
  message: string;
  /** Wait for the other chat's answer (default true). */
  wait: boolean;
}

/** Runs a hand-off from this chat and returns what to tell the model. */
export type Delegate = (req: HandOff, signal?: AbortSignal) => Promise<string>;

/** Project mode: what Harv's project tools do (ChatManager implements them). */
export interface ProjectTools {
  list(): Project[];
  /** Creates the folder in the user's projects folder, git init, a starter CLAUDE.md, its GitHub repo, and moves this chat into it. */
  start(tabId: string, name: string, description: string, visibility: 'private' | 'public'): Promise<string>;
  /** Moves this chat into a known project (by name) or a folder (by path). */
  open(tabId: string, nameOrPath: string): Promise<string>;
  /** Takes a project off Harv's list (on every device); its folder and repo stay as they are. */
  remove(name: string): string;
  /**
   * Adds a dated note to harv_report.md, like /report (the real time: Harv wrote made-up times by hand, 2026-11-09);
   * `skills`: a review of a skill or tool goes to harv_skills.md instead (pass B, B39).
   */
  report(tabId: string, note: string, skills?: boolean): string;
}

/** Harv's scheduler, as the chat tools see it (schedule/scheduler.ts). */
export interface ScheduleTools {
  add(tabId: string, title: string, prompt: string, input: ScheduleInput): string;
  describe(): string;
  cancel(id: string): boolean;
}

/**
 * The chat's visible terminal, as Harv's terminal tools see it (the server's TerminalManager).
 * `chat` names another chat whose terminal to use (the user's wish: a terminal tab every chat can work in).
 */
export interface TerminalTools {
  /** Shows the terminal in the dashboard, types the command and returns what it printed. */
  run(tabId: string, command: string, opts: { cwd?: string; interrupt?: boolean; waitMs?: number; chat?: string }): Promise<string>;
  read(tabId: string, lines: number, chat?: string): string;
}

/** An open chat tab, for finding another chat's terminal. */
export interface OpenTab {
  id: string;
  title: string;
  /** It shows its terminal right now. */
  terminal: boolean;
}

/**
 * The open chat the user means by `ref`: its id, its title (exact, else the only one containing
 * it), or, for "terminal", the only other chat showing its terminal. An error naming the open
 * chats when it's not clear.
 */
export function findTab(ref: string, tabs: OpenTab[], self: string): OpenTab | string {
  const want = ref.trim().toLowerCase();
  const others = tabs.filter((t) => t.id !== self);
  const byId = tabs.find((t) => t.id === ref.trim()) ?? (want.length >= 6 ? tabs.filter((t) => t.id.startsWith(want)) : []).at(0);
  if (byId) return byId;
  // By name it's always another chat (this one may well be called "Terminal test"); one showing its terminal wins a tie.
  const one = (list: OpenTab[]) =>
    list.length === 1 ? list[0] : list.filter((t) => t.terminal).length === 1 ? list.find((t) => t.terminal) : undefined;
  const named =
    one(others.filter((t) => t.title.toLowerCase() === want)) ?? one(others.filter((t) => t.title.toLowerCase().includes(want)));
  if (named) return named;
  const showing = others.filter((t) => t.terminal);
  if (/terminal|shell|konzol|termin[aá]l/.test(want) && showing.length === 1) return showing[0]!;
  const list = tabs
    .map((t) => `- "${t.title}" (${t.id})${t.terminal ? ' · terminal open' : ''}${t.id === self ? ' · this chat' : ''}`)
    .join('\n');
  return `No single open chat matches "${ref}". Open chats:\n${list}\nAsk the user which one (a chat used only for its terminal can be renamed by double-clicking its tab).`;
}

/** Pictures made by Gemini (tools/gemini.ts): returns what to tell the model (saved paths, or what the user must do). */
export interface ImageTools {
  generate(prompt: string, images: string[]): Promise<string>;
}


/** Harv's set_model tool: changes the chat's own pick, like the header switcher. */
/** The chat's own look: its model pick, and the presence demo. */
export interface ModelTools {
  set(tabId: string, model: 'auto' | 'haiku' | 'sonnet' | 'opus' | 'fable', effort?: EffortLevel): string;
  /** Plays every presence state in this chat on the user's screen, as a simulation. */
  demo?(tabId: string): string;
  /** The plan meters as text (session, weekly, reset times). */
  usage?(): string;
}

/** Harv's own MCP server for one chat tab: memory tools, the other chats, handing work to them, projects, scheduled tasks, the terminal and pictures. */
export function harvServer(
  store: ChatStore,
  tabId: string,
  delegate?: Delegate,
  projects?: ProjectTools,
  schedules?: ScheduleTools,
  terminal?: TerminalTools,
  images?: ImageTools,
  browser?: BrowserTools,
  models?: ModelTools,
) {
  return createSdkMcpServer({
    name: 'harv',
    version: '1.0.0',
    tools: [
      ...memoryTools,
      ...(models
        ? [
            tool(
              'set_model',
              'Change the model this chat runs on, like the user\'s header switcher: use it when the user asks in plain words ("use a smaller model", "switch to Opus", "back to auto", "použi Sonnet"). It takes effect from their next message and stays for this chat until they pick AUTO again. "auto" gives the choice back to AUTO. Fable only when the user names it. For "smaller" or "bigger", go one model down or up from the one your last reply ran on.',
              {
                model: z.enum(['auto', 'haiku', 'sonnet', 'opus', 'fable']),
                effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Leave out for high'),
              },
              async ({ model, effort }) => text(models.set(tabId, model, effort)),
            ),
            ...(models.demo
              ? [
                  tool(
                    'presence_demo',
                    'Show the user your presence (the hammock with your face and moons) in every state, as a ~25 s simulation in this chat on their screen: thinking, each moon (memory, files, shell, web, helpers), desktop control, waiting for a yes, asleep at a plan limit, an error, done. Nothing real runs. Use it when the user asks to see or demo your presence; tell them to watch the top of the chat, and keep your reply short (the demo plays after this call returns).',
                    {},
                    async () => text(models.demo!(tabId)),
                  ),
                ]
              : []),
            ...(models.usage
              ? [
                  tool(
                    'plan_usage',
                    "The user's Claude plan usage right now: the 5-hour session and the weekly meters (all models, per model), each with its percent used and exact reset time, plus whether Harv is paused at a limit, and a cost guide (what one reply costs here on each model, in % of the session). Use it for any question about limits, usage or when something resets, and before you estimate what a task or plan will take. It costs no plan usage.",
                    {},
                    async () => text(models.usage!()),
                  ),
                ]
              : []),
          ]
        : []),
      tool(
        'list_drives',
        "List the USB drives connected to this computer (sticks, external disks): each disk's number or device, name and size, and its volumes (letter, label, file system, size, free). Only these can be formatted with format_drive; internal drives never.",
        {},
        async () => text(await listDrives()),
      ),
      tool(
        'format_drive',
        'Format (erase) a USB drive when the user asks for it: call list_drives first, then pass the drive and its disk name exactly as listed. The user always gets a card to approve it, which names the drive; everything on it is lost (no backup, no Undo), so say what is on it before. Windows also shows its admin prompt. Only USB drives that hold no system; internal drives and the shell’s format commands stay blocked. Default exFAT (works on Windows, Mac, Linux, TVs, cars); FAT32 for old devices (Windows: up to 32 GB); NTFS for Windows-only; ext4 for Linux-only (Linux only).',
        {
          drive: z.string().describe('A drive letter ("G:"), "disk 4" (with whole), or on Linux a partition ("/dev/sdb1")'),
          disk_name: z.string().describe('The disk’s name exactly as list_drives gave it (e.g. "USB SanDisk 3.2Gen1")'),
          filesystem: z.enum(FILESYSTEMS).optional().describe('Default exfat'),
          label: z.string().max(32).optional().describe('The new volume name (default "USB")'),
          whole: z
            .boolean()
            .optional()
            .describe('Erase the whole disk (all partitions, e.g. an old installer stick) and make one volume of it; Windows only'),
        },
        async (req) => text(await formatDrive(req)),
      ),
      tool(
        'harv_db',
        "Read Harv's own database (harv.db): every chat and its lines, every model·effort pick and its tokens (routes), every action the safety gate let through (actions), projects, scheduled tasks, sync state. Without sql it lists the tables, their columns and row counts. sql: one read-only query (SELECT / WITH / PRAGMA table_info), at most 200 rows. Use it for questions about your own history and usage.",
        { sql: z.string().optional().describe('A read-only SQLite query; leave out to see the tables') },
        async ({ sql }) => text(queryHarvDb(sql)),
      ),
      tool(
        'list_chats',
        "List your chats with the user (open tabs and past ones), newest first, each with a one-line summary of what it's about. Pass a query to search titles, summaries and messages. Use it when the user refers to another chat or something you talked about before that isn't in this conversation; the summary often answers it, read_chat gives the detail.",
        {
          query: z.string().optional().describe('Words to search for; leave out to list recent chats'),
          open_only: z.boolean().optional().describe('Only chats open as tabs right now'),
        },
        async ({ query, open_only }) => {
          const items = store.history(query ?? '').filter((c) => !open_only || c.open);
          if (items.length === 0) return text(query ? `No chats match "${query}".` : 'No chats found.');
          return text(chatList(items.slice(0, 30), tabId));
        },
      ),
      tool(
        'read_chat',
        'Read another chat by its id (from list_chats or the list in your instructions): its title and its latest messages. A chat open in another tab may still be in progress; only finished messages are shown.',
        {
          id: z.string().describe('The chat id'),
          last: z.number().int().min(1).max(200).optional().describe('How many of the latest lines to read (default 40)'),
        },
        async ({ id, last }) => {
          if (id === tabId) return text('That is this chat; its messages are already in your context.');
          const chat = store.transcript(id, last ?? 40);
          if (!chat) return { ...text(`No chat with id ${id}.`), isError: true };
          const header = `"${chat.title}" · ${chat.open ? 'open tab' : 'closed'} · last active ${day(chat.updatedAt)}`;
          return text(`${header}\n\n${formatTranscript(chat.lines) || '(no messages yet)'}`);
        },
      ),
      ...(delegate
        ? [
            tool(
              'hand_off',
              "Give a task to another chat tab: an existing chat (by id) or a new tab. That chat works on it as its own conversation, with the same rules and safety checks, and by default you get its answer back here. It runs a second session, so it uses about as much of the user's plan again: only hand off when the user asks you to involve another tab or chat, or to run something separately.",
              {
                to: z
                  .string()
                  .optional()
                  .describe('Id of the chat to give it to (from list_chats or your instructions); leave out to open a new tab'),
                title: z.string().optional().describe('Short title for a new tab'),
                message: z
                  .string()
                  .min(1)
                  .describe('The full request for the other chat, with everything it needs (it can’t see this conversation)'),
                wait: z.boolean().optional().describe('Wait for its answer and get it back here (default true)'),
              },
              async ({ to, title, message, wait }, extra) => {
                const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
                return text(await delegate({ to, title, message, wait: wait ?? true }, signal));
              },
            ),
          ]
        : []),
      ...(projects
        ? [
            tool(
              'report_note',
              "Add a note to the user's harv_report.md (bugs, wishes, ideas about Harv): one dated line with this device and chat, the same as their /report. Reviews of skills, tools, MCP servers or reels the user sent go to harv_skills.md instead (skill_review true), so their own list stays short. Use it instead of editing either file, so the date and time are real. One note per call, on one line.",
              {
                note: z.string().min(1).max(4000).describe('The note itself, without a date or bullet'),
                skill_review: z
                  .boolean()
                  .optional()
                  .describe('True for a review of a skill, tool, MCP server or reel: it goes to harv_skills.md'),
              },
              async ({ note, skill_review }) => text(projects.report(tabId, note, skill_review)),
            ),
            tool('list_projects', 'List the projects Harv knows (name and folder).', {}, async () => {
              const list = projects.list();
              return text(
                list.length
                  ? list.map((p) => `- ${p.name}: ${p.path}${existsSync(p.path) ? '' : ' (folder missing)'}`).join('\n')
                  : 'No projects yet.',
              );
            }),
            tool(
              'remove_project',
              "Take a project off your project list, on every device: its chats become normal chats, and its folder and GitHub repo stay untouched. Use it when the user asks, or to tidy after a project's folder was renamed or moved (open_project the new folder, then remove the old entry). Never edit harv.db for this.",
              { name: z.string().min(1).describe("The project's name exactly as list_projects shows it") },
              async ({ name }) => text(projects.remove(name)),
            ),
            tool(
              'project_status',
              'Where a project stands, read-only and without switching this chat to it: its Claude Code memory (the state its sessions saved: where they stopped, what\'s next), the start of its CLAUDE.md and plan, and git (recent commits, uncommitted and unpushed work). Use it whenever the user asks about a project\'s progress ("where did we end in X", "what\'s left on X") before searching old chats: work done in Claude Code never shows up in Harv\'s chats.',
              { name: z.string().min(1).describe("The project's name (see list_projects); a close spelling is fine") },
              async ({ name }) => {
                const found = findProject(projects.list(), name);
                if (!found)
                  return text(
                    `No project called "${name}". Known: ${
                      projects
                        .list()
                        .map((p) => p.name)
                        .join(', ') || 'none'
                    }.`,
                  );
                return text(await projectStatus(found));
              },
            ),
            tool(
              'start_project',
              "Start a new project when the user says so (\"we're starting a new project…\"): makes its folder in the user's projects folder, runs git init, writes a starter CLAUDE.md, creates its GitHub repo (so the user's other devices get it too) and turns this chat into a project chat there (from the next message you work as Claude Code in that folder). Before calling it, ALWAYS ask the user whether the GitHub repo should be private or public, and wait for the answer: never guess or pick a default. Fails if the folder exists: then ask the user, or use open_project.",
              {
                name: z.string().min(1).describe('Folder name: what the user called it, or a short lowercase-hyphen name like weather-app'),
                description: z.string().describe('What the project is, in a sentence or two (goes into CLAUDE.md)'),
                visibility: z
                  .enum(['private', 'public'])
                  .describe("The GitHub repo's visibility, exactly as the user answered when you asked (never assumed)"),
              },
              async ({ name, description, visibility }) => text(await projects.start(tabId, name, description, visibility)),
            ),
            tool(
              'open_project',
              `Turn this chat into a project chat for an existing project, ONLY when the user explicitly asks to work on it or switch to it ("let's work on X", "switch to X"): give the project's name (see list_projects) or a folder path (it gets added). From the next message you work as Claude Code in that folder. Never call it just to look at something from a project (a mockup, a file, a picture): read or open that file directly from this chat instead, since project folders are readable from any chat.`,
              { project: z.string().min(1).describe('Project name or full folder path') },
              async ({ project }) => text(await projects.open(tabId, project)),
            ),
          ]
        : []),
      ...(schedules
        ? [
            tool(
              'schedule_task',
              `Schedule something to run later or on a repeat, when the user asks ("every morning at 8 tell me…", "check X in an hour", "remind me on Friday…"): each run is a new turn in THIS chat, with the prompt as the request, run by Harv's server on this device while Harv is on (a run missed while it's off happens once when it starts). Each run uses the user's plan, so never repeat faster than the user needs. Give exactly one of in_minutes, time (+ days_from_today), at, every_minutes, daily_at. Don't work out dates or clock times yourself (your sense of "now" can be hours old): "in an hour" is in_minutes 60, "tomorrow at 8" is time "08:00" with days_from_today 1, "at 18:30" is time "18:30"; use at only for a date the user gave. The result says the real time.`,
              {
                title: z.string().describe('A short name for the list, like "Morning news"'),
                prompt: z
                  .string()
                  .min(1)
                  .describe(
                    "The full request for each run, written as the user's ask (the run doesn't see this conversation's later turns)",
                  ),
                at: z.string().optional().describe('One run at this local date and time, like 2026-10-28T08:00'),
                in_minutes: z.number().optional().describe('One run this many minutes from now'),
                time: z.string().optional().describe('One run at HH:MM (24-hour, local): today, or tomorrow if that has passed'),
                days_from_today: z.number().int().optional().describe('With time: that many days from today (1 = tomorrow)'),
                every_minutes: z.number().optional().describe('Repeat every N minutes (at least 5)'),
                daily_at: z.string().optional().describe('Repeat every day at HH:MM (24-hour, local)'),
                weekdays: z.array(z.string()).optional().describe('With daily_at: only on these days (mon, tue, wed, thu, fri, sat, sun)'),
              },
              async ({ title, prompt, ...when }) => text(schedules.add(tabId, title, prompt, when)),
            ),
            tool('list_scheduled', "List Harv's scheduled tasks on this device (id, name, when, next run, chat).", {}, async () =>
              text(schedules.describe()),
            ),
            tool(
              'cancel_scheduled',
              'Cancel a scheduled task by its id (from list_scheduled), when the user asks to stop it.',
              { id: z.string().min(1) },
              async ({ id }) => text(schedules.cancel(id) ? `Cancelled ${id}.` : `No scheduled task with id ${id}.`),
            ),
          ]
        : []),
      ...(terminal
        ? [
            tool(
              'terminal_run',
              "Run a command in this chat's own terminal tab, the one the user sees: a Terminal tab of its own next to this chat (made the first time, then reused), which comes to the front in the dashboard while this chat stays as it is; the command is typed there as if by the user, and you get back what it printed. Use it when the user asks to open the terminal, to run something in it, or to watch a program run (e.g. `java Main`, a dev server, an interactive program); use Bash for your own quiet work. Another tab's terminal: when the user points at a terminal somewhere else (“in the terminal tab”, “in the Server chat”, “in my other terminal”), pass chat with that tab's title (or just “terminal”); without chat it always runs in THIS chat's own terminal tab. The shell is PowerShell on Windows and the user's shell (bash) on Linux, and it keeps its folder and state between calls. It returns after the output has been quiet for a moment (or wait_seconds): a program that's still running keeps running; read it later with terminal_read, or answer its prompts with another terminal_run (command = the text to type).",
              {
                command: z.string().describe('The command line, or text to type into a running program; empty just reads'),
                cwd: z.string().optional().describe('Folder to cd into first'),
                interrupt: z.boolean().optional().describe('Press Ctrl+C first, to stop what is running'),
                wait_seconds: z.number().min(1).max(120).optional().describe('Longest to wait for output (default 15)'),
                chat: z
                  .string()
                  .optional()
                  .describe(
                    'Another open tab whose terminal to use instead of this chat\'s own, whenever the user points at one ("in the terminal tab" → "terminal", "in the Server chat" → "Server"): its title, its id, or "terminal" for the tab showing a terminal. The user watches it in that tab.',
                  ),
              },
              async ({ command, cwd, interrupt, wait_seconds, chat }) =>
                text(await terminal.run(tabId, command, { cwd, interrupt, waitMs: (wait_seconds ?? 15) * 1000, chat })),
            ),
            tool(
              'terminal_read',
              "Read the latest lines on this chat's own terminal tab (what the user sees there; before you've run anything, the chat's own Terminal view), or another open chat's (chat), e.g. a program started with terminal_run that's still running, or something the user ran.",
              {
                lines: z.number().int().min(1).max(500).optional().describe('How many of the last lines (default 60)'),
                chat: z.string().optional().describe("Another open chat's title or id, to read its terminal"),
              },
              async ({ lines, chat }) => text(terminal.read(tabId, lines ?? 60, chat)),
            ),
          ]
        : []),
      ...(images
        ? [
            tool(
              'generate_image',
              "Make a picture with Google's Gemini when the user asks for one (a photo, illustration, logo, icon, wallpaper…), or change one of their pictures. Write a full, specific prompt in English (subject, style, composition, colours, mood, aspect ratio), not just the user's words. It takes up to a few minutes; the result is saved in your workspace's images folder: name the full path in your reply so the picture shows in the chat. Pass images only when the user gave you pictures for this (they go to Google). If it says the user must sign in, tell them exactly that.",
              {
                prompt: z.string().min(1).describe('The full prompt for Gemini'),
                images: z
                  .array(z.string())
                  .max(4)
                  .optional()
                  .describe('Full paths of the user’s pictures to edit or use (PNG, JPG, WebP, up to 10 MB each)'),
              },
              async ({ prompt, images: inputs }) => text(await images.generate(prompt, inputs ?? [])),
            ),
          ]
        : []),
      ...(browser ? browserTools(browser, tabId) : []),
      tool(
        'transcribe',
        "Turn a recording or a video file on this computer into text, SRT subtitles, or words with their times, with Whisper (free, on the user's own computers; Slovak and English, and a file in another language is heard in that language). On a computer without Whisper it goes through the user's other computer by itself. Use it for voice messages, recordings, and videos without captions (the video skill's fallback). Pass the file's full path. format words is for cutting video: one line per phrase, broken on pauses of half a second or more ([start-end] seconds), and every word's start and end saved to <file>.words.json; cut at a phrase or word edge, never inside a word. It takes from a second to a few minutes for long files. If it says it isn't installed, tell the user it's one click in Settings › What Harv can do › Voice.",
        {
          path: z.string().min(1).describe('Full path of the audio or video file'),
          format: z
            .enum(['text', 'srt', 'words'])
            .optional()
            .describe('text (default), srt subtitles with timestamps, or words (phrases with times, plus each word in <file>.words.json)'),
          language: z.enum(['sk', 'en']).optional().describe('Only when you know it; otherwise the language is detected'),
        },
        async ({ path, format, language }) => {
          try {
            const t = await transcribeAnywhere(path, format ?? 'text', language, { local: voice, remote: currentRemote() });
            const where =
              t.device === 'cuda'
                ? 'the GPU'
                : t.device === 'cpu'
                  ? 'the CPU'
                  : t.device.replace(/^cuda/, 'the GPU').replace(/^cpu/, 'the CPU');
            let saved = '';
            if (format === 'words' && t.words) {
              const out = `${path}.words.json`;
              writeFileSync(out, JSON.stringify({ language: t.language, duration: t.duration, words: t.words }));
              saved = `\n(every word's [start, end, word] in seconds: ${out})`;
            }
            return text(`[${t.language}, ${t.duration} s of audio, ${t.seconds} s on ${where}]\n${t.text || '(no speech found)'}${saved}`);
          } catch (err) {
            return { ...text(`Transcribe: ${(err as Error).message}`), isError: true };
          }
        },
      ),
    ],
  });
}

/** Harv's browser (tools/harvBrowser.ts): one per computer, in the app, shared by every chat; the user watches it in its tab. */
export interface BrowserTools {
  /** tabId: the chat asking, which then shows its Browser view. */
  open(target: string, sameTab?: boolean, tabId?: string): Promise<string>;
  snapshot(): Promise<string>;
  click(ref: number): Promise<string>;
  type(ref: number, value: string, submit: boolean): Promise<string>;
  upload(ref: number, path: string): Promise<string>;
  press(key: string): Promise<string>;
  scroll(direction: 'up' | 'down'): Promise<string>;
  back(): Promise<string>;
  close(): Promise<string>;
  tabs(): Promise<string>;
  select(id: number, tabId?: string): Promise<string>;
}

/** A browser error as the tool's answer (the app closed, the page changed…). */
const browsing = async (action: () => Promise<string>) => {
  try {
    return text(await action());
  } catch (err) {
    return { ...text(`Browser: ${(err as Error).message}`), isError: true };
  }
};

function browserTools(browser: BrowserTools, tabId: string) {
  return [
    tool(
      'browser_open',
      'Open a web page, a local file (an HTML mockup, a PDF, a picture: give its full path) or a Google search in Harv\'s browser: the shared browser in the Harv app, with page tabs like any browser. It comes up in a Browser tab of its own next to this chat (never over the chat itself), so the user sees it. Opens a new page tab unless same_tab, and every tab stays open: the browser keeps the few most recent live and puts older ones to sleep (still in the tab strip, reloaded when picked), so open as many as the user wants to keep; browser_tabs lists them, browser_switch goes back to one. One call at a time: the browser shows one page to you, so never call browser tools in parallel. Returns the page read like browser_snapshot. Use it when the user asks to open, show or check something in the browser ("open them" = here, never the user\'s own browser via xdg-open/start unless they name it), or when you need a real page (one that needs scripts or a login the user made there); for plain reading WebFetch/WebSearch are cheaper.',
      {
        url: z.string().min(1).describe('A web address, a full file path, or words to search for'),
        same_tab: z.boolean().optional().describe('Load it in the page that is showing instead of a new page tab'),
      },
      async ({ url, same_tab }) => browsing(() => browser.open(url, same_tab === true, tabId)),
    ),
    tool(
      'browser_snapshot',
      "Read the browser's current page: its title, address, the elements you can click or type into (as numbered refs) and its text. Take a new one after the page changes; older refs stop working.",
      {},
      async () => browsing(() => browser.snapshot()),
    ),
    tool(
      'browser_click',
      'Click an element from the latest snapshot by its ref number. When the click downloads a file, the answer says where it landed (the user’s Downloads folder).',
      { ref: z.number().int().min(1).describe('The element’s number from browser_snapshot') },
      async ({ ref }) => browsing(() => browser.click(ref)),
    ),
    tool(
      'browser_type',
      'Type into a field from the latest snapshot (replacing what is in it). submit: true presses Enter / sends the form afterwards, e.g. for a search box. On a dropdown (a select: the snapshot lists its options) it picks the option whose text you give, like choosing it; take a new snapshot after, since the page may unlock or change other fields.',
      {
        ref: z.number().int().min(1).describe('The field’s number from browser_snapshot'),
        text: z.string().describe('What to type'),
        submit: z.boolean().optional().describe('Press Enter afterwards'),
      },
      async ({ ref, text: value, submit }) => browsing(() => browser.type(ref, value, submit === true)),
    ),
    tool(
      'browser_upload',
      'Attach a file from this computer to the page, the way picking it in the file dialog does (which you can’t open): give the ref of the page’s upload box, its "Attach"/"Upload" button or the area that takes dropped files (in Gmail: the message body of the draft). Up to 20 MB; zip a folder first. Then take a browser_snapshot and check the page shows the file. Uploading sends the file to that site: it follows the sending rule.',
      {
        ref: z.number().int().min(1).describe('The upload box, button or drop area from browser_snapshot'),
        path: z.string().min(1).describe('The full path of the file on this computer'),
      },
      async ({ ref, path }) => browsing(() => browser.upload(ref, path)),
    ),
    tool(
      'browser_press',
      'Press a key on the page’s focused element: Enter, Escape, Tab, ArrowDown, ArrowUp, PageDown, PageUp, Space, Backspace.',
      { key: z.string().min(1).describe('A key name like Escape, Tab, ArrowDown, Enter') },
      async ({ key }) => browsing(() => browser.press(key)),
    ),
    tool(
      'browser_scroll',
      'Scroll the browser’s page up or down by most of a screen.',
      { direction: z.enum(['up', 'down']) },
      async ({ direction }) => browsing(() => browser.scroll(direction)),
    ),
    tool('browser_back', 'Go back to the previous page in the browser, and read it.', {}, async () => browsing(() => browser.back())),
    tool(
      'browser_close',
      'Close the page tab that is showing in the browser (when you are done with a page the user does not need).',
      {},
      async () => browsing(() => browser.close()),
    ),
    tool(
      'browser_tabs',
      'List the browser’s page tabs (number, title, address; which one shows and which sleep) and its recent downloads (where each file landed).',
      {},
      async () => browsing(() => browser.tabs()),
    ),
    tool(
      'browser_switch',
      'Show a page tab by its number from browser_tabs (a sleeping tab reloads), and read it.',
      { id: z.number().int().min(1).describe('The tab’s number from browser_tabs') },
      async ({ id }) => browsing(() => browser.select(id, tabId)),
    ),
  ];
}
