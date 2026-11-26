import { SAY_FIRST_TAG } from './sayFirst.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { HookJSONOutput, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalRequest, QuestionItem, SafetyServerMessage } from '@harv/shared';
import type { ActionStore, HeldRow } from '../store/actions.ts';
import { createBackup, readBackup, restoreBackup, type Backup } from './backup.ts';
import {
  AGENT_TOOLS,
  askedToSend,
  backupTargets,
  classify,
  FILE_WRITE_TOOLS,
  FORMAT_DRIVE,
  isSending,
  READ_TOOLS,
  DISK_WIPE,
  runningText,
  SHELL_TOOLS,
  startedLines,
  TERMINAL_RUN,
  type ClassifyContext,
  type Verdict,
} from './classify.ts';
import { IS_WINDOWS } from '../platform.ts';
import {
  actsOnDesktop,
  askedForRisk,
  contains,
  desktopRisk,
  typesUnseen,
  isDesktopTool,
  namesAMonitor,
  parseSnapshot,
  pointsOf,
  responseText,
  type DesktopElement,
  type WorkArea,
} from './desktop.ts';
import { fullPath, isInside, loadSettings, PLANS_DIR } from './paths.ts';
import { askedOutright, judgeReply, type ReplyVerdict } from './judge.ts';
import { isMyComputer, refreshIfStale } from './myComputers.ts';
import { refreshDisks } from './disks.ts';
import { coverage } from './coverage.ts';
import { BROWSER_TOOLS } from './browser.ts';
import { browserRisk, typedInto } from './browserRisk.ts';
import type { BrowserElement } from '../tools/browserRefs.ts';

/** Harv's own tools that only look or note things: fine in plan mode. */
const PLAN_SAFE_HARV = [
  'remember',
  'recall',
  'forget',
  'list_chats',
  'read_chat',
  'list_projects',
  'project_status',
  'harv_db',
  'list_scheduled',
  'terminal_read',
  'browser_open',
  'browser_snapshot',
  'browser_scroll',
  'browser_back',
  'browser_close',
  'browser_tabs',
  'browser_switch',
].map((t) => `mcp__harv__${t}`);

// Every tool call passes through here (Agent SDK hooks, so it can't be skipped):
//   green   → run
//   yellow  → back up, run, verify, log with Undo
//   red     → back up, run, verify, log with Undo; with `ask`, held in the chat for the user's yes
//   blocked → refuse with the reason (the three hard stops)

export interface GateHooks {
  broadcast: (msg: SafetyServerMessage) => void;
  /** A line in the chat tab (stored in its history). */
  notice: (tabId: string, message: string) => void;
  /** The number of waiting approvals changed (Harv's status shows "waiting"). */
  onChange: () => void;
  /** The project folder a chat works in (project mode trusts it), if any. */
  projectOf?: (tabId: string) => string | undefined;
  /** Every registered project folder: trusted from any chat, not only project chats. */
  projects?: () => string[];
  /** Files and folders on the PC the user attached to a chat: trusted in that chat. */
  attachedOf?: (tabId: string) => string[];
  /** A chat went into plan mode (Claude's EnterPlanMode, /plan) or out of it (the user approved the plan). */
  onPlanMode?: (tabId: string, on: boolean) => void;
  /** The monitor desktop control works on (docs/PLAN.md §6t item 1), when there's one to keep to. */
  desktopArea?: () => WorkArea | null;
  /**
   * Desktop control is about to act: the user's input up to `at` (ms; their message or their Approve
   * click in Harv's window) isn't them taking the desktop back (windows_mcp_quiet.py forgives it).
   */
  desktopGrant?: (at: number) => void;
  /**
   * An App launch/switch is about to run: the window it opens or brings up goes onto this monitor
   * (windows_mcp_quiet.py), or stays where it opens with null (one monitor, or the message named another).
   */
  desktopPin?: (area: WorkArea | null) => void;
}

type Decision = {
  approve: boolean;
  why?: string;
  answers?: Record<string, string>;
};

const allow = (updatedInput?: Record<string, unknown>): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', ...(updatedInput ? { updatedInput } : {}) },
});

/** Claude's questions from an AskUserQuestion call, cleaned (the card shows only what's well-formed). */
function questionsOf(input: Record<string, unknown>): QuestionItem[] {
  const raw = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
  return raw
    .filter((q) => q && typeof q.question === 'string')
    .map((q) => ({
      question: String(q.question),
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [])
        .filter((o) => o && typeof o.label === 'string')
        .map((o) => ({
          label: String(o.label),
          description: typeof o.description === 'string' ? o.description : '',
          ...(typeof o.preview === 'string' ? { preview: o.preview } : {}),
        })),
    }));
}

/** The plan an ExitPlanMode call presents: in its input, or in the plan file Claude Code wrote. */
function planOf(input: Record<string, unknown>): string {
  if (typeof input.plan === 'string' && input.plan.trim()) return input.plan.trim();
  const file = typeof input.planFilePath === 'string' ? input.planFilePath : '';
  try {
    return file && existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

const MAX_RESULT = 300;

/** How many of the user's last messages the judge reads for the job a step belongs to. */
const RECENT_ASKS = 8;

/** ssh never reached the other computer: nothing ran there. */
const CONNECTION_FAILED =
  /connection (reset|closed|refused|timed out)|kex_exchange_identification|could not resolve hostname|no route to host|exit code 255\b/i;

function describeSize(path: string): string {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return 'does not exist';
  if (!st.isDirectory()) return st.size < 1024 ? `file, ${st.size} B` : `file, ${Math.round(st.size / 1024)} KB`;
  return 'folder';
}

/** Exactly what an action will touch: the held line and the action log show it. */
function buildPreview(tool: string, input: Record<string, unknown>, verdict: Verdict): string {
  const lines: string[] = [];
  if (SHELL_TOOLS.includes(tool)) {
    lines.push(`${tool === 'PowerShell' || (tool === TERMINAL_RUN && IS_WINDOWS) ? 'PS>' : '$'} ${String(input.command ?? '')}`);
  } else if (tool === 'Write') {
    const content = String(input.content ?? '');
    lines.push(`write ${String(input.file_path)} (${content.length} characters):`, ...content.split(/\r?\n/).slice(0, 15));
  } else if (tool === 'Edit') {
    const cut = (s: unknown) =>
      String(s ?? '')
        .split(/\r?\n/)
        .slice(0, 8);
    lines.push(
      `edit ${String(input.file_path)}:`,
      ...cut(input.old_string).map((l) => `- ${l}`),
      ...cut(input.new_string).map((l) => `+ ${l}`),
    );
  }
  if (verdict.targets.length) {
    lines.push('', 'Affects:', ...verdict.targets.map((p) => `  ${p} (${describeSize(p)})`));
  }
  const protectedCount = loadSettings().protectedPaths.length;
  lines.push(
    '',
    protectedCount ? `Checked against your ${protectedCount} read-only folder(s): none touched.` : 'No read-only folders set.',
  );
  return lines.join('\n');
}

/** What Harv is told when Stop cancels a waiting approval (it once read these as refusals and gave up). */
const STOPPED =
  'The user pressed Stop, which interrupts the whole reply. It is not a refusal of this action: if they then ask you to continue, you may run it again.';

type HeldItem = HeldRow;

/** What makes a call "the same one again": the command, the file, or (desktop, connectors) the tool and what it does. */
function keyOf(tool: string, input: Record<string, unknown>, verdict: Verdict): string {
  if (SHELL_TOOLS.includes(tool))
    return `${tool}:${String(input.command ?? '')
      .replace(/\s+/g, ' ')
      .trim()}`;
  if (FILE_WRITE_TOOLS.includes(tool)) {
    // The path and a short hash of what goes in: a yes to one change of a file isn't a yes to any change of it (the full review, S15).
    const body = JSON.stringify([input.content, input.old_string, input.new_string, input.edits, input.new_source, input.replace_all]);
    return `${tool}:${String(input.file_path ?? input.notebook_path ?? '')}#${createHash('sha256').update(body).digest('hex').slice(0, 12)}`;
  }
  // A connector call is the same only with the same input: a yes to one reply isn't a yes to any reply.
  if (tool.startsWith('mcp__') && !tool.startsWith('mcp__harv__')) return `${tool}:${JSON.stringify(input)}`;
  return `${tool}:${verdict.summary}`;
}

/** The action as the outright-request check reads it. */
function describe(tool: string, input: Record<string, unknown>, verdict: Verdict): string {
  const command = SHELL_TOOLS.includes(tool) ? `\nCommand: ${String(input.command ?? '')}` : '';
  return `${verdict.summary}${command}\nWhy it's risky: ${verdict.ask ?? verdict.reason}`;
}

/** A Yes / No button press counts only for the message it came with (sent right after it). */
const ANSWER_MS = 30_000;

/** Desktop control's App tool (launch, switch, resize): its window is pinned to Harv's monitor. */
const APP_TOOL = /^mcp__desktop__App$/;

/** How long the app needs to minimize Harv's window before a screenshot. */
const STEP_ASIDE_MS = 700;

/** Commands that capture the screen (Linux tools, PowerShell's CopyFromScreen, macOS). */
const SCREEN_CAPTURE =
  /(?<![\w.-])(spectacle|gnome-screenshot|scrot|grim|maim|flameshot|xwd|screencapture)\b|\bimport\s+-window\b|CopyFromScreen/i;

/** A call that takes a picture of the screen: desktop control's Screenshot / Snapshot, or a shell screenshot. */
function looksAtScreen(tool: string, input: Record<string, unknown>): boolean {
  if (isDesktopTool(tool)) return /__(Snapshot|Screenshot)$/.test(tool);
  return SHELL_TOOLS.includes(tool) && SCREEN_CAPTURE.test(String(input.command ?? ''));
}

/** When this server started: what was held before it came back from harv.db. */
const STARTED_AT = Date.now();

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/**
 * Sent back to a turn's first tool call when Harv hasn't written a word yet (the user's report note,
 * 2026-11-17: "first tell me what you're gonna do, so it's interactive and voice isn't a quiet while").
 * A prompt rule alone didn't hold (Haiku called the tool first even with it at the end of the message).
 * `StruggleWatch` ignores it (starts with this tag); the session doesn't show the call.
 */
const SAY_FIRST = `${SAY_FIRST_TAG} Not run yet: first tell the user in one short, natural sentence what you're about to do, the way a person answers a friend ("Sure, let me look.", "On it, opening Discord."), not a status report; they see it, or hear it, at once. Then make this call again.`;
/** Calls that are themselves something the user sees (a question, a plan) or Harv's own bookkeeping. */
const SAY_FIRST_FREE = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'TodoWrite', 'ToolSearch']);

export class SafetyGate {
  /** On in the running server (`index.ts`): a turn's first tool call waits for Harv's first words (`SAY_FIRST`). */
  sayFirst = false;
  /** Attended turns where Harv hasn't written a word yet ('quiet'), or was sent back once already ('nudged'). */
  private preface = new Map<string, 'quiet' | 'nudged'>();
  private pending = new Map<string, { approval: ApprovalRequest; resolve: (d: Decision) => void }>();
  /** Red calls the user approved; canUseTool double-checks against this. */
  private approved = new Set<string>();
  private backups = new Map<string, Backup>();
  /** What the user asked for in each chat's current turn: the sending check reads it. */
  private turnText = new Map<string, string>();
  /** Chats whose turn the scheduler started (unattended: held for the report). */
  private scheduledTurns = new Set<string>();
  /** Chats in plan mode: only reading and planning until the user approves the plan. */
  private planning = new Set<string>();
  /** When the user last talked to each chat (their message, a message mid-reply, an Approve click). */
  private heardAt = new Map<string, number>();
  /** Ask-first calls waiting for the user's yes in each chat (they outlive the turn; the next non-yes drops them). */
  private held = new Map<string, HeldItem[]>();
  /** What the user's last message said yes to: each key lets one matching call run, during that turn. */
  private grants = new Map<string, Set<string>>();
  /** A yes spent on a call, by its id: given back if the call never reached the other computer (a dropped ssh connection). */
  private spent = new Map<string, { tabId: string; key: string }>();
  /** Whether the chat's current turn is the user's own message (not a hand-off or a scheduled task): only then does their job cover its steps. */
  private userTurn = new Map<string, boolean>();
  /** The user's last messages in each chat, oldest first: an earlier request for a job is the yes for its steps (auto mode). */
  private recentAsks = new Map<string, string[]>();
  /** The Yes / No button the user pressed for the held steps (answerNext), until their message arrives. */
  private answers = new Map<string, { answer: 'yes' | 'no'; at: number }>();
  /** What Harv said just before the user's message: a yes to his plain-words question is a request. */
  private harvSaid = new Map<string, string>();
  /** When each chat's current and previous turns started: a held action older than the previous turn is stale. */
  private turnAt = new Map<string, { now: number; before?: number }>();
  /** The reading of the user's answer, which a held call's retry waits for. */
  private judging = new Map<string, Promise<void>>();
  /** Each chat's last desktop Snapshot: what a click or Enter would hit. */
  private desktopElements = new Map<string, DesktopElement[]>();
  /** Chats that typed into a field their last Snapshot didn't show (a click after it may be Send). */
  private typedUnseen = new Set<string>();
  /** The browser field each chat typed into last (an Enter then submits its form). */
  private lastTyped = new Map<string, BrowserElement | undefined>();
  /** Per chat: the programs Harv started and left running (newest last), so stopping them later is his own. */
  private started = new Map<string, string[]>();
  /** The chat using the desktop right now (the pill), until its reply ends or is stopped. */
  private controlling: { tabId: string; action: string; since: number; at?: [number, number] } | null = null;

  constructor(
    private actions: ActionStore,
    private hooks: GateHooks,
  ) {
    // What waited for a yes before a restart still waits (pass C, C12); a yes given before it is gone.
    this.held = actions.allHeld();
  }

  /** Keeps a chat's held list in harv.db, so a restart doesn't forget it. */
  private saveHeld(tabId: string): void {
    this.actions.setHeld(tabId, this.held.get(tabId) ?? []);
  }

  /** Every chat with something waiting for the user's yes, and how many (the "while you were away" line, the pill). */
  heldAll(): { tabId: string; count: number; since: number }[] {
    return [...this.held]
      .filter(([, xs]) => xs.length)
      .map(([tabId, xs]) => ({ tabId, count: xs.length, since: Math.min(...xs.map((x) => x.at)) }));
  }

  /** A chat was deleted: what it held goes with it. */
  forget(tabId: string): void {
    this.held.delete(tabId);
    this.grants.delete(tabId);
    this.recentAsks.delete(tabId);
    this.userTurn.delete(tabId);
    this.saveHeld(tabId);
  }

  get waiting(): number {
    return this.pending.size;
  }

  approvals(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  private publish(id: string) {
    const action = this.actions.get(id);
    if (action && action.tier !== 'green') this.hooks.broadcast({ type: 'action', action });
  }

  private async backup(
    id: string,
    wanted: string[],
    tool: string,
    input: Record<string, unknown>,
    keep: string[] = [],
  ): Promise<Backup | null> {
    // A shell command's folders are copied only when it can change them as a whole (backupTargets);
    // `keep` (a repo's .git before a history rewrite) always is.
    const command = SHELL_TOOLS.includes(tool) && typeof input.command === 'string' ? input.command : undefined;
    const targets = [...new Set([...backupTargets(wanted, command), ...keep])];
    if (targets.length === 0) return null;
    const backup = await createBackup(id, targets);
    if (backup.entries.length === 0) return backup;
    this.backups.set(id, backup);
    this.actions.update(id, { backupDir: backup.dir, backups: backup.entries.map((e) => e.original) });
    return backup;
  }

  /** Backs up before a call; the reason it failed (then the call is held), or null. */
  private async tryBackup(
    id: string,
    wanted: string[],
    tool: string,
    input: Record<string, unknown>,
    keep: string[] = [],
  ): Promise<string | null> {
    try {
      await this.backup(id, wanted, tool, input, keep);
      return null;
    } catch (e) {
      return `The backup failed (${e instanceof Error ? e.message : String(e)}), so this couldn't be undone.`;
    }
  }

  /** What a chat's calls are classified with: its project, every project, and what the user attached to it. */
  private contextOf(tabId: string): ClassifyContext {
    return {
      project: this.hooks.projectOf?.(tabId),
      projects: this.hooks.projects?.(),
      attached: this.hooks.attachedOf?.(tabId),
      started: this.started.get(tabId),
    };
  }

  /**
   * A new turn starts in a chat with this message (from the user, another chat or a scheduled task).
   * When actions are held in the chat, the user's message is read as their answer: the note says
   * what it granted or dropped, to put in front of the turn. `scheduled`: the scheduler started it
   * (nobody is there to say yes); told by how the turn began, not by its text (the full review, S26).
   */
  setTurn(tabId: string, text: string, fromUser = true, harvSaid?: string, scheduled = false): Promise<string> {
    this.turnText.set(tabId, text);
    this.userTurn.set(tabId, fromUser && !scheduled);
    if (scheduled) this.scheduledTurns.add(tabId);
    else this.scheduledTurns.delete(tabId);
    if (harvSaid?.trim()) this.harvSaid.set(tabId, harvSaid.slice(-1500));
    else this.harvSaid.delete(tabId);
    this.heardAt.set(tabId, Date.now());
    this.grants.delete(tabId);
    if (fromUser && text.trim() && !scheduled) {
      this.turnAt.set(tabId, { now: Date.now(), before: this.turnAt.get(tabId)?.now });
      this.recentAsks.set(tabId, [...(this.recentAsks.get(tabId) ?? []), text.slice(0, 600)].slice(-RECENT_ASKS));
    }
    // Someone is there: Harv says what he'll do before his first tool call (nobody to tell otherwise).
    if (this.sayFirst && fromUser && text.trim() && !scheduled) this.preface.set(tabId, 'quiet');
    else this.preface.delete(tabId);
    if (!fromUser || !text.trim() || scheduled) return Promise.resolve('');
    return this.answerHeld(tabId, text);
  }

  /**
   * A turn the user started without a new message ("Try harder", a typed /command, the "continue" after a
   * limit reset): the user is there, and their last message is what they asked for. Not read again as an
   * answer to held actions (the full review, S10: these turns counted as "nobody is here").
   */
  resumeTurn(tabId: string, text: string): void {
    this.turnText.set(tabId, text);
    if (this.sayFirst) this.preface.set(tabId, 'quiet');
    this.heardAt.set(tabId, Date.now());
  }

  /** The user added a message to the running reply (a queued message Claude took mid-reply). */
  addToTurn(tabId: string, text: string): void {
    const before = this.turnText.get(tabId);
    this.turnText.set(tabId, before === undefined ? text : `${before}\n${text}`);
    this.heardAt.set(tabId, Date.now());
    void this.answerHeld(tabId, text);
  }

  /** How many actions wait for the user's yes in this chat (the router keeps a "yes" on the task's model). */
  heldCount(tabId: string): number {
    return this.held.get(tabId)?.length ?? 0;
  }

  /** Holds an ask-first call: one plain line in the chat with exactly what waits, and Harv told how to ask. */
  private hold(
    tabId: string,
    id: string,
    at: number,
    tool: string,
    input: Record<string, unknown>,
    verdict: Verdict,
    key: string,
    why: string,
  ): HookJSONOutput {
    const items = this.held.get(tabId) ?? [];
    let item = items.find((i) => i.key === key);
    if (!item) {
      item = { n: Math.max(0, ...items.map((i) => i.n)) + 1, key, summary: verdict.summary || tool, at };
      items.push(item);
      this.held.set(tabId, items);
      this.saveHeld(tabId);
      const command = SHELL_TOOLS.includes(tool) ? String(input.command ?? '') : '';
      this.hooks.notice(tabId, `Held, waiting for your yes: #${item.n} ${item.summary}. ${why}${command ? `\n${command}` : ''}`);
    }
    this.actions.add({ id, tabId, at, tool, tier: verdict.tier, summary: verdict.summary, reason: why, status: 'blocked', input });
    this.actions.update(id, { result: `Held (#${item.n}): waiting for your yes.` });
    this.publish(id);
    if (this.unattended(tabId))
      return deny(
        `Held (#${item.n}): ${why} Nobody is here (a scheduled or background turn). Do the rest of the task and list this in your report; it stays held until the user says yes in this chat.`,
      );
    return deny(
      `Held (#${item.n}): ${why} This needs the user's yes. Don't retry it and don't do it another way. If the rest of the task doesn't depend on it, finish the rest first, then ask once at the end about everything held, in plain words with the risk. If everything depends on it, ask now. When they say yes, run this same call again unchanged.`,
    );
  }

  /** The user's message read as the answer to what's held: grants, drops, or (unclear) asks again. */
  /**
   * The user pressed Yes or No under the held steps (the user's report note, 2026-11-18): their next
   * message in this chat is that answer to every step waiting, with no reading or Haiku call. Only the
   * dashboard's own button sends it (the user's own window); it lapses after ANSWER_MS unused.
   */
  answerNext(tabId: string, answer: 'yes' | 'no'): void {
    this.answers.set(tabId, { answer, at: Date.now() });
  }

  private answerHeld(tabId: string, text: string): Promise<string> {
    const pressed = this.answers.get(tabId);
    this.answers.delete(tabId);
    const items = this.held.get(tabId);
    if (!items?.length) return Promise.resolve('');
    const list = (xs: HeldItem[]) => xs.map((i) => `#${i.n} ${i.summary}`).join('; ');
    const button = pressed && Date.now() - pressed.at < ANSWER_MS ? pressed.answer : null;
    const result = (async () => {
      // Held before Harv's last message (or before a restart): a bare "ok" may answer something else,
      // so Haiku reads it with what Harv last said (the full review, S5/D8).
      const before = this.turnAt.get(tabId)?.before;
      const fresh = items.every((i) => i.at >= (before ?? STARTED_AT));
      const v: ReplyVerdict = button
        ? button === 'yes'
          ? { kind: 'yes', items: 'all' }
          : { kind: 'no' }
        : await judgeReply(text, items, this.harvSaid.get(tabId), fresh);
      if (v.kind === 'unclear')
        return `[Still held, waiting for the user's yes: ${list(items)}. Their message didn't clearly answer it: ask once more, briefly.]\n\n`;
      this.held.delete(tabId);
      this.saveHeld(tabId);
      const chosen = v.kind === 'yes' ? items.filter((i) => (v.items === 'all' || v.items.includes(i.n)) && !v.except?.includes(i.n)) : [];
      const dropped = items.filter((i) => !chosen.includes(i));
      if (dropped.length) this.hooks.notice(tabId, `Dropped (no yes): ${list(dropped)}.`);
      if (!chosen.length)
        return `[The user didn't say yes, so these held actions are dropped: ${list(dropped)}. Don't run them; say in one line that you dropped them.]\n\n`;
      this.grants.set(tabId, new Set(chosen.map((i) => i.key)));
      return `[The user said yes to: ${list(chosen)}. Run exactly those calls again now, unchanged; nothing else was approved.${dropped.length ? ` Dropped: ${list(dropped)}; say so in one line.` : ''}]\n\n`;
    })();
    this.judging.set(
      tabId,
      result.then(() => undefined),
    );
    return result;
  }

  isPlanning(tabId: string): boolean {
    return this.planning.has(tabId);
  }

  /** Plan mode on or off (the /plan toggle, Claude's EnterPlanMode, or an approved plan). */
  setPlanning(tabId: string, on: boolean): void {
    if (on === this.planning.has(tabId)) return;
    if (on) this.planning.add(tabId);
    else this.planning.delete(tabId);
    this.hooks.onPlanMode?.(tabId, on);
  }

  /** What plan mode lets through: reading, planning, asking, and writing the plan file. */
  private planSafe(tool: string, input: Record<string, unknown>, verdict: Verdict): boolean {
    if (READ_TOOLS.includes(tool) || AGENT_TOOLS.includes(tool) || PLAN_SAFE_HARV.includes(tool)) return true;
    if (FILE_WRITE_TOOLS.includes(tool)) return isInside(fullPath(String(input.file_path ?? '')), PLANS_DIR);
    if (SHELL_TOOLS.includes(tool)) return verdict.tier === 'green';
    return (
      tool.startsWith('mcp__') && !tool.startsWith('mcp__harv__') && verdict.tier === 'green' && verdict.reason.startsWith('Only reads')
    );
  }

  /** The PreToolUse hook: never / ask (held in the chat) / run. Only format_drive, questions and plans wait here for a card. */
  /** Harv wrote words in this turn (a text delta): its tool calls go ahead. */
  spoke(tabId: string): void {
    this.preface.delete(tabId);
  }

  /** The turn's first tool call came before any words: it is sent back once to say first (the user's report, 2026-11-17). */
  saysFirst(tabId: string, tool: string): boolean {
    return this.preface.get(tabId) === 'quiet' && !SAY_FIRST_FREE.has(tool);
  }

  async preToolUse(tabId: string, tool: string, input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<HookJSONOutput> {
    if (this.preface.get(tabId) === 'quiet') {
      // Text that already arrived may still wait in the session's queue: let it be read first.
      await new Promise((r) => setTimeout(r, 30));
      if (this.saysFirst(tabId, tool)) {
        this.preface.set(tabId, 'nudged');
        return deny(SAY_FIRST);
      }
    }
    if (tool === 'AskUserQuestion') return this.askQuestions(tabId, input, id, signal);
    if (tool === 'ExitPlanMode') return this.askPlan(tabId, input, id, signal);
    if (tool === 'EnterPlanMode') {
      this.setPlanning(tabId, true);
      return allow();
    }
    const ctx = this.contextOf(tabId);
    // Which disk a wipe would hit is looked up first: the system disk is a hard stop, another one asks.
    if (SHELL_TOOLS.includes(tool) && DISK_WIPE.test(String(input.command ?? ''))) await refreshDisks();
    // The tailnet addresses of the user's own computers (ssh to 100.x… is the same computer as its name).
    if (SHELL_TOOLS.includes(tool)) await refreshIfStale(String(input.command ?? ''));
    let verdict = classify(tool, input, ctx);
    // A destructive call the backup can't cover waits for the user's yes (the full review, S4).
    const cover = tool === FORMAT_DRIVE ? null : coverage(tool, input, verdict, ctx);
    if (cover?.gap && !verdict.ask) verdict = { ...verdict, ask: cover.gap };
    const toBackUp = [...verdict.targets, ...(cover?.more ?? [])];
    if (this.planning.has(tabId) && verdict.tier !== 'blocked' && !this.planSafe(tool, input, verdict)) {
      return deny(
        `Plan mode: only reading and planning until the user approves the plan (write it in ${PLANS_DIR} and present it with ExitPlanMode).`,
      );
    }
    const at = Date.now();
    const turn = this.turnText.get(tabId) ?? '';
    // Sending to someone the user didn't ask to send to is held (persona rule 19).
    const sending = verdict.tier !== 'blocked' && isSending(tool, input) && !askedToSend(tool, input, turn, this.unattended(tabId));
    // Desktop control holds only a risky action (sending, buying, deleting, a secret field) the
    // user's message didn't ask for outright (the user's rule, 2026-11-09).
    const desktop = verdict.tier !== 'blocked' && actsOnDesktop(tool, input);
    // Harv's browser holds the same kinds (the full review, S16); a scheduled turn's own text is never the yes.
    const web = verdict.tier !== 'blocked' && BROWSER_TOOLS.includes(tool) ? browserRisk(tool, input, this.lastTyped.get(tabId)) : null;
    if (tool === 'mcp__harv__browser_type' && verdict.tier !== 'blocked') this.lastTyped.set(tabId, typedInto(input));
    if (tool === 'mcp__harv__browser_open' || tool === 'mcp__harv__browser_back' || tool === 'mcp__harv__browser_switch')
      this.lastTyped.delete(tabId);
    const seen = this.desktopElements.get(tabId) ?? [];
    const risk = (desktop ? desktopRisk(tool, input, seen, this.typedUnseen.has(tabId)) : null) ?? web;
    if (desktop && typesUnseen(tool, input, seen)) this.typedUnseen.add(tabId);
    const desktopAsks = !!risk && (this.unattended(tabId) || !askedForRisk(risk, turn));
    // Refused here although the classifier let it through: logged as blocked, with what Claude should do instead.
    const refuse = (reason: string, then: string) => {
      this.actions.add({ id, tabId, at, tool, tier: 'blocked', summary: verdict.summary, reason, status: 'blocked', input });
      this.publish(id);
      return deny(`${reason} ${then}`);
    };
    if (desktop && this.unattended(tabId)) {
      const reason = 'Nobody may be at the computer during a scheduled or background turn, so desktop control is off for it.';
      return refuse(reason, "Tell the user what you wanted to do on the desktop; they can ask for it when they're there.");
    }
    // Formatting a USB drive always shows its card (it names the drive), and never in a turn nobody may be watching.
    const erasing = tool === FORMAT_DRIVE && verdict.tier !== 'blocked';
    if (erasing && this.unattended(tabId)) {
      const reason = 'Formatting a drive needs the user there to approve it, so a scheduled or background turn never does it.';
      return refuse(reason, "Tell the user which drive you wanted to format; they can ask for it when they're there.");
    }
    // One monitor (the user's pick, else the smallest): looking is limited to it, and acting on
    // another one needs the user's message to name it ("on the left monitor").
    const area = isDesktopTool(tool) && verdict.tier !== 'blocked' ? this.hooks.desktopArea?.() : null;
    const oneMonitor = area && area.count > 1 && !namesAMonitor(turn) ? area : null;
    // Windows Harv opens land on the main monitor; the launcher moves them onto his (the user's report note, 2026-11-19).
    if (APP_TOOL.test(tool) && verdict.tier !== 'blocked') this.hooks.desktopPin?.(oneMonitor);
    let looksAt: Record<string, unknown> | undefined;
    if (oneMonitor) {
      const away = pointsOf(input).find((p) => !contains(oneMonitor, p));
      if (away) {
        return refuse(
          `(${away.join(', ')}) is on another monitor than the ${oneMonitor.label} one Harv works on.`,
          `Work on the ${oneMonitor.label} monitor (region [${oneMonitor.region.join(', ')}]): find what you need there (move a window there with App mode resize if it's elsewhere), or ask the user whether you may use the other monitor. Only their message naming it ("on the left monitor") lets you.`,
        );
      }
      if (/__(Snapshot|Screenshot)$/.test(tool) && input.region == null && input.display == null)
        looksAt = { ...input, region: oneMonitor.region };
    }
    // Ask first (the user's rules, 2026-11-11): what can't be undone, sending nobody asked for, a risky
    // desktop step. Held in the chat, not on a card: Harv finishes the rest and asks in plain words; the
    // user's yes in their next message lets exactly that call through. Their outright request is the yes.
    if (verdict.tier !== 'blocked' && !erasing && (!!verdict.ask || sending || desktopAsks)) {
      // A desktop step is "the same" by what it hits (a later Snapshot can move the point).
      const key = risk ? `${tool}:${risk.why}` : keyOf(tool, input, verdict);
      await this.judging.get(tabId);
      const askWhy = risk ? risk.why : (verdict.ask ?? verdict.reason);
      let why = '';
      // Like Claude Code's auto mode (the user, 2026-11-26): on this computer and the user's own other
      // ones, the job asked for earlier in the chat is the yes for the steps it needs. On a computer
      // that isn't theirs, only an outright request for exactly this step is.
      const own = (!verdict.remote || isMyComputer(verdict.remote)) && this.userTurn.get(tabId) !== false;
      if (this.grants.get(tabId)?.delete(key)) {
        why = 'The user said yes in the chat.';
        this.spent.set(id, { tabId, key });
      } else if (
        verdict.ask &&
        !sending &&
        !desktopAsks &&
        !this.unattended(tabId) &&
        (await askedOutright(
          own ? (this.recentAsks.get(tabId) ?? [turn]).join('\n---\n') : turn,
          describe(tool, input, verdict),
          this.harvSaid.get(tabId),
          own,
        ))
      )
        why = own ? 'The job the user asked for covers this step.' : 'The user asked for it outright.';
      if (!why) return this.hold(tabId, id, at, tool, input, verdict, key, askWhy);
      this.actions.add({
        id,
        tabId,
        at,
        tool,
        tier: verdict.tier,
        summary: verdict.summary,
        reason: verdict.reason,
        status: 'running',
        input,
      });
      this.actions.update(id, { result: cover?.gap ? `${why} Ran without a backup (the user said yes).` : why });
      // Approved only once the backup is made: a backup that fails holds the call instead.
      const failed = await this.tryBackup(id, toBackUp, tool, input, verdict.keep);
      if (failed) return this.hold(tabId, id, at, tool, input, verdict, `${key}:backup`, failed);
      this.approved.add(id);
      this.publish(id);
      if (desktop) {
        this.heardAt.set(tabId, Date.now());
        this.takeOver(tabId, verdict.summary, pointsOf(input)[0], area);
      }
      return allow(looksAt ?? verdict.rewrite);
    }
    const status = verdict.tier === 'blocked' ? 'blocked' : erasing ? 'pending' : 'running';
    this.actions.add({ id, tabId, at, tool, tier: verdict.tier, summary: verdict.summary, reason: verdict.reason, status, input });

    if (verdict.tier === 'blocked') {
      this.publish(id);
      if (verdict.route) return deny(verdict.reason);
      return deny(`${verdict.reason} Don't try another way around it.`);
    }
    if (verdict.tier === 'green') {
      if (looksAtScreen(tool, input)) await this.stepAside(tabId, area);
      else if (isDesktopTool(tool)) this.grant(tabId);
      return allow(looksAt ?? verdict.rewrite);
    }

    // Everything else runs: backed up where files change, logged with Undo (no cards since 2026-11-11).
    if (!erasing) {
      const failed = await this.tryBackup(id, toBackUp, tool, input, verdict.keep);
      if (failed) return this.hold(tabId, id, at, tool, input, verdict, keyOf(tool, input, verdict), failed);
      if (verdict.tier === 'red') {
        this.approved.add(id);
        this.actions.update(id, {
          result: cover?.rebuilt.length
            ? `Ran (backed up where it changes files; not backed up, can be rebuilt: ${cover.rebuilt.join(', ')}).`
            : 'Ran (backed up where it changes files; Undo).',
        });
      }
      this.publish(id);
      if (desktop) this.takeOver(tabId, verdict.summary, pointsOf(input)[0], area);
      else if (looksAtScreen(tool, input)) await this.stepAside(tabId, area);
      return allow();
    }

    // format_drive: its card names the drive; the user decides.
    const approval: ApprovalRequest = {
      id,
      tabId,
      at,
      tool,
      summary: verdict.summary,
      reason: verdict.reason,
      preview: buildPreview(tool, input, verdict),
      backups: [],
      backupNote: 'Everything on the drive is lost: there is no backup and no Undo.',
    };
    this.publish(id);
    const decision = await this.ask(approval, signal);
    if (!decision.approve) {
      this.actions.update(id, {
        status: 'denied',
        result: decision.why === STOPPED ? 'Stopped by the user.' : (decision.why ?? 'Denied by the user.'),
      });
      this.publish(id);
      if (decision.why && decision.why !== STOPPED)
        return deny(`The user denied this action and said: "${decision.why}". Go by that; don’t retry it unchanged.`);
      return deny(decision.why ?? 'The user denied this action. Ask what they would like instead; don’t retry it unchanged.');
    }
    this.approved.add(id);
    this.actions.update(id, { status: 'running' });
    this.publish(id);
    return allow();
  }

  /** Claude's multiple-choice questions: a question card, and the answers go back in the tool's input. */
  private async askQuestions(tabId: string, input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<HookJSONOutput> {
    const questions = questionsOf(input);
    if (!questions.length) return deny('AskUserQuestion needs at least one question with options.');
    const card: ApprovalRequest = {
      kind: 'question',
      id,
      tabId,
      at: Date.now(),
      tool: 'AskUserQuestion',
      summary: questions[0]!.question,
      reason: '',
      preview: '',
      backups: [],
      questions,
    };
    const decision = await this.ask(card, signal);
    if (decision.why === STOPPED) return deny(STOPPED);
    if (!decision.approve || !decision.answers) {
      return deny(
        decision.why
          ? `The user didn't pick an answer; they wrote: "${decision.why}". Go by that.`
          : "The user dismissed the questions without answering. Don't ask them again; go on with sensible defaults or ask in plain text.",
      );
    }
    return allow({ ...input, answers: decision.answers });
  }

  /** ExitPlanMode: the plan goes on a card; approving it ends plan mode, a note sends Claude back to revise it. */
  private async askPlan(tabId: string, input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<HookJSONOutput> {
    const card: ApprovalRequest = {
      kind: 'plan',
      id,
      tabId,
      at: Date.now(),
      tool: 'ExitPlanMode',
      summary: 'Plan ready',
      reason: '',
      preview: '',
      backups: [],
      plan: planOf(input),
    };
    const decision = await this.ask(card, signal);
    if (decision.why === STOPPED) return deny(STOPPED);
    if (decision.approve) {
      this.setPlanning(tabId, false);
      return allow();
    }
    return deny(
      decision.why
        ? `The user wants changes to the plan: "${decision.why}". Stay in plan mode, revise the plan and present it again with ExitPlanMode.`
        : "The user didn't approve the plan. Stay in plan mode and ask what they'd like changed.",
    );
  }

  private ask(approval: ApprovalRequest, signal: AbortSignal): Promise<Decision> {
    return new Promise((resolve) => {
      const finish = (d: Decision) => {
        if (!this.pending.delete(approval.id)) return;
        signal.removeEventListener('abort', onAbort);
        this.hooks.broadcast({ type: 'approval.resolved', id: approval.id, tabId: approval.tabId, approved: d.approve });
        this.hooks.onChange();
        resolve(d);
      };
      const onAbort = () => finish({ approve: false, why: STOPPED });
      this.pending.set(approval.id, { approval, resolve: finish });
      signal.addEventListener('abort', onAbort, { once: true });
      this.hooks.broadcast({ type: 'approval.request', approval });
      this.hooks.onChange();
    });
  }

  /** The user's answer from a card (a question card's `answers`; `why`: what they wrote instead). */
  answer(id: string, approve: boolean, extra: { answers?: Record<string, string>; why?: string } = {}): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const why = extra.why?.trim();
    pending.resolve({
      approve,
      ...(approve && extra.answers ? { answers: extra.answers } : {}),
      ...(why ? { why } : {}),
    });
  }

  /** The turn ended (or was stopped): unused yeses are over (held actions stay). */
  turnEnded(tabId: string): void {
    this.grants.delete(tabId);
    this.turnText.delete(tabId);
    this.desktopElements.delete(tabId);
    this.typedUnseen.delete(tabId);
    this.release(tabId);
  }

  /**
   * Harv is about to look at the screen: his own window steps aside first (the app minimizes it
   * on that monitor and brings it back when the reply ends), so the picture shows the work, not
   * Harv's chat (the File explorer chat's screenshots, 2026-11-11).
   */
  private async stepAside(tabId: string, area?: WorkArea | null): Promise<void> {
    const already = this.controlling?.tabId === tabId;
    this.takeOver(tabId, 'looking at the screen', undefined, area ?? this.hooks.desktopArea?.());
    if (!already) await new Promise((r) => setTimeout(r, STEP_ASIDE_MS));
  }

  /** Who is using the desktop now (for a dashboard that connects mid-way). */
  desktopControl(): { tabId: string; action: string; since: number; at?: [number, number] } | null {
    return this.controlling;
  }

  /** A chat's desktop action is about to run: the pill shows it (the first one of a reply starts the clock). */
  private takeOver(tabId: string, action: string, at?: [number, number], area?: WorkArea | null): void {
    const mine = this.controlling?.tabId === tabId ? this.controlling : null;
    const since = mine?.since ?? Date.now();
    // Where it acts (the pill goes to that monitor): the action's point, else where the last one was,
    // else the middle of the monitor Harv works on.
    const middle: [number, number] | undefined = area
      ? [Math.round((area.left + area.right) / 2), Math.round((area.top + area.bottom) / 2)]
      : undefined;
    const where = at ?? mine?.at ?? middle;
    this.controlling = { tabId, action, since, ...(where ? { at: where } : {}) };
    this.grant(tabId);
    this.hooks.broadcast({ type: 'desktop.control', tabId, action, since, ...(where ? { at: where } : {}) });
  }

  /**
   * Sending the message or clicking Approve was the user talking to Harv, not taking the desktop
   * back: a desktop tool starts now instead of after Windows-MCP's 10 s wait.
   */
  private grant(tabId: string): void {
    const heard = this.heardAt.get(tabId);
    if (heard) this.hooks.desktopGrant?.(heard);
  }

  /** The chat's reply ended or was stopped: it's no longer using the desktop. */
  private release(tabId: string): void {
    if (this.controlling?.tabId !== tabId) return;
    this.controlling = null;
    this.hooks.broadcast({ type: 'desktop.control', tabId, action: null });
  }

  /**
   * A turn nobody typed just now: a scheduled task, or one Claude started by itself when a
   * background task finished (it never goes through setTurn, so there's no turn text).
   */
  private unattended(tabId: string): boolean {
    return this.turnText.get(tabId) === undefined || this.scheduledTurns.has(tabId);
  }

  /** Stop: every approval waiting in this tab is denied. */
  cancel(tabId: string): void {
    this.release(tabId);
    for (const p of [...this.pending.values()]) {
      if (p.approval.tabId === tabId) p.resolve({ approve: false, why: STOPPED });
    }
  }

  /** Backstop for Claude Code's own permission prompts: never let a red call through without an approval. */
  async canUseTool(tool: string, input: Record<string, unknown>, id: string, tabId?: string): Promise<PermissionResult> {
    const verdict = classify(tool, input, tabId ? this.contextOf(tabId) : { projects: this.hooks.projects?.() });
    if (verdict.tier === 'blocked') return { behavior: 'deny', message: verdict.reason };
    if (verdict.tier === 'red' && !this.approved.has(id)) return { behavior: 'deny', message: 'This needs the user’s approval first.' };
    return { behavior: 'allow', updatedInput: input };
  }

  /** PostToolUse: verify and log. Returns a note for Claude when the call needed the user's override. */
  done(tool: string, input: Record<string, unknown>, id: string, response: unknown): string | undefined {
    let result = 'Done.';
    const tabId = this.actions.get(id)?.tabId;
    if (tabId && tool === 'mcp__desktop__Snapshot') {
      this.desktopElements.set(tabId, parseSnapshot(responseText(response)));
      this.typedUnseen.delete(tabId);
    }
    // A Screenshot, or another app in front: the last Snapshot's elements no longer say what a click
    // hits (the full review, S13: an old "Delete" held a harmless click, or a new one went through).
    else if (tabId && (tool === 'mcp__desktop__Screenshot' || tool === 'mcp__desktop__App')) {
      this.desktopElements.delete(tabId);
      if (tool === 'mcp__desktop__App') this.typedUnseen.delete(tabId);
    }
    if (FILE_WRITE_TOOLS.includes(tool)) {
      result = existsSync(String(input.file_path)) ? 'Verified: the file is in place.' : 'Warning: the file isn’t there afterwards.';
    } else if (SHELL_TOOLS.includes(tool) && response && typeof response === 'object') {
      const r = response as { stdout?: string; stderr?: string; interrupted?: boolean };
      if (r.interrupted) result = 'Interrupted.';
      else if (r.stderr?.trim()) result = `Finished with messages: ${r.stderr.trim().slice(0, MAX_RESULT)}`;
      else result = 'Finished without errors.';
    }
    if (tabId && SHELL_TOOLS.includes(tool) && typeof input.command === 'string') {
      // What this step left running (in the background, or the whole command with run_in_background).
      const shell = tool === 'PowerShell' || (tool === TERMINAL_RUN && IS_WINDOWS) ? 'powershell' : 'bash';
      const lines = startedLines(runningText(input.command, { shell }), input.run_in_background === true);
      if (lines.length) this.started.set(tabId, [...(this.started.get(tabId) ?? []), ...lines].slice(-30));
    }
    this.finish(id, 'done', result);
    return undefined;
  }

  failed(id: string, error: string, interrupted?: boolean): void {
    // The connection dropped before anything ran there: the yes still stands for the retry
    // (the debloat chat: a reset ssh needed a second yes for the same check).
    const spent = this.spent.get(id);
    if (spent && !interrupted && CONNECTION_FAILED.test(error)) {
      const grants = this.grants.get(spent.tabId) ?? new Set<string>();
      grants.add(spent.key);
      this.grants.set(spent.tabId, grants);
    }
    this.finish(id, 'failed', interrupted ? 'Stopped by the user.' : error.slice(0, MAX_RESULT));
  }

  private finish(id: string, status: 'done' | 'failed', result: string) {
    this.approved.delete(id);
    this.spent.delete(id);
    this.backups.delete(id);
    if (!this.actions.get(id)) return;
    this.actions.update(id, { status, result });
    this.publish(id);
  }

  /** Undo: put the backed-up files back (what's there now is kept aside too). */
  undo(id: string): void {
    const action = this.actions.get(id);
    const dir = this.actions.backupDir(id);
    const backup = dir ? readBackup(dir) : null;
    if (!action || !action.canUndo || !backup) {
      if (action) this.hooks.notice(action.tabId, `Can’t undo “${action.summary}”: there’s no backup for it.`);
      return;
    }
    try {
      const { restored, removed } = restoreBackup(backup);
      const parts = [
        restored.length ? `Restored ${restored.join(', ')}.` : '',
        removed.length ? `Removed ${removed.join(', ')} (kept in ${backup.dir} in case you want it back).` : '',
      ].filter(Boolean);
      this.actions.update(id, { status: 'undone', result: parts.join(' ') });
      this.hooks.notice(action.tabId, `Undone: ${action.summary}. ${parts.join(' ')}`);
    } catch (err) {
      this.hooks.notice(action.tabId, `Undo failed: ${(err as Error).message}. The backup is still in ${backup.dir}.`);
    }
    this.publish(id);
  }
}
