import { fileURLToPath } from 'node:url';
import { randomUUID, type UUID } from 'node:crypto';
import {
  type Attachment,
  type Catalog,
  type ChatServerMessage,
  type EffortLevel,
  type HarvStatus,
  type ModelChoice,
  type QueuedMessage,
  type RouteDecision,
  type SlashCommandInfo,
  type StoredLine,
  AUTO_FALLBACK,
  newChatTask,
  unknownCommand,
  unknownCommandText,
} from '@harv/shared';
import type { Router } from '../router/router.ts';
import { isSignOff, parseOverride } from '../router/rules.ts';
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { WorkArea } from '../safety/desktop.ts';
import type { SafetyGate } from '../safety/gate.ts';
import { SCHEDULED_TAG } from '../schedule/schedule.ts';
import type { ChatStore } from '../store/chats.ts';
import { sessionNote, stopNote, usageText, windowOf } from '../usage/budget.ts';
import type { UsageMeter } from '../usage/meter.ts';
import { buildContent, cleanAttachments, deleteAttachments } from './attachments.ts';
import { sideQuestion } from './btw.ts';
import { runAlone } from './aloneRun.ts';
import { asksForSkill, commandName, hiddenReason } from './commands.ts';
import { skillNote } from './skillMap.ts';
import { isInstalledSkill } from './ownSkills.ts';
import {
  carryTranscript,
  type HandOff,
  type ProjectTools,
  type BrowserTools,
  type ImageTools,
  type ScheduleTools,
  type TerminalTools,
} from './chatTools.ts';
import type { ChatSnapshot, ProjectServerMessage, RouteSource } from '@harv/shared';
import { refreshCodeMap } from './codeMap.ts';
import { appendNote } from './notes.ts';
export { ideaLine } from './notes.ts';
import { dayNote } from './options.ts';
import { ProjectLink } from './projectLink.ts';
import { ChatSession, type MemoryCue } from './session.ts';

/**
 * The model·effort of a chat's last reply, from its saved tags. A /btw answer (`btw·sonnet`) isn't a
 * turn of the chat: it used to come back as model "btw" (audit B1).
 */
export function lastTaggedRun(lines: { kind: string; tag?: string | null }[]): { model: string; effort: EffortLevel } | undefined {
  const last = lines.findLast((l) => l.kind === 'harv' && l.tag && !l.tag.startsWith('btw·'));
  const [model, effort] = last?.tag?.split('·') ?? [];
  return model && effort ? { model, effort: effort as EffortLevel } : undefined;
}

/** A new chat's first name, from its first message: a leading /report or /btw isn't part of the topic (the history showed "/report browser win…"). */
const titleFrom = (text: string) => {
  const t = text.replace(/^\/(report|btw)\s+/i, '');
  // 60: History's tooltip showed only the 40-character form of a title cut again by the row (the full review, R8).
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
};

/** What "Try harder" asks Claude; the chat shows just "Try harder." */
const HARDER_PROMPT =
  'Try that again, harder. Look at your last answer critically, think it through more carefully and thoroughly, fix anything wrong or missing, and give your best answer.';

/** Sent when a turn cut off by a plan limit picks up again after the reset. */
const CONTINUE_PROMPT =
  'The Claude plan usage limit interrupted your last turn. It has reset now: continue where you left off and finish what the user asked.';

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** How often AUTO may step a struggling reply up (each one step on the ladder). */
const MAX_STEPS = 2;
/** A chat used here this recently isn't closed by the other device's layout. */

/** How long a waiting hand-off waits for the other chat before giving up on getting the answer back. */
const HANDOFF_WAIT_MS = 15 * 60 * 1000;
/** The longest answer a hand-off brings back into the waiting chat. */
const HANDOFF_REPLY_CHARS = 12_000;

/** How an attachment is named on the user's line: an upload by its name, a file or folder on the PC by its full path (the gate trusts those). */
const lineName = (f: Attachment) => f.path ?? f.name;

/** Who chose a turn's model, in the words of the note Claude gets. */
const pickedBy = (source: RouteSource): string =>
  source === 'manual' || source === 'override' ? 'the user' : source === 'harder' ? 'the user’s "Try harder"' : 'AUTO';

/** A message typed while its chat was busy; it runs when the turn ends (like Claude Code's queue). */
type FollowUp = QueuedMessage & {
  message: string;
  choice: ModelChoice;
  effort: EffortLevel;
  attachments: Attachment[];
  /** Spoken: folded in with `SPOKEN_ADDITION`, or its own turn gets the spoken note. A sign-off is never folded (the full review, S18). */
  spoken?: boolean;
  bye?: boolean;
};

/** A message waiting for a plan limit to reset. */
type Queued =
  | { tabId: string; kind: 'send'; message: string; choice: ModelChoice; effort: EffortLevel; files: Attachment[] }
  | { tabId: string; kind: 'continue' };

/** A chat Harv hasn't named yet: its first message as the name (cut with "…", or over 3 words). */
export function unnamed(title: string | undefined): boolean {
  return !title || title.endsWith('…') || title.trim().split(/\s+/).length > 3;
}

/** In front of a spoken turn (Siri, the phone's voice mode): the reply is read aloud. */
const SPOKEN_NOTE =
  "[The user is talking to you by voice (from their phone, or holding the talk key at the computer), and your reply is read aloud; their words came through speech recognition, so a misheard word is possible. Answer in English, even when they speak Slovak (their choice for now: your spoken voice is English only). Look things up and do the work as fully as you would in a typed chat (check projects, files, git, your memory), but keep the reply itself to one to three short spoken sentences: no Markdown, lists, tables, code or file paths unless they ask. When you'll use tools, your first words come before the first tool call: one short spoken sentence on what you're about to do (it is read aloud at once, so they aren't left in silence); then do it, and end with one short spoken sentence on the result.]\n\n";

/** The spoken note with this computer's clock: "what time is it" needed a tool call (a whole extra step) before. */
const spokenNote = (now = new Date()) =>
  `${SPOKEN_NOTE}[It is now ${now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} on this computer.]\n\n`;

/**
 * In front of words spoken while Harv works, handed into the running reply (the user's wish, 2026-11-17:
 * "I'll mainly add to the running task, it should feel natural"). The reply goes on; the dashboard
 * reads the acknowledgement and the last sentence aloud (`lib/voice.ts`).
 */
export const SPOKEN_ADDITION =
  "[Said by voice just now, while you work (speech recognition, so a word may be misheard). Most likely it adds to or changes what you're doing: take it in, make your next text one short spoken sentence that says so (\"Got it, blue it is.\"), then carry on. If it's clearly a new, unrelated request, start it in a new chat with hand_off (wait: false), say so in one short sentence, and carry on with your work. If you can't tell which it is, ask in one short sentence. End this reply with one short plain sentence on the result: it is read aloud.]\n\n";

/** In front of the first message of a chat opened by "start a new chat and …" (the whole sentence comes along). */
const MOVED_NOTE =
  '[The user asked for a new chat with this message, and this is it: it is open now, and their other chat goes on by itself. Do the rest of what they asked, here.]\n\n';

/** In front of a sign-off ("bye"): the wrap-up of persona rules 13 and 14, which Harv skipped at both byes before (2026-11-09). */
const BYE_NOTE =
  '[The user is signing off. Wrap up before you say bye (persona rules 13 and 14): save anything worth keeping to memory, then run the learn-from-session skill (the Skill tool) and end with a short list of what you learned and where you put it. In a project chat, also make sure the work is committed and pushed. If the session had nothing worth learning, say so in one line.]\n\n';

/**
 * Owns one ChatSession per open tab, derives Harv's overall status, and records
 * every finished line in the history database so chats survive restarts.
 */
export class ChatManager {
  private sessions = new Map<string, ChatSession>();
  /** Chats that just moved into or out of a project: the conversation so far, given to the new session with the next message. */
  private carry = new Map<string, string>();
  /** Chats whose project changed mid-turn: their session ends when the turn does. */
  private switchAfterTurn = new Set<string>();
  /** Normal chats that load every skill (the user asked for one they don't list). */
  private allSkills = new Set<string>();
  /** Old sessions about to go (their turn just ended): a message arriving first makes it happen at once, so it never lands in the old one. */
  private dropping = new Set<string>();
  /** Tag and routing reason of the turn currently running per tab ("sonnet·medium"). */
  private tags = new Map<string, { tag: string; reason: string }>();
  /** The model·effort each tab's last turn ran at, for "Try harder". */
  private lastRun = new Map<string, { model: string; effort: EffortLevel }>();
  /** Each chat's reply running now (as chat.started named it), for windows that connect mid-reply. */
  private running = new Map<string, NonNullable<ChatSnapshot['running']>>();
  /** Answers a /btw side question (replaced in tests). */
  ask = sideQuestion;
  /** Runs a task on its own, without a chat (replaced in tests). */
  alone = runAlone;
  /** Background runs with no chat (a shared reel): their name in harv_skills.md lines. */
  private aloneTitles = new Map<string, string>();
  /** Messages runScheduled made, so their turn is read as unattended by how it started (the full review, S26). */
  private scheduledTexts = new Set<string>();
  /** Work waiting for a plan limit to reset, sent in order when it does. */
  private queue: Queued[] = [];
  private flushing = false;
  /** Tabs whose running turn hit a plan limit; they continue after the reset. */
  private limited = new Set<string>();
  /** Tabs running /fresh, with the summary their turn writes: when it ends, the next message starts a new session from it. */
  private freshening = new Map<string, string[]>();
  /** Tabs running /clear: when it succeeds, their log empties too. */
  private clearing = new Set<string>();
  /** Resolvers waiting for a tab's turn to finish. */
  private waiters = new Map<string, (() => void)[]>();
  /** Chats waiting on a hand-off (from → to), to refuse loops. */
  private handoffs = new Map<string, string>();
  /** What a tab replies while another chat waits for it. */
  private replies = new Map<string, string[]>();
  /** A note for Claude in front of a tab's next turn only (e.g. "this reply is spoken", docs/PLAN.md §6q voice). */
  private notes = new Map<string, string>();
  /** Tabs told to stop cleanly near the end of a session window ("<tab>:<window>", usage/budget.ts). */
  private stopTold = new Set<string>();
  /** Messages typed while a tab was busy, in order. */
  private followUps = new Map<string, FollowUp[]>();
  /** Each running session's slash commands (otherwise the catalog's). */
  private commands = new Map<string, SlashCommandInfo[]>();
  /** Chats just rewound: their next session resumes the conversation cut back to this entry. */
  private forkAt = new Map<string, string>();
  catalog: Catalog | null = null;
  /** Harv's scheduler (set by the server once it exists). */
  schedules?: ScheduleTools & { dropChat(tabId: string): void };
  /** Each chat's visible terminal (set by the server). */
  terminal?: TerminalTools;
  /** Pictures from Gemini (set by the server). */
  images?: ImageTools;
  /** The shared browser in the app (set by the server). */
  browser?: BrowserTools;
  /** Desktop control's MCP server when it's on and installed (set by the server, docs/PLAN.md §6t item 1). */
  desktop?: () => McpStdioServerConfig | undefined;
  /** The monitor desktop control works on (set by the server). */
  desktopArea?: () => WorkArea | null;
  /** A chat the user deleted here: its held items and action inputs go too (set by the server; the full review, D18). */
  onDeleted?: (tabId: string) => void;
  /** The project list, project tools and project sync (projectLink.ts). */
  private projects: ProjectLink;

  constructor(
    private store: ChatStore,
    private gate: SafetyGate,
    private router: Router,
    private meter: UsageMeter,
    private broadcast: (msg: ChatServerMessage | ProjectServerMessage) => void,
    private onStatus: (status: HarvStatus) => void,
  ) {
    this.projects = new ProjectLink({
      store,
      broadcast: (msg) => this.broadcast(msg),
      publishHistory: () => this.publishHistory(),
      busy: (tabId) => this.busy(tabId),
      setProject: (tabId, projectId) => this.setProject(tabId, projectId),
      writeReport: (tabId, text, skills) => this.writeReport(tabId, text, skills),
    });
  }

  get status(): HarvStatus {
    const all = [...this.sessions.values()];
    if (this.gate.waiting > 0) return 'waiting';
    if (all.some((s) => s.toolRunning)) return 'working';
    if (all.some((s) => s.busy) || this.routing.size > 0) return 'thinking';
    if (this.meter.paused) return 'paused';
    return 'idle';
  }

  /** The running tool's name while Harv is working. */
  get statusDetail(): string | undefined {
    return [...this.sessions.values()].find((s) => s.toolRunning)?.toolName;
  }

  history(query = '') {
    return this.store.history(query);
  }

  openChats() {
    return this.store.openChats().map((chat) => {
      const queued = this.queuedOf(chat.id);
      const commands = this.commands.get(chat.id);
      const tasks = this.sessions.get(chat.id)?.tasks() ?? [];
      return {
        ...chat,
        ...(queued.length ? { queued } : {}),
        ...(commands ? { commands } : {}),
        ...(tasks.length ? { tasks } : {}),
        ...(this.gate.isPlanning(chat.id) ? { planning: true } : {}),
        ...(this.busy(chat.id) && this.running.has(chat.id) ? { running: this.running.get(chat.id) } : {}),
      };
    });
  }

  private queuedOf(tabId: string): QueuedMessage[] {
    return (this.followUps.get(tabId) ?? []).map(({ id, text, files, attachments, handed }) => ({
      id,
      text,
      ...(files?.length ? { files, attachments } : {}),
      ...(handed ? { handed } : {}),
    }));
  }

  private publishQueued(tabId: string) {
    this.broadcast({ type: 'chat.queued', tabId, items: this.queuedOf(tabId) });
  }

  /** Drops a message from a tab's queue before it runs. */
  unqueue(tabId: string, id: string): void {
    const list = this.followUps.get(tabId);
    // One already handed to Claude can't be taken back (it goes in at the reply's next step).
    if (!list?.some((f) => f.id === id && !f.handed)) return;
    this.followUps.set(
      tabId,
      list.filter((f) => f.id !== id),
    );
    this.publishQueued(tabId);
  }

  /** "Send now" on a queued message: it moves to the front and the current reply stops, so it runs next. */
  async sendNow(tabId: string, id: string): Promise<void> {
    const list = this.followUps.get(tabId);
    const item = list?.find((f) => f.id === id);
    if (!list || !item || item.handed) return;
    this.followUps.set(tabId, [item, ...list.filter((f) => f !== item)]);
    this.publishQueued(tabId);
    if (!this.busy(tabId)) return void this.nextFollowUp(tabId);
    // Stopping ends the turn (and denies its waiting approvals); chat.done then runs the queue's first message.
    this.gate.cancel(tabId);
    await this.sessions.get(tabId)?.stop();
  }

  /** The turn ended: the next queued message runs (a plan limit sends it to the limit queue instead). */
  private async nextFollowUp(tabId: string): Promise<void> {
    if (this.busy(tabId)) return;
    // A message already handed to Claude runs as Claude's own next turn (onFolded); the rest wait for it.
    if (this.followUps.get(tabId)?.some((f) => f.handed)) return;
    const next = this.followUps.get(tabId)?.shift();
    if (!next) return;
    this.publishQueued(tabId);
    this.addLine(tabId, { kind: 'you', text: next.message, ...(next.files?.length ? { files: next.files } : {}) });
    this.setNote(tabId, next.spoken, next.bye);
    await this.begin(tabId, next.message, next.choice, next.effort, next.attachments, false);
    // A message that ended without a turn (a refused command, a plan limit) lets the next one go too.
    if (!this.busy(tabId) && this.followUps.get(tabId)?.length) setTimeout(() => void this.nextFollowUp(tabId), 0);
  }

  /**
   * The reply started a tool: queued messages go to Claude now, so it reads them after this step,
   * like Claude Code (the user's wish, 2026-11-05; docs/PLAN.md §6ac). Commands (/opus …, /fresh…)
   * still wait for the reply to end, as does everything while a plan limit pauses Harv.
   */
  private handOver(tabId: string): void {
    const session = this.sessions.get(tabId);
    const list = this.followUps.get(tabId);
    if (!session?.toolRunning || !list?.length || this.meter.paused) return;
    let handed = false;
    for (const f of list) {
      if (f.handed) continue;
      // In order: a command waits, and so does everything typed after it. So does a scheduled task: folded
      // in, its prompt counted as the user's words for the gate (the full review, S11).
      // A "bye" too: its note would be lost inside this reply (the full review, S18). Spoken words go in
      // with a note of their own: a short spoken "got it" and a spoken last line (2026-11-17).
      if (f.message.trim().startsWith('/') || f.message.startsWith(SCHEDULED_TAG) || f.bye) break;
      const words = f.spoken ? SPOKEN_ADDITION + f.message : f.message;
      const content = f.attachments.length ? buildContent(tabId, words, f.attachments) : words;
      if (!session.fold(f.id as UUID, content, { text: f.message })) break;
      f.handed = true;
      handed = true;
    }
    if (handed) this.publishQueued(tabId);
  }

  /** Claude took a handed-over message: it leaves the queue and shows as the user's line right here. */
  private folded(tabId: string, id: string, newTurn: boolean): void {
    const list = this.followUps.get(tabId) ?? [];
    const f = list.find((x) => x.id === id);
    if (!f) return;
    this.followUps.set(
      tabId,
      list.filter((x) => x !== f),
    );
    this.publishQueued(tabId);
    this.addLine(tabId, { kind: 'you', text: f.message, ...(f.files?.length ? { files: f.files } : {}) });
    if (!newTurn) {
      // The sending check and the monitor check read what this turn was asked, the new message too.
      this.gate.addToTurn(tabId, f.message);
      return;
    }
    // The reply ended (or was stopped) before its next step: Claude runs the message as its own turn.
    // Claude already has the message, so a yes to held actions only grants them here (no note).
    void this.gate.setTurn(tabId, f.message);
    const decision = this.manualTurn(tabId, 'manual', 'your queued message, right after the reply');
    this.emit({
      type: 'chat.started',
      tabId,
      model: this.modelName(decision.model),
      effort: decision.effort,
      auto: false,
      reason: decision.reason,
    });
  }

  /** The session is gone: messages handed to it never arrive, so they wait in the queue again. */
  private unhand(tabId: string): void {
    const list = this.followUps.get(tabId);
    if (!list?.some((f) => f.handed)) return;
    for (const f of list) delete f.handed;
    this.publishQueued(tabId);
    if (!this.busy(tabId)) setTimeout(() => void this.nextFollowUp(tabId), 0);
  }

  private modelName(id: string): string {
    return this.catalog?.models.find((m) => m.id === id)?.name ?? id;
  }

  private publishHistory() {
    this.broadcast({ type: 'history', items: this.store.history(), query: '' });
  }

  /** Records finished lines, then forwards every event to the dashboards. */
  private emit = (msg: ChatServerMessage) => {
    const save = (line: StoredLine) => 'tabId' in msg && this.store.addLine(msg.tabId, line);
    switch (msg.type) {
      case 'chat.started':
        this.meter.turnStarted();
        this.tags.set(msg.tabId, { tag: `${msg.model.split(' ')[0]!.toLowerCase()}·${msg.effort}`, reason: msg.reason });
        this.running.set(msg.tabId, {
          since: Date.now(),
          model: msg.model,
          effort: msg.effort,
          ...(msg.reason ? { reason: msg.reason } : {}),
        });
        break;
      case 'chat.stepped':
        // The rest of the reply is tagged with what it runs at now.
        this.tags.set(msg.tabId, { tag: `${msg.model.split(' ')[0]!.toLowerCase()}·${msg.effort}`, reason: msg.reason });
        break;
      case 'chat.assistant':
        save({ kind: 'harv', text: msg.text, ...this.tags.get(msg.tabId) });
        this.replies.get(msg.tabId)?.push(msg.text);
        this.freshening.get(msg.tabId)?.push(msg.text);
        break;
      case 'chat.tool':
        save({ kind: 'tool', text: msg.detail ? `${msg.name} · ${msg.detail}` : msg.name, ref: msg.id });
        break;
      case 'chat.notice':
        save({ kind: 'notice', text: msg.message });
        break;
      case 'chat.thinking':
        save({ kind: 'thinking', text: msg.text, tag: `${msg.seconds}s` });
        break;
      case 'chat.context':
        this.store.setContext(msg.tabId, msg.tokens);
        break;
      case 'chat.error':
        save({ kind: 'error', text: msg.message });
        this.replies.get(msg.tabId)?.push(`(error: ${msg.message})`);
        break;
      case 'chat.done':
        this.running.delete(msg.tabId);
        this.gate.turnEnded(msg.tabId);
        this.router.finished(msg.tabId, msg.ok, msg.stopped, msg.usage, msg.troubled);
        this.meter.turnFinished();
        this.turnEnded(msg.tabId);
        this.refreshMap(msg.tabId);
        if (msg.stopped) save({ kind: 'notice', text: 'Stopped.' });
        if (msg.error) save({ kind: 'error', text: msg.error });
        if (this.limited.delete(msg.tabId)) {
          this.enqueue({ tabId: msg.tabId, kind: 'continue' });
          this.emit({ type: 'chat.notice', tabId: msg.tabId, message: `Harv will pick this up where it left off ${this.resetText()}.` });
        }
        break;
    }
    this.broadcast(msg);
    if (msg.type === 'chat.done') {
      const fresh = this.freshening.get(msg.tabId);
      if (fresh) {
        this.freshening.delete(msg.tabId);
        // The summary is what the turn said last (anything before it was about saving memory).
        const summary = fresh.at(-1)?.trim();
        if (msg.ok && summary) this.startFresh(msg.tabId, summary);
        else if (!msg.stopped) this.notice(msg.tabId, 'Couldn’t write the handoff summary, so this chat keeps its session.');
      }
      if (this.clearing.delete(msg.tabId) && msg.ok) {
        this.store.clearLines(msg.tabId);
        this.router.forget(msg.tabId);
        this.dropHeld(msg.tabId, 'the chat was cleared');
        this.broadcast({ type: 'chat.cleared', tabId: msg.tabId });
      }
      for (const resolve of this.waiters.get(msg.tabId) ?? []) resolve();
      this.waiters.delete(msg.tabId);
      // Whatever ended the turn (done, error or Stop), the next queued message runs.
      if (this.followUps.get(msg.tabId)?.length) setTimeout(() => void this.nextFollowUp(msg.tabId), 0);
    }
  };

  private resetText(): string {
    const until = this.meter.snapshot().pausedUntil;
    return until ? `when the limit resets at ${clock(until)}` : 'when the limit resets';
  }

  private enqueue(item: Queued) {
    this.queue.push(item);
    this.meter.queued = this.queue.length;
    this.meter.publish();
  }

  /** Drops a tab's queued work; returns how many items were removed. */
  private dequeueTab(tabId: string): number {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.tabId !== tabId);
    this.limited.delete(tabId);
    if (this.queue.length !== before) {
      this.meter.queued = this.queue.length;
      this.meter.publish();
    }
    return before - this.queue.length;
  }

  private turnDone(tabId: string): Promise<void> {
    if (!this.busy(tabId)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.set(tabId, [...(this.waiters.get(tabId) ?? []), resolve]));
  }

  /** The limit reset: send the queued work in order, one turn at a time. */
  async flushQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0 && !this.meter.paused) {
        const item = this.queue.shift()!;
        this.meter.queued = this.queue.length;
        this.meter.publish();
        if (!this.store.exists(item.tabId)) continue;
        // One item that throws says so in its chat; the rest of the queue still runs (it waited for
        // the next reset: the full review, S26).
        try {
          await this.turnDone(item.tabId);
          if (item.kind === 'send') {
            this.emit({ type: 'chat.notice', tabId: item.tabId, message: 'The limit reset, so Harv is sending your queued message.' });
            await this.start(item.tabId, item.message, item.choice, item.effort, item.files);
          } else {
            const decision = this.manualTurn(item.tabId, 'followup', 'continuing after the limit reset');
            this.gate.resumeTurn(item.tabId, this.lastAsked(item.tabId));
            await this.run(item.tabId, decision, true, CONTINUE_PROMPT);
          }
          await this.turnDone(item.tabId);
        } catch (err) {
          const what = item.kind === 'send' ? 'your queued message' : 'the cut-off reply';
          this.emit({
            type: 'chat.notice',
            tabId: item.tabId,
            message: `Harv couldn't start ${what} after the reset: ${(err as Error).message}`,
          });
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private session(tabId: string, model: string, effort: EffortLevel): ChatSession {
    if (this.dropping.delete(tabId)) this.dropSession(tabId);
    let session = this.sessions.get(tabId);
    if (session) return session;
    const resume = this.store.getSession(tabId) ?? undefined;
    const resumeAt = this.forkAt.get(tabId);
    this.forkAt.delete(tabId);
    session = new ChatSession(
      tabId,
      model,
      effort,
      this.emit,
      {
        onStateChange: () => this.onStatus(this.status),
        onSessionId: (id) => this.store.setSession(tabId, id),
        onChainEnd: (uuid) => this.store.setChainEnd(tabId, uuid),
        onAutoTurn: () => {
          // Shown and logged as a turn of its own, at the model and effort the session runs.
          const decision = this.manualTurn(
            tabId,
            'background',
            'Harv picked this up by itself: a background task it started has finished.',
          );
          this.emit({
            type: 'chat.started',
            tabId,
            model: this.modelName(decision.model),
            effort: decision.effort,
            auto: false,
            reason: decision.reason,
          });
        },
        onCommands: (commands) => {
          this.commands.set(tabId, commands);
          this.broadcast({ type: 'chat.commands', tabId, commands });
        },
        onRateLimit: (info) => {
          this.meter.rateLimit(info);
          if (info.status === 'rejected') this.limited.add(tabId);
        },
        onNoCredits: (model, until) => this.meter.modelNeedsCredits(model, until),
        onStruggle: (why) => void this.stepUp(tabId, why),
        onToolUse: () => this.handOver(tabId),
        onFolded: (id, newTurn) => this.folded(tabId, id, newTurn),
        onEnded: () => {
          this.unhand(tabId);
          // The next message starts a new session (resuming this conversation) instead of vanishing into a dead one.
          if (this.sessions.get(tabId) === session) this.sessions.delete(tabId);
        },
        onResumeFailed: () => {
          // The old Claude transcript is gone; the next message starts a fresh session.
          this.sessions.delete(tabId);
          this.store.setSession(tabId, null);
          this.emit({
            type: 'chat.notice',
            tabId,
            message: 'Couldn’t resume the earlier conversation with Claude, so a fresh one starts. Please send that again.',
          });
        },
      },
      this.store,
      this.gate,
      { resume, resumeAt: resume ? resumeAt : undefined, chainEnd: this.store.chainEnd(tabId), planning: this.gate.isPlanning(tabId) },
      (req, signal) => this.delegate(tabId, req, signal),
      this.chatMode(tabId),
    );
    this.sessions.set(tabId, session);
    return session;
  }

  /** What a chat's session runs with besides the store and the gate: its project and Harv's tools. /btw uses the same, so its prompt is cached. */
  private chatMode(tabId: string) {
    return {
      project: this.store.projectOf(tabId),
      ...(this.allSkills.has(tabId) ? { allSkills: true } : {}),
      projects: this.projectTools,
      schedules: this.schedules,
      terminal: this.terminal,
      images: this.images,
      browser: this.browser,
      models: {
        set: (tab: string, model: 'auto' | 'haiku' | 'sonnet' | 'opus' | 'fable', effort: EffortLevel = 'high') => {
          this.emit({ type: 'chat.pick', tabId: tab, model, effort });
          return model === 'auto'
            ? 'Done: this chat is on AUTO again from the next message.'
            : `Done: this chat runs on ${model}·${effort} from the next message, until the user picks AUTO again.`;
        },
        demo: (tab: string) => {
          this.emit({ type: 'presence.demo', tabId: tab });
          return 'The demo plays in this chat in a few seconds and takes about 25 s. It shows only in the chat on screen, in a wide enough window, never on the phone; with motion off it steps through still pictures.';
        },
        usage: () => usageText(this.meter.snapshot(), Date.now(), this.router.costGuide()),
      },
      desktop: this.desktop?.(),
      desktopArea: this.desktopArea?.(),
      usageStop: () => this.usageStop(tabId),
    };
  }

  /** The clean-stop note for a reply that runs into the end of the session: once per tab per session window. */
  private usageStop(tabId: string): string {
    const m = this.meter.sessionMeter();
    const note = stopNote(m);
    if (!note || !m) return '';
    const key = `${tabId}:${windowOf(m)}`;
    if (this.stopTold.has(key)) return '';
    this.stopTold.add(key);
    return note;
  }

  async send(
    tabId: string,
    message: string,
    choice: ModelChoice,
    effort: EffortLevel,
    sent: Attachment[] = [],
    spoken = false,
  ): Promise<void> {
    const bye = isSignOff(message);
    // "Start a new chat and …" in a chat that has begun: a new tab gets it, and this one goes on (§6ac).
    if (!sent.length && this.store.exists(tabId) && newChatTask(message) !== null)
      return this.moveToNewChat(tabId, message, choice, effort, spoken);
    // Files and folders on the PC are checked here (the dashboard only names them).
    const files = cleanAttachments(sent);
    const isNew = !this.store.exists(tabId);
    // Leave `/opus`-style override words out of the title.
    this.store.ensureChat(tabId, titleFrom(parseOverride(message).text.trim() || message || (files[0]?.name ?? 'Attachment')));
    this.store.setOpen(tabId, true);
    // /btw: a side question, answered right away even while Harv works (it never queues or interrupts).
    const btw = /^\/btw(?:\s+([\s\S]*))?$/i.exec(message.trim());
    if (btw && !files.length) {
      if (isNew) this.publishHistory();
      return this.btw(tabId, (btw[1] ?? '').trim());
    }
    // /report: a note for the user's harv_report.md, written right here (no model call, never queued).
    const report = /^\/report(?:\s+([\s\S]*))?$/i.exec(message.trim());
    if (report && !files.length) {
      if (isNew) this.publishHistory();
      return this.report(tabId, (report[1] ?? '').trim());
    }
    if (this.busy(tabId) || this.followUps.get(tabId)?.length) {
      // Like Claude Code: what's typed while Harv works waits its turn, and runs when this one ends.
      const list = this.followUps.get(tabId) ?? [];
      const names = files.map(lineName);
      list.push({
        id: randomUUID(),
        text: message,
        ...(names.length ? { files: names } : {}),
        message,
        choice,
        effort,
        attachments: files,
        ...(spoken ? { spoken } : {}),
        ...(bye ? { bye } : {}),
      });
      this.followUps.set(tabId, list);
      this.publishQueued(tabId);
      if (!this.busy(tabId)) void this.nextFollowUp(tabId);
      // A tool is running right now: it goes in after it (like Claude Code), not after the whole reply.
      else this.handOver(tabId);
      return;
    }
    this.setNote(tabId, spoken, bye);
    this.store.addLine(tabId, { kind: 'you', text: message, ...(files.length ? { files: files.map(lineName) } : {}) });
    if (isNew) this.publishHistory();
    await this.begin(tabId, message, choice, effort, files, isNew);
  }

  /**
   * "Start a new chat and look up X": a new tab opens with the user's whole sentence as its first
   * message (nothing lost by cutting it), routed like any message; the chat it was said in keeps
   * working. The window showing that chat switches to the new one (`movedFrom`), its voice follows.
   */
  private async moveToNewChat(fromTab: string, message: string, choice: ModelChoice, effort: EffortLevel, spoken: boolean) {
    const task = newChatTask(message) ?? '';
    const to = randomUUID();
    this.store.ensureChat(to, titleFrom(task || 'New chat'));
    this.store.setOpen(to, true);
    this.addLine(fromTab, { kind: 'notice', text: task ? `Started a new chat for “${titleFrom(task)}”.` : 'Opened a new chat.' });
    this.broadcast({ type: 'chat.opened', chat: this.store.snapshot(to)!, focus: false, movedFrom: fromTab });
    this.publishHistory();
    if (!task) return;
    this.addLine(to, { kind: 'you', text: message });
    this.setNote(to, spoken, false);
    this.notes.set(to, (this.notes.get(to) ?? '') + MOVED_NOTE);
    await this.begin(to, message, choice, effort, [], true);
  }

  /** The spoken and sign-off notes, for the turn about to start with this message. */
  private setNote(tabId: string, spoken = false, bye = false): void {
    const note = (spoken ? spokenNote() : '') + (bye ? BYE_NOTE : '');
    if (note) this.notes.set(tabId, note);
  }

  /** Runs a message whose "you" line is already in the chat: queued for a plan limit, a slash command, or a routed turn. */
  private async begin(tabId: string, message: string, choice: ModelChoice, effort: EffortLevel, files: Attachment[], isNew: boolean) {
    // A plan limit is hit (or this tab still has queued work): wait for the reset instead of sending.
    if (this.meter.paused || this.queue.some((q) => q.tabId === tabId)) {
      this.enqueue({ tabId, kind: 'send', message, choice, effort, files });
      return this.refuse(tabId, `Claude Pro limit reached, so this is queued. Harv sends it ${this.resetText()}.`);
    }
    if (/^\/fresh\s*$/i.test(message.trim()) && !files.length) {
      await this.fresh(tabId);
      return;
    }
    // A skill the normal chat doesn't list (code-review, simplify, frontend-design…), asked for by name:
    // the chat loads every skill from now on, like a project chat. Same conversation, resumed.
    // Read without a leading /opus, /low… ("/haiku use the X skill" isn't a command called haiku).
    const asked = parseOverride(message).text.trim();
    // A mistyped /word (the dashboard catches it first; the phone and Siri come here): no skills
    // reload, nothing sent, the nearest command offered (the user's wish, 2026-11-09).
    const typo = unknownCommand(
      asked,
      [...(this.catalog?.commands ?? []), ...(this.commands.get(tabId) ?? [])].map((c) => c.name),
    );
    if (typo) return this.refuse(tabId, unknownCommandText(typo));
    if (
      !this.allSkills.has(tabId) &&
      !this.store.projectOf(tabId) &&
      asksForSkill(
        asked,
        (n) => this.isCommand(tabId, n),
        (w) => !!parseOverride(`/${w}`).model || !!parseOverride(`/${w}`).effort,
        (n) => isInstalledSkill(n),
      )
    ) {
      this.allSkills.add(tabId);
      this.dropSession(tabId);
      this.commands.delete(tabId);
      this.emit({ type: 'chat.notice', tabId, message: 'This chat now has all your skills (the ones project chats have).' });
      const named = commandName(asked);
      if (named && !files.length && !hiddenReason(named)) {
        await this.runCommand(tabId, named, asked);
        return;
      }
    }
    const command = commandName(message);
    if (command && !files.length && this.isCommand(tabId, command)) {
      await this.runCommand(tabId, command, message.trim());
      return;
    }
    await this.start(tabId, message, choice, effort, files);
    // Manual mode and a one-message model override (/haiku …) skip the classifier, so a new chat gets its short name from one cheap call.
    if (isNew && (choice !== 'auto' || parseOverride(message).model)) {
      void this.router.name(parseOverride(message).text, files).then((named) => this.autoName(tabId, named));
    }
  }

  /** Where /report writes: harv_report.md in the repo (gitignored; replaced in tests). */
  ideasFile = fileURLToPath(new URL('../../../../harv_report.md', import.meta.url));
  /** Where Harv's skill and tool reviews go: harv_skills.md, the same way (replaced in tests). */
  skillsFile = fileURLToPath(new URL('../../../../harv_skills.md', import.meta.url));

  /** /report: appends a dated note to harv_report.md, which device sync carries to the other devices. */
  private report(tabId: string, text: string) {
    this.addLine(tabId, { kind: 'you', text: text ? `/report ${text}` : '/report' });
    if (!text) return this.notice(tabId, 'Write the note after it: /report the explorer forgets my folder after a restart');
    this.notice(tabId, this.writeReport(tabId, text));
  }

  /** One dated line in harv_report.md (or harv_skills.md for a skill review), stamped now (by /report and the chats' report_note tool). */
  private writeReport(tabId: string, text: string, skills = false): string {
    const chat = this.store.title(tabId) ?? this.aloneTitles.get(tabId) ?? 'chat';
    return appendNote(skills ? this.skillsFile : this.ideasFile, skills, text, chat);
  }

  /** /btw: answered from a fork of this chat's session (see btw.ts); both lines go in the log, not in Claude's context. */
  private async btw(tabId: string, question: string) {
    this.addLine(tabId, { kind: 'you', text: question ? `/btw ${question}` : '/btw' });
    if (!question) return this.notice(tabId, 'Ask a side question after it: /btw what does that error mean?');
    if (this.meter.paused)
      return this.notice(tabId, `Claude Pro limit reached, so /btw can’t answer until ${this.resetText().replace(/^when /, '')}.`);
    const last = this.lastPick(tabId);
    const answer = await this.ask(
      question,
      last.model,
      // The chat's own context, tools included, so the fork's prompt matches the cached one (audit B4).
      {
        store: this.store,
        tabId,
        gate: this.gate,
        delegate: (req, signal) => this.delegate(tabId, req, signal),
        ...this.chatMode(tabId),
      },
      this.store.getSession(tabId) ?? undefined,
    );
    if (!this.store.exists(tabId)) return;
    const text = typeof answer === 'string' ? answer : 'text' in answer ? answer.text : '';
    if (!text) {
      const why = typeof answer === 'object' && 'error' in answer ? answer.error : 'no answer came back';
      return this.notice(tabId, `Couldn’t answer that side question (${why}). Try again, or ask it as a normal message.`);
    }
    const cache = typeof answer === 'object' && 'cache' in answer ? ` ${answer.cache}.` : '';
    this.addLine(tabId, {
      kind: 'harv',
      text,
      tag: `btw·${this.modelName(last.model).split(' ')[0]!.toLowerCase()}`,
      reason: `A side question (/btw): answered from this chat without interrupting it, and not added to it.${cache}`,
    });
  }

  /** A Claude Code slash command this chat offers (or one Harv refuses), as opposed to a `/opus`-style word or a path. */
  private isCommand(tabId: string, name: string): boolean {
    if (hiddenReason(name)) return true;
    const list = this.commands.get(tabId) ?? this.catalog?.commands ?? [];
    return list.some((c) => c.name === name);
  }

  /**
   * A slash command goes to Claude Code exactly as typed, at the chat's last model·effort
   * (no router: the classifier can't judge "/compact", and skipping it saves a call).
   */
  private async runCommand(tabId: string, name: string, text: string) {
    const refused = hiddenReason(name);
    if (refused) return this.refuse(tabId, `Harv doesn’t run /${name}. ${refused}`);
    if (name === 'clear') this.clearing.add(tabId);
    const decision = this.manualTurn(tabId, 'command', `Claude Code command /${name}`);
    this.gate.resumeTurn(tabId, text);
    await this.run(tabId, decision, false, text, true);
  }

  /**
   * /fresh (the user's wish 2026-10-25; /clear stays): one turn at the chat's model saves
   * what's worth keeping and writes a handoff summary; when it ends, the next message
   * starts a new Claude session with that summary instead of the whole conversation.
   */
  private async fresh(tabId: string) {
    if (!this.store.getSession(tabId)) return this.refuse(tabId, 'This chat has no session yet, so it’s already fresh.');
    this.freshening.set(tabId, []);
    const decision = this.manualTurn(tabId, 'command', '/fresh: saving memory and a handoff summary');
    const project = this.store.projectOf(tabId);
    await this.run(
      tabId,
      decision,
      false,
      [
        '[/fresh: the user is moving this chat to a fresh session to keep it small. The next session sees only what you write now, not this conversation.]',
        `1. Save anything worth keeping that isn't saved yet: facts about the user with remember${project ? ", and the project's state in its memory and CLAUDE.md, as you normally would" : ''}. Skip this if nothing is new.`,
        '2. Then end with ONE message that is only the handoff summary for your next session, no preamble: what we are working on, decisions made, where things stand (files, commands, results), open questions, and the exact next step. Keep names, paths and numbers exact. At most about 400 words.',
      ].join('\n'),
      true,
    );
  }

  /** The /fresh turn ended with its summary: the old session goes, and the next message starts from the summary. */
  /**
   * What waited for the user's yes goes when the conversation that led to it does (/clear, /fresh,
   * a rewind): a later "ok" mustn't grant it (the full review, S23).
   */
  private dropHeld(tabId: string, why: string) {
    const count = this.gate.heldCount(tabId);
    if (!count) return;
    this.gate.forget(tabId);
    this.notice(tabId, `Dropped what was waiting for your yes (${count === 1 ? 'one action' : `${count} actions`}): ${why}.`);
  }

  private startFresh(tabId: string, summary: string) {
    this.carry.set(
      tabId,
      `[This chat moved to a fresh session (/fresh) to keep it small. Your handoff summary from the previous session:]\n${summary}\n[End of the summary. Earlier lines are still in the chat's history (read_chat) if you need them.]\n\n`,
    );
    this.store.setSession(tabId, null);
    setTimeout(() => this.dropSession(tabId), 0);
    this.router.forget(tabId);
    this.dropHeld(tabId, 'the chat moved to a fresh session');
    this.store.setContext(tabId, 0);
    this.broadcast({ type: 'chat.context', tabId, tokens: 0 });
    this.addLine(tabId, { kind: 'notice', text: '— fresh session — (the next message starts a new session from the summary above)' });
  }

  /**
   * What the classifier said about a chat: its short name (skipped once the user named it) and its
   * one-line summary, which every other chat sees (docs/PLAN.md §6c; no extra model call).
   */
  private autoName(tabId: string, named: { title?: string; summary?: string }) {
    if (named.summary && this.store.exists(tabId)) {
      const before = this.store.summary(tabId);
      this.store.setSummary(tabId, named.summary);
      if (named.title) this.autoTitle(tabId, named.title);
      if (before !== named.summary) this.publishHistory();
    } else if (named.title) this.autoTitle(tabId, named.title);
  }

  /** Harv's short name for what a chat is about; skipped once the user has named it. */
  private autoTitle(tabId: string, title: string) {
    if (!this.store.exists(tabId) || this.store.titleLocked(tabId) || this.store.title(tabId) === title) return;
    this.store.setTitle(tabId, title);
    this.broadcast({ type: 'chat.renamed', tabId, title });
    this.publishHistory();
  }

  /** The user renamed a chat (right-click on its tab). */
  rename(tabId: string, raw: string): void {
    const title = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!title) return;
    // A tab that hasn't sent anything yet is saved now, so its name sticks.
    this.store.ensureChat(tabId, title);
    this.store.setTitle(tabId, title, true);
    this.broadcast({ type: 'chat.renamed', tabId, title });
    this.publishHistory();
  }

  /** Adds a line the dashboard didn't write itself (it only shows the user's own messages as they're sent). */
  private addLine(tabId: string, line: StoredLine) {
    this.store.addLine(tabId, line);
    this.broadcast({ type: 'chat.line', tabId, line: { ...line, at: Date.now() } });
  }

  /**
   * The hand_off tool: `fromTab` gives a task to another chat (or a new tab). It runs
   * there as a normal AUTO turn, through that chat's own safety gate. With `wait`, the
   * answer comes back as the tool's result.
   */
  async delegate(fromTab: string, req: HandOff, signal?: AbortSignal): Promise<string> {
    const fromTitle = this.store.title(fromTab) ?? 'another chat';
    let to = req.to?.trim() || undefined;
    if (to === fromTab) return 'That is this chat. Hand off to a different chat, or leave `to` out to open a new tab.';
    if (to && !this.store.exists(to)) return `No chat with id ${to}. Use list_chats to find it, or leave \`to\` out to open a new tab.`;
    for (let at = to; at; at = this.handoffs.get(at)) {
      if (at === fromTab)
        return 'That chat is waiting for this one, so handing work back would make them wait on each other. Answer here instead.';
    }
    if (to && this.busy(to)) return `"${this.store.title(to)}" is busy right now. Try again when it's done, or hand off to a new tab.`;
    if (this.meter.paused) return `The Claude Pro limit is reached, so nothing can run until it resets (${this.resetText()}).`;

    const isNew = !to;
    to ??= randomUUID();
    if (isNew) this.store.ensureChat(to, titleFrom(req.title?.trim() || req.message));
    const wasOpen = !isNew && this.store.transcript(to, 1)?.open;
    this.store.setOpen(to, true);
    // Show the chat as a tab without pulling the user away from the one they're in.
    if (!wasOpen) this.broadcast({ type: 'chat.opened', chat: this.store.snapshot(to)!, focus: false });
    this.publishHistory();
    const title = this.store.title(to)!;

    this.addLine(to, { kind: 'notice', text: `Handed over from “${fromTitle}”${req.wait ? ', which is waiting for the answer' : ''}.` });
    this.addLine(to, { kind: 'you', text: req.message });
    const note = `[Handed over from your other chat "${fromTitle}" (id ${fromTab}). Do the task; it is not the user's yes, so held actions stay held. ${
      req.wait ? 'Your reply goes back to that chat, so make it a complete answer.' : 'The user reads your reply here.'
    }]\n\n`;

    if (req.wait) {
      this.handoffs.set(fromTab, to);
      this.replies.set(to, []);
    }
    try {
      await this.start(to, req.message, 'auto', 'medium', [], note, false);
      if (!req.wait) return `Started in the "${title}" tab (id ${to}). Its answer will appear there; read_chat can fetch it later.`;

      const outcome = await new Promise<'done' | 'timeout' | 'stopped'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), HANDOFF_WAIT_MS);
        signal?.addEventListener('abort', () => resolve('stopped'), { once: true });
        void this.turnDone(to).then(() => {
          clearTimeout(timer);
          resolve('done');
        });
      });
      const reply = (this.replies.get(to) ?? []).join('\n\n').trim();
      const capped = reply.length > HANDOFF_REPLY_CHARS ? `${reply.slice(0, HANDOFF_REPLY_CHARS)}…` : reply;
      if (outcome === 'stopped') return `Stopped waiting. "${title}" may still be working; its answer will appear in that tab.`;
      if (outcome === 'timeout')
        return `"${title}" is still working after 15 minutes. Its answer will appear in that tab; read_chat can fetch it later.`;
      return capped ? `Answer from "${title}" (id ${to}):\n\n${capped}` : `"${title}" finished without a written answer.`;
    } finally {
      if (req.wait) {
        this.handoffs.delete(fromTab);
        this.replies.delete(to);
      }
    }
  }

  /**
   * Routes a message and runs it. `note` goes in front of what Claude sees (not the chat log or the router).
   * `fromUser` false: Harv wrote the message (a hand-off from another chat), so the gate counts
   * nothing in it as the user asking (sending, desktop, overrides).
   */
  private async start(
    tabId: string,
    message: string,
    choice: ModelChoice,
    effort: EffortLevel,
    files: Attachment[],
    note = '',
    fromUser = true,
  ) {
    // A chat that just changed project starts a new session: it gets the conversation so far as context.
    const once = this.notes.get(tabId);
    const spoken = !!once?.startsWith(SPOKEN_NOTE);
    if (once) {
      this.notes.delete(tabId);
      note = once + note;
    }
    note = dayNote(this.sessions.get(tabId), spoken) + note;
    // Near the end of the session: a warning, and past the stop mark this turn already knows (no stop note mid-reply).
    const session = this.meter.sessionMeter();
    const budget = sessionNote(session);
    if (budget) {
      note = budget + note;
      if (session && stopNote(session)) this.stopTold.add(`${tabId}:${windowOf(session)}`);
    }
    const carried = this.carry.get(tabId);
    const stale = this.store.takeStale(tabId);
    if (carried) {
      this.carry.delete(tabId);
      note = carried + note;
    } else if (stale) {
      // The chat went on on the user's other device, which this device's Claude session never saw.
      const lines = this.store.snapshot(tabId)?.lines ?? [];
      if (lines.at(-1)?.kind === 'you') lines.pop();
      if (lines.length) {
        note = `[This chat continued on the user's other device, so this is a new session here. The conversation so far, for context:]\n${carryTranscript(lines)}\n[End of the earlier conversation.]\n\n${note}`;
      }
    }
    let decision: RouteDecision;
    let text: string;
    /** The memory notes the classifier named for a new task (agent/memory.ts); the words themselves are matched too. */
    let picked: string[] | undefined;
    // A reply to actions held for the user's yes stays on the task's model (a "yes" isn't small talk for Haiku).
    const answersHeld = fromUser && this.gate.heldCount(tabId) > 0;
    // "thinking" from routing until the session has the message, so the status pill doesn't blink idle in between.
    this.setRouting(tabId, true);
    this.stopped.delete(tabId);
    try {
      // The sending check (persona rule 19), desktop control and the held actions read what the user said this turn.
      // Harv's last words: a yes to a question he asked in plain words is the user's request (safety/judge.ts).
      const asked = fromUser ? (this.store.snapshot(tabId)?.lines ?? []).findLast((l) => l.kind === 'harv')?.text : undefined;
      const scheduled = this.scheduledTexts.delete(message);
      note = (await this.gate.setTurn(tabId, fromUser ? message : '', fromUser, asked, scheduled)) + note;
      if (fromUser) note = this.router.tries(tabId, message) + note;
      const last = answersHeld ? (this.lastRun.get(tabId) ?? this.lastTagged(tabId)) : undefined;
      if (choice === 'auto' && last) {
        text = message;
        decision = { model: last.model, effort: last.effort, source: 'followup', reason: 'your answer to what was held' };
        this.router.manual(tabId, decision);
      } else if (choice === 'auto') {
        // A chat still called by its first message (or "Phone") has no name worth keeping yet: the classifier names it fresh.
        const current = this.store.title(tabId);
        const locked = this.store.titleLocked(tabId);
        const named = current && (locked || !unnamed(current)) ? current : undefined;
        const routed = await this.router.route(tabId, message, files, named, {
          project: !!this.store.projectOf(tabId),
          recent: this.recentForRouter(tabId),
          spoken,
          summary: this.store.summary(tabId),
        });
        ({ decision, text } = routed);
        // The new task fits a skill: Harv loads it first (the user, 2026-11-19: skills used when they're needed).
        if (routed.skill) note = skillNote(routed.skill) + note;
        picked = routed.memories;
        if (routed.title || routed.summary) this.autoName(tabId, routed);
        // Quick rules and spoken turns skip the classifier, so such chats kept their first message as a name
        // (Siri chats all stayed "Phone", 2026-11-14; "check the 3 new files in doownloads if …", 2026-11-20):
        // one cheap naming call on the side while the chat has no name, the answer doesn't wait for it.
        else if (!named && !locked)
          void this.router.name(parseOverride(message).text, files, this.store.summary(tabId)).then((named) => this.autoName(tabId, named));
      } else {
        // `/opus`-style words work in manual mode too, for one message.
        const override = parseOverride(message);
        text = override.text;
        decision =
          override.model || override.effort
            ? { model: override.model ?? choice, effort: override.effort ?? effort, source: 'override', reason: 'you asked for it' }
            : { model: choice, effort, source: 'manual', reason: 'your pick' };
        this.router.manual(tabId, decision);
      }
      if (this.stopped.delete(tabId)) {
        this.emit({ type: 'chat.done', tabId, ok: false, stopped: true });
        return;
      }
      decision = this.avoidFullModel(tabId, decision);
      await this.run(tabId, decision, choice === 'auto', files.length ? buildContent(tabId, note + text, files) : note + text, false, {
        text,
        picked,
      });
    } finally {
      this.setRouting(tabId, false);
    }
  }

  /** Models whose full weekly meter was already mentioned (said once per model until it's free again). */
  private toldFull = new Set<string>();

  /**
   * A model with its own full weekly meter can't answer, but the others can (the full review, D15): the
   * turn runs on the nearest other model, and the chat is told once.
   */
  private avoidFullModel(tabId: string, decision: RouteDecision): RouteDecision {
    const full = this.meter.fullModels();
    for (const model of [...this.toldFull]) if (!full.some((f) => f.model === model)) this.toldFull.delete(model);
    const hit = full.find((f) => f.model === decision.model);
    if (!hit) return decision;
    const order: Record<string, string[]> = {
      fable: ['opus', 'sonnet'],
      opus: ['sonnet', 'fable'],
      sonnet: ['opus', 'haiku'],
      haiku: ['sonnet', 'opus'],
    };
    const model = (order[decision.model] ?? ['sonnet']).find((m) => !full.some((f) => f.model === m));
    if (!model) return decision;
    const effort: EffortLevel = model !== 'opus' && model !== 'fable' && decision.effort === 'xhigh' ? 'high' : decision.effort;
    if (!this.toldFull.has(hit.model)) {
      this.toldFull.add(hit.model);
      const until = hit.resetsAt
        ? ` until ${new Date(hit.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
        : '';
      const name = `${hit.model[0]!.toUpperCase()}${hit.model.slice(1)}`;
      this.broadcast({
        type: 'chat.notice',
        tabId,
        message: hit.credits
          ? `${name} needs paid usage credits, which aren't part of your plan, so replies use ${model} instead.`
          : `${name}'s own weekly limit is full${until}, so replies use ${model} meanwhile. The other models are fine.`,
      });
    }
    const why = hit.credits ? `${decision.model} needs paid credits` : `${decision.model}'s weekly limit is full`;
    return { ...decision, model: model as RouteDecision['model'], effort, reason: why };
  }

  /**
   * The last few lines before the message being routed (it's already the chat's last line),
   * cut short, so the classifier sees what a "now do that" refers to without costing much.
   */
  private recentForRouter(tabId: string): string | undefined {
    const lines = (this.store.snapshot(tabId)?.lines ?? []).filter((l) => l.kind === 'you' || l.kind === 'harv');
    if (lines.at(-1)?.kind === 'you') lines.pop();
    const recent = lines.slice(-4).map((l) => {
      const text = l.text.replace(/\s+/g, ' ').trim();
      return `${l.kind === 'you' ? 'User' : 'Harv'}: ${text.length > 220 ? `${text.slice(0, 219)}…` : text}`;
    });
    return recent.length ? recent.join('\n') : undefined;
  }

  /** "Try harder": the last message again, one step up the ladder. */
  /** The user's last own message in a chat (what a retried or continued turn is about). */
  private lastAsked(tabId: string): string {
    return (this.store.snapshot(tabId)?.lines ?? []).findLast((l) => l.kind === 'you' && l.text !== 'Try harder.')?.text ?? '';
  }

  async harder(tabId: string): Promise<void> {
    if (!this.store.exists(tabId)) return;
    if (this.busy(tabId)) {
      this.broadcast({ type: 'chat.notice', tabId, message: 'Harv is still answering in this tab. Wait, or press Stop.' });
      return;
    }
    const from = this.lastRun.get(tabId) ?? this.lastTagged(tabId);
    if (!from || this.meter.paused)
      return this.refuse(tabId, this.meter.paused ? `Claude Pro limit reached. Try again ${this.resetText()}.` : undefined);
    const decision = this.router.harder(tabId, from);
    if (!decision) return this.refuse(tabId, 'Already at the top of the ladder, so there’s no harder to try.');
    this.gate.resumeTurn(tabId, this.lastAsked(tabId));
    this.store.addLine(tabId, { kind: 'you', text: 'Try harder.' });
    await this.run(tabId, decision, true, HARDER_PROMPT);
  }

  /** The model·effort of a chat's last reply, from its saved tag (after a restart). */
  private lastTagged(tabId: string): { model: string; effort: EffortLevel } | undefined {
    return lastTaggedRun(this.store.snapshot(tabId)?.lines ?? []);
  }

  /** The model·effort the chat last ran at (this run, else its saved tag, else AUTO's fallback). */
  private lastPick(tabId: string): { model: string; effort: EffortLevel } {
    return this.lastRun.get(tabId) ?? this.lastTagged(tabId) ?? AUTO_FALLBACK;
  }

  /** A turn the router doesn't pick: it runs at the chat's last model·effort and is logged as such. */
  private manualTurn(tabId: string, source: RouteDecision['source'], reason: string): RouteDecision {
    const { model, effort } = this.lastPick(tabId);
    const decision: RouteDecision = { model, effort, source, reason };
    this.router.manual(tabId, decision);
    return decision;
  }

  /** A message that won't run: an optional line saying why, and the end of the thinking line the dashboard shows on send. */
  private refuse(tabId: string, message?: string) {
    if (message) this.emit({ type: 'chat.notice', tabId, message });
    this.broadcast({ type: 'chat.done', tabId, ok: true, stopped: false });
  }

  private busy(tabId: string): boolean {
    return this.routing.has(tabId) || !!this.sessions.get(tabId)?.busy;
  }

  /** Shows "thinking" while the router's classifier runs. */
  private routing = new Set<string>();
  /** Each tab's running reply: whether AUTO may step it up, how often it did, and its pick now. */
  private stepping = new Map<string, { auto: boolean; steps: number; pick: { model: string; effort: EffortLevel } }>();
  /** Tabs whose user pressed Stop while the router was still picking: their turn never starts. */
  private stopped = new Set<string>();
  private setRouting(tabId: string, on: boolean) {
    if (on) this.routing.add(tabId);
    else this.routing.delete(tabId);
    this.onStatus(this.status);
  }

  private async run(
    tabId: string,
    decision: RouteDecision,
    auto: boolean,
    content: Parameters<ChatSession['send']>[0],
    raw = false,
    cue?: MemoryCue,
  ) {
    const { model, effort } = decision;
    const session = this.session(tabId, model, effort);
    const prev = this.lastRun.get(tabId);
    this.lastRun.set(tabId, { model, effort });
    // Claude can't see the [model·effort] tag: when the pick changes, one line tells it what runs and who chose it
    // (persona rule 23, set_model's "one model down"). Not on raw slash commands, which go to Claude Code as typed.
    if (!raw && (prev?.model !== model || prev?.effort !== effort)) {
      const note = `[This reply runs on ${model}·${effort}, picked by ${pickedBy(decision.source)}: ${decision.reason}.]\n\n`;
      content = typeof content === 'string' ? note + content : [{ type: 'text', text: note }, ...content];
    }
    // AUTO's own picks may step up if the reply struggles; the user's picks and /opus-style overrides never change.
    this.stepping.set(tabId, { auto: auto && decision.source !== 'override', steps: 0, pick: { model, effort } });
    this.emit({ type: 'chat.started', tabId, model: this.modelName(model), effort, auto, reason: decision.reason });
    try {
      const mark = await session.send(content, model, effort, raw, cue);
      if (mark) this.store.markTurn(tabId, mark);
    } catch (err) {
      this.emit({ type: 'chat.error', tabId, message: `Couldn’t send: ${(err as Error).message}` });
      this.emit({ type: 'chat.done', tabId, ok: false, stopped: false });
    }
  }

  /**
   * The reply is struggling (tests failing, tool calls failing in a row): AUTO moves it one step up the
   * ladder mid-reply, at most MAX_STEPS times and never past opus·high (docs/PLAN.md §5; the user's
   * wish 2026-10-29: quality over saving usage). The tag and its reason say so.
   */
  private async stepUp(tabId: string, why: string): Promise<void> {
    const turn = this.stepping.get(tabId);
    const session = this.sessions.get(tabId);
    if (!turn?.auto || turn.steps >= MAX_STEPS || !session?.busy) return;
    const decision = this.router.struggling(tabId, turn.pick, why);
    if (!decision) return;
    turn.steps += 1;
    turn.pick = { model: decision.model, effort: decision.effort };
    try {
      await session.retune(decision.model, decision.effort);
    } catch {
      return;
    }
    this.lastRun.set(tabId, turn.pick);
    this.emit({ type: 'chat.stepped', tabId, model: this.modelName(decision.model), effort: decision.effort, reason: decision.reason });
  }

  async stop(tabId: string): Promise<void> {
    // Pressed while AUTO is still picking the model: the turn is dropped once it's picked.
    if (this.routing.has(tabId)) this.stopped.add(tabId);
    const dropped = this.dequeueTab(tabId);
    if (dropped)
      this.emit({ type: 'chat.notice', tabId, message: `Removed ${dropped === 1 ? 'the queued message' : `${dropped} queued messages`}.` });
    this.gate.cancel(tabId);
    await this.sessions.get(tabId)?.stop();
  }

  /** Plan mode on or off for a chat (/plan, Claude's EnterPlanMode, an approved plan): the gate keeps it. */
  setPlanning(tabId: string, on: boolean): void {
    this.gate.setPlanning(tabId, on);
  }

  /** The gate changed a chat's plan mode: Claude Code's own mode follows, and the dashboard shows it. */
  planningChanged(tabId: string, on: boolean): void {
    void this.sessions
      .get(tabId)
      ?.setPlanning(on)
      .catch(() => {});
    this.broadcast({ type: 'chat.plan', tabId, on });
    if (this.store.exists(tabId))
      this.emit({
        type: 'chat.notice',
        tabId,
        message: on ? 'Plan mode: Harv only reads and plans, then shows you the plan to approve.' : 'Plan mode off.',
      });
  }

  /**
   * Rewind (Claude Code's /rewind, docs/PLAN.md §6s C3): the files Claude changed and the
   * conversation go back to before one of the user's messages; it and everything after it
   * leave the chat, and its text goes back into the input.
   */
  async rewind(tabId: string, fromEnd: number): Promise<void> {
    if (!this.store.exists(tabId)) return;
    if (this.busy(tabId)) {
      this.broadcast({ type: 'chat.notice', tabId, message: 'Harv is still answering in this tab. Stop it first, then rewind.' });
      return;
    }
    const target = this.store.rewindTarget(tabId, fromEnd);
    if (!target) return;
    // Work waiting for a plan reset (a queued message, a "continue") comes after the line going back: it goes too.
    this.dequeueTab(tabId);
    const sessionId = this.store.getSession(tabId);
    let files: string;
    if (target.uuid && target.session && target.session === sessionId) {
      try {
        const last = this.lastPick(tabId);
        const result = await this.session(tabId, last.model, last.effort).rewindFiles(target.uuid);
        const changed = result.filesChanged ?? [];
        files = !result.canRewind
          ? `Files weren’t put back: ${result.error ?? 'there’s no checkpoint for that message'}.`
          : changed.length
            ? `Put back ${changed.length === 1 ? changed[0] : `${changed.length} files`}.`
            : 'No files to put back.';
      } catch (err) {
        files = `Files weren’t put back: ${(err as Error).message}.`;
      }
      this.dropSession(tabId);
      if (target.forkAt) {
        this.forkAt.set(tabId, target.forkAt);
        this.store.setChainEnd(tabId, target.forkAt);
      } else {
        this.store.setSession(tabId, null);
      }
    } else {
      // From an earlier Claude session (/fresh, a project switch, an older chat): the chat goes back, and
      // the next message starts a new session with the chat so far. Files can't be put back from there.
      this.dropSession(tabId);
      this.store.setSession(tabId, null);
      this.store.markStale(tabId);
      files =
        target.session === 'remote'
          ? 'Only the chat went back: that message was sent on your other device, so its file changes are there, not on this one.'
          : target.uuid
            ? 'Only the chat went back: that message was in an earlier Claude session (before a /fresh or a project switch), so the files Harv changed since then stay as they are (each change still has its own Undo).'
            : 'Only the chat went back: that message is from before rewind existed, so the files Harv changed since then stay as they are (each change still has its own Undo).';
    }
    this.store.rewindFrom(tabId, target.line);
    this.router.forget(tabId);
    this.dropHeld(tabId, 'the chat was rewound');
    const chat = this.store.snapshot(tabId);
    if (chat)
      this.broadcast({ type: 'chat.rewound', tabId, chat, text: target.text, ...(target.files.length ? { files: target.files } : {}) });
    const quoted = target.text.length > 50 ? `${target.text.slice(0, 49)}…` : target.text;
    this.emit({ type: 'chat.notice', tabId, message: `Rewound to before “${quoted}”. ${files}` });
    this.publishHistory();
  }

  /** Stops one background task of a chat (the strip's ■), leaving the reply running. */
  async stopTask(tabId: string, taskId: string): Promise<void> {
    await this.sessions.get(tabId)?.stopTask(taskId);
  }

  /** A line from Harv itself (e.g. an Undo result) in a chat's log. */
  notice(tabId: string, message: string): void {
    if (this.store.exists(tabId)) this.emit({ type: 'chat.notice', tabId, message });
  }

  /** Harv's overall status changed outside a session (an approval arrived or was answered). */
  refreshStatus(): void {
    this.onStatus(this.status);
  }

  /** Closing a tab keeps the chat in history; its Claude session can be resumed later. */
  close(tabId: string): void {
    this.teardown(tabId, false);
    if (this.store.exists(tabId)) {
      // A chat without messages (a renamed tool tab, an untouched project chat) isn't worth keeping.
      if (this.store.snapshot(tabId)?.lines.length) this.store.setOpen(tabId, false);
      else this.store.delete(tabId);
      this.publishHistory();
    }
    // Every window drops the tab, not only the one that closed it (the app and a browser tab side by side).
    this.broadcast({ type: 'chat.removed', tabId });
    this.onStatus(this.status);
  }

  open(tabId: string): void {
    const chat = this.store.snapshot(tabId);
    if (!chat) return;
    this.store.setOpen(tabId, true);
    // Without focus: only the window that asked switches to it (it knows), not the phone or the other app (the full review, U28).
    this.broadcast({ type: 'chat.opened', chat, focus: false });
    this.publishHistory();
  }

  delete(tabId: string): void {
    this.teardown(tabId, true);
    this.store.delete(tabId);
    this.schedules?.dropChat(tabId);
    this.onDeleted?.(tabId);
    this.broadcast({ type: 'chat.removed', tabId });
    this.publishHistory();
    this.onStatus(this.status);
  }

  /** A chat the server starts by itself (the phone chat): made if new and open as a tab, without taking the focus. */
  ensureOpen(tabId: string, title: string): void {
    const known = this.store.exists(tabId);
    // Asked before ensureChat: a chat it makes is already open, and the dashboards must still hear of it.
    const wasOpen = this.store.openChats().some((c) => c.id === tabId);
    this.store.ensureChat(tabId, title);
    if (!wasOpen) {
      this.store.setOpen(tabId, true);
      const chat = this.store.snapshot(tabId);
      if (chat) this.broadcast({ type: 'chat.opened', chat, focus: false });
    }
    if (!known) this.publishHistory();
  }

  /**
   * A scheduled task is due (docs/PLAN.md §6s C4): a turn in the chat that made it, reopened
   * if it was closed (a new one if it's gone), on AUTO. Queued like any message if the chat is busy.
   */
  async runScheduled(task: { tabId: string; title: string; prompt: string }, late: boolean): Promise<void> {
    const { tabId } = task;
    this.ensureOpen(tabId, task.title);
    const when = late ? ', late: it was due while Harv was off' : '';
    const message = `${SCHEDULED_TAG}${task.title}"${when}] ${task.prompt}`;
    // The gate reads this turn as unattended because the scheduler made it (setTurn), not by its text.
    this.scheduledTexts.add(message);
    // Busy: it waits its turn like a typed message (and shows when it runs).
    if (this.busy(tabId) || this.followUps.get(tabId)?.length) return this.send(tabId, message, 'auto', 'high');
    // No dashboard typed it, so the line goes out to them too.
    this.addLine(tabId, { kind: 'you', text: message });
    await this.begin(tabId, message, 'auto', 'high', [], false);
  }

  // ── Project mode (docs/PLAN.md §6f) ──

  /**
   * What every chat loads changed (desktop control on or off): each session ends, after its reply
   * if it's busy, and the next message resumes the same conversation with the new setup.
   */
  reloadSessions(): void {
    for (const tabId of [...this.sessions.keys()]) {
      if (this.busy(tabId)) this.switchAfterTurn.add(tabId);
      else this.dropSession(tabId);
    }
  }

  /**
   * A tab goes away (closed, deleted here, or deleted on the other device): its queue, commands,
   * held actions and session end. `gone`: the chat itself is gone, so its router, gate and
   * attachment state go too. Queued messages are dropped before the session, so none are handed back.
   */
  private teardown(tabId: string, gone: boolean) {
    this.dequeueTab(tabId);
    this.followUps.delete(tabId);
    this.commands.delete(tabId);
    this.gate.cancel(tabId);
    this.dropSession(tabId);
    if (!gone) return;
    this.gate.forget(tabId);
    this.router.forget(tabId);
    this.lastRun.delete(tabId);
    deleteAttachments(tabId);
  }

  private dropSession(tabId: string) {
    this.sessions.get(tabId)?.close();
    this.sessions.delete(tabId);
    this.unhand(tabId);
  }

  /** After a project chat's turn: its code map catches up with what the turn changed (no model; skipped when nothing did). */
  private refreshMap(tabId: string): void {
    const project = this.store.projectOf(tabId);
    if (project) setTimeout(() => void refreshCodeMap(project.path, project.name), 3000).unref?.();
  }

  /** The turn that changed a chat's project has ended: its old session goes. */
  turnEnded(tabId: string): void {
    if (!this.switchAfterTurn.delete(tabId)) return;
    this.dropping.add(tabId);
    setTimeout(() => {
      if (this.dropping.delete(tabId)) this.dropSession(tabId);
    }, 0);
  }

  /**
   * Binds a chat to a project (or back to a plain assistant chat with null). A Claude
   * session can't move folders, so the next message starts a new one, with the
   * conversation so far as context. Returns an error message, if any.
   */
  setProject(tabId: string, projectId: string | null): string | undefined {
    const project = this.store.project(projectId);
    if (projectId && !project) return 'There is no such project.';
    this.store.ensureChat(tabId, 'New chat');
    this.store.setOpen(tabId, true);
    if ((this.store.projectOf(tabId)?.id ?? null) === (project?.id ?? null)) return undefined;
    this.store.setProject(tabId, project?.id ?? null);
    const lines = this.store.snapshot(tabId)?.lines ?? [];
    if (lines.length) {
      const what = project ? `moved into the project "${project.name}" (${project.path})` : 'left project mode';
      const earlier = carryTranscript(lines);
      this.carry.set(
        tabId,
        `[This chat just ${what}. The conversation so far, for context:]\n${earlier}\n[End of the earlier conversation.]\n\n`,
      );
    }
    this.store.setSession(tabId, null);
    if (this.busy(tabId)) this.switchAfterTurn.add(tabId);
    else this.dropSession(tabId);
    if (project) void this.projects.pullOnOpen(project.id);
    this.broadcast({ type: 'chat.project', tabId, projectId: project?.id ?? null });
    this.publishHistory();
    return undefined;
  }

  /** Adds an existing folder as a project. */
  addProject(path: string, name?: string): string | undefined {
    return this.projects.addProject(path, name);
  }

  removeProject(id: string): void {
    this.projects.removeProject(id);
  }

  /** Makes a new project's GitHub repo and returns its remote; replaced in tests. */
  get createRepo() {
    return this.projects.createRepo;
  }
  set createRepo(make: ProjectLink['createRepo']) {
    this.projects.createRepo = make;
  }
  /** Harv's start_project / open_project / list_projects tools. */
  private get projectTools(): ProjectTools {
    return this.projects.tools;
  }

  /** Shuts down the live Claude sessions; chats stay saved and open for next time. */
  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
