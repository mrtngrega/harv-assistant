import { randomUUID, type UUID } from 'node:crypto';
import { query, type Query, type SDKMessage, type SDKRateLimitInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatServerMessage, EffortLevel, SlashCommandInfo } from '@harv/shared';
import { StruggleWatch } from '../router/struggle.ts';
import type { SafetyGate } from '../safety/gate.ts';
import type { ChatStore } from '../store/chats.ts';
import type { ContentBlockParam } from './attachments.ts';
import type { Delegate } from './chatTools.ts';
import { toCommandInfo } from './commands.ts';
import { describeTool, MEMORY_TOOLS } from './guard.ts';
import { DESKTOP_SERVER, isDesktopTool } from '../safety/desktop.ts';
import { memoryChanges, memoryNote, memorySnapshot, type MemorySeen } from './memory.ts';
import { buildOptions, SUBSCRIPTION_KEY_SOURCES, todayText, type ChatContext } from './options.ts';
import { AsyncQueue } from './queue.ts';
import { killShellTree } from './killTree.ts';
import { TaskTracker } from './tasks.ts';

type Emit = (msg: ChatServerMessage) => void;

/** The quiet chat line naming the memory notes a message brought in. */
export const MEMORY_NOTICE = 'from memory: ';

/** What a turn's memory notes are picked from: the user's own words, and the notes the router's classifier named. */
export interface MemoryCue {
  text: string;
  picked?: string[];
}

export interface SessionHooks {
  onStateChange: () => void;
  /** Claude Code's session id, stored so the chat can be resumed after a restart. */
  onSessionId: (sessionId: string) => void;
  /** Resuming an old session failed before it started (e.g. its transcript is gone). */
  onResumeFailed: () => void;
  /** Live plan usage from Claude; `rejected` means a limit is hit. */
  onRateLimit: (info: SDKRateLimitInfo) => void;
  /**
   * The model needs paid usage credits (`credits_required`: Fable left the Pro plan, 2026-11-17): only that
   * model is out, never a plan-wide pause. `until`: epoch ms Claude gave, if any.
   */
  onNoCredits?: (model: string, until?: number) => void;
  /** The session's slash commands (on start, and when it finds new skills). */
  onCommands?: (commands: SlashCommandInfo[]) => void;
  /** Claude started a turn by itself (a background task it started finished): no message from the user began it. */
  onAutoTurn?: () => void;
  /** A turn ended: the last entry of the conversation so far, where a later rewind can resume. */
  onChainEnd?: (uuid: string) => void;
  /** The Claude process is gone (it crashed, quit, or was refused): this session takes no more messages. */
  onEnded?: () => void;
  /** The reply is struggling (tests failing, tool calls failing in a row): AUTO may step up mid-reply. */
  onStruggle?: (why: string) => void;
  /** The reply started a tool: a message the user queued meanwhile can go in now (docs/PLAN.md §6ac). */
  onToolUse?: () => void;
  /**
   * Claude took a message handed over with `fold`: into the running reply, or (`newTurn`) as a turn
   * of its own when the reply ended before its next step, or was stopped.
   */
  onFolded?: (id: string, newTurn: boolean) => void;
}

/** Where one of the user's messages sits in the Claude conversation, for rewinding to before it. */
interface TurnMark {
  /** The message's own uuid (file checkpoints are taken there). */
  uuid: string;
  /** The conversation's last entry before it (none: it was the session's first message). */
  forkAt?: string;
}

/** How a session starts: resumed, cut back to a point (a rewind), in plan mode. */
interface SessionStart {
  resume?: string;
  resumeAt?: string;
  /** The last entry of the conversation so far (stored), so the next message knows where it starts. */
  chainEnd?: string;
  planning?: boolean;
}

/** What a local command like /context or /usage printed (it comes back as a user message). */
const LOCAL_OUTPUT = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/g;
/** Claude Code confirming a model or effort change. */
const SETTING_CONFIRM = /^(Set model to|Set effort (level )?to|Effort (level )?set to)\b/i;
// eslint-disable-next-line no-control-regex -- terminal colour codes start with ESC
const ANSI = /\x1b\[[0-9;]*m/g;

const ERROR_TEXT: Record<string, string> = {
  rate_limit: 'Claude Pro usage limit reached. Harv will be able to continue after the limit resets.',
  authentication_failed: 'Claude Code isn’t logged in. Run `claude` in a terminal and log in with your subscription.',
  billing_error: 'Claude reported a billing problem with the subscription.',
  overloaded: 'Claude is overloaded right now. Try again in a moment.',
  model_not_found: 'That model isn’t available on your plan.',
};

/** "claude-fable-5-2" or "fable" → "fable" (the router's model names). */
export const modelFamily = (model: string) => /fable|opus|sonnet|haiku/i.exec(model)?.[0]?.toLowerCase() ?? model;
const clock = (epochSec: number) => new Date(epochSec * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * One chat tab = one long-lived Claude Code session in streaming input mode,
 * so model and effort can change between messages without losing context.
 */
export class ChatSession {
  private input = new AsyncQueue<SDKUserMessage>();
  private abort = new AbortController();
  private q: Query;
  private stopping = false;
  private closed = false;
  /** The Claude process is gone; nothing more can be sent. */
  private ended = false;
  /** Watches this reply's tool results for a struggle (AUTO's step-up mid-reply). */
  private struggle = new StruggleWatch();
  /** Harv switched model or effort for this reply (at its start or a step-up): Claude Code's "Set model to…" note isn't shown. */
  private retuned = false;
  /**
   * This turn already said the plan limit is reached: one limit event showed as five chat lines
   * (the limit event, the error, Claude Code's own text, the turn's error and a notice; the ShopNotes chat, 2026-11-10).
   */
  private limitShown = false;
  /**
   * The date this session's prompt says ("Today is …"), built once: a chat used past midnight is told
   * the new date in front of its next message (the full review, K19), and this moves on with it.
   */
  promptDay = todayText();
  /** This turn was refused for paid credits: the "limit" error that follows is not a plan limit. */
  private noCredits = false;

  /** The one "limit reached" line of a turn (the first one says it; the best one has the reset time). */
  private limitLine(message: string): void {
    if (this.limitShown) return;
    this.limitShown = true;
    this.emit({ type: 'chat.error', tabId: this.tabId, message });
  }
  private started = false;
  /** The memories this session knows about (its system prompt, plus notes since). */
  private memory = memorySnapshot();
  /** Topic notes this session already has in full or as a hint (memoryNote), so each joins only once. */
  private seenMemories: MemorySeen = { shown: new Set(), hinted: new Set() };
  private usedMemoryTool = false;
  /** Whether this turn showed any text (a slash command's only output may be its result). */
  private said = false;
  busy = false;
  toolRunning = false;
  /** Messages handed to Claude mid-reply that it hasn't taken yet (`fold`). */
  private folding = new Set<string>();
  /** The CLI reports when it takes each message (command_lifecycle): only then is handing over safe. */
  private lifecycle = false;
  /** The tool running now, for the status pill ("working · Read"). */
  toolName: string | undefined;
  /** This turn's output tokens: finished messages (exact) plus the streaming one (characters / 4). */
  private turnTokens = 0;
  private streamChars = 0;
  /**
   * Thinking tokens of the message streaming now, from the SDK's estimate. Thinking arrives
   * hidden (empty deltas), so without it the count stood still for minutes while Opus thought
   * and Harv looked stuck (the user's report, 2026-10-25). The exact count replaces it at the end.
   */
  private thinkingTokens = 0;
  /** The thinking block streaming now: its index in the message, when it started, its summary so far. */
  private thought: { index: number; at: number; text: string } | null = null;
  private progressAt = 0;
  /** What the latest API call sent: the context it had (the turn's summed usage counts the context once per call). */
  private contextIn = 0;
  /** The process's cumulative notional cost at the last result: each turn's own cost is the difference (the SDK's `total_cost_usd` adds up). */
  private costSoFar = 0;
  /** Subagents and shells this chat runs in the background, for the strip above the prompt. */
  private taskTracker = new TaskTracker();
  /** Background Bash commands by tool call (subagents' too), so stopping one can end what it started. */
  private shellCommands = new Map<string, string>();
  /** The conversation's latest entry (an assistant message or a tool result), for rewind marks. */
  private chainEnd: string | undefined;
  private resume?: string;

  constructor(
    readonly tabId: string,
    private model: string,
    private effort: EffortLevel,
    private emit: Emit,
    private hooks: SessionHooks,
    private store: ChatStore,
    private gate: SafetyGate,
    start: SessionStart = {},
    delegate?: Delegate,
    mode: Omit<ChatContext, 'store' | 'tabId' | 'gate' | 'delegate'> = {},
  ) {
    this.resume = start.resume;
    this.chainEnd = start.resumeAt ?? start.chainEnd;
    this.q = query({
      prompt: this.input,
      options: buildOptions(model, effort, this.abort, {
        resume: start.resume,
        resumeAt: start.resumeAt,
        planning: start.planning,
        chat: { store, tabId, gate, delegate, ...mode },
      }),
    });
    void this.consume();
  }

  /** Plan mode on or off: Claude Code's own plan mode, so Claude gets its planning instructions. */
  async setPlanning(on: boolean): Promise<void> {
    await this.q.setPermissionMode(on ? 'plan' : 'default');
  }

  /** Puts the files Claude changed back as they were before this message (file checkpoints). */
  async rewindFiles(uuid: string) {
    // A real rewind doesn't say which files it changed; a dry run first does.
    const preview = await this.q.rewindFiles(uuid, { dryRun: true });
    if (!preview.canRewind) return preview;
    const result = await this.q.rewindFiles(uuid);
    return { ...result, filesChanged: result.filesChanged?.length ? result.filesChanged : preview.filesChanged };
  }

  /**
   * `raw`: a slash command, sent exactly as typed (a memory note in front would stop Claude Code seeing the command).
   * Returns where the message sits in the conversation, for a later rewind.
   */
  async send(content: string | ContentBlockParam[], model: string, effort: EffortLevel, raw = false, cue?: MemoryCue): Promise<TurnMark> {
    if (this.closed || this.ended) throw new Error('this Claude session has ended');
    this.limitShown = false;
    this.noCredits = false;
    // Claude Code confirms a switch with a line ("Set model to haiku (claude-haiku-5-5)") that
    // arrives during this turn; the reply's [model·effort] tag already says it, so it's hidden.
    const switching = model !== this.model || effort !== this.effort;
    await this.switchTo(model, effort);
    this.stopping = false;
    this.struggle.reset();
    this.retuned = switching;
    this.newTurn();
    this.setBusy(true);
    const message = raw ? content : this.withMemoryNote(content, cue);
    const uuid = randomUUID();
    const mark: TurnMark = { uuid, ...(this.chainEnd ? { forkAt: this.chainEnd } : {}) };
    this.chainEnd = uuid;
    this.input.push({ type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null, uuid });
    return mark;
  }

  /**
   * A message the user typed while this reply runs, handed to Claude like Claude Code does: it goes
   * in at the reply's next step (after the running tool), or runs right after the reply. It can't be
   * taken back once handed over (the SDK has no cancel for it), so Harv hands it over only at a tool
   * step. False when it can't (no reply running, or this CLI doesn't report when it takes messages).
   */
  fold(id: UUID, content: string | ContentBlockParam[], cue?: MemoryCue): boolean {
    if (this.closed || this.ended || !this.busy || !this.lifecycle) return false;
    this.folding.add(id);
    const notes = cue && this.topicNotes(cue);
    if (notes) content = typeof content === 'string' ? `${notes}\n\n${content}` : [{ type: 'text', text: notes }, ...content];
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: id, priority: 'next' });
    return true;
  }

  /**
   * Tells Claude about memories other chats saved or forgot since this one last knew, and puts the full
   * text of the notes the router picked, or a hint for those a key word touched, in front of the message (agent/memory.ts, once each).
   */
  private withMemoryNote(content: string | ContentBlockParam[], cue?: MemoryCue): string | ContentBlockParam[] {
    const now = memorySnapshot();
    const changes = memoryChanges(this.memory, now);
    // A changed note's new text is in the change note: it counts as shown.
    for (const [name, text] of now) if (this.memory.get(name) !== text) this.seenMemories.shown.add(name);
    this.memory = now;
    const notes = [
      changes ? `[Your memory changed since this chat last saw it (another chat, or the user, edited it):\n${changes}]` : '',
      cue ? (this.topicNotes(cue) ?? '') : '',
    ].filter(Boolean);
    if (!notes.length) return content;
    const note = notes.join('\n\n');
    return typeof content === 'string' ? `${note}\n\n${content}` : [{ type: 'text', text: note }, ...content];
  }

  /**
   * The topic notes this message brings in, and one quiet line in the chat naming them (the user, 2026-11-20:
   * see it working, spot a wrong pick or a miss).
   */
  private topicNotes(cue: MemoryCue): string | null {
    const { shown, hinted } = this.seenMemories;
    const before = new Set([...shown, ...hinted]);
    const note = memoryNote(cue.text, cue.picked ?? [], this.seenMemories);
    const full = [...shown].filter((n) => !before.has(n));
    const maybe = [...hinted].filter((n) => !before.has(n));
    const parts = [full.join(', '), maybe.length ? `maybe ${maybe.join(', ')}` : ''].filter(Boolean);
    if (note && parts.length) this.emit({ type: 'chat.notice', tabId: this.tabId, message: `${MEMORY_NOTICE}${parts.join(' · ')}` });
    return note;
  }

  async stop(): Promise<void> {
    if (!this.busy) return;
    this.stopping = true;
    await this.q.interrupt();
  }

  /** Stops one background task, with everything it started; the SDK reports its end as a task_notification. */
  async stopTask(taskId: string): Promise<void> {
    const toolUse = this.taskTracker.toolUseOf(taskId);
    const command = toolUse && this.shellCommands.get(toolUse);
    if (command) await killShellTree(command);
    await this.q.stopTask(taskId);
  }

  tasks() {
    return this.taskTracker.list();
  }

  /** Switches model and effort mid-reply (AUTO stepping up): the next request of this reply uses them. */
  async retune(model: string, effort: EffortLevel): Promise<void> {
    if (this.closed || this.ended) return;
    this.retuned = true;
    await this.switchTo(model, effort);
  }

  private async switchTo(model: string, effort: EffortLevel): Promise<void> {
    if (model !== this.model) {
      await this.q.setModel(model);
      this.model = model;
    }
    if (effort !== this.effort) {
      await this.q.applyFlagSettings({ effortLevel: effort });
      this.effort = effort;
    }
  }

  /** A turn begins: nothing said yet, and the status line's token count starts from zero. */
  private newTurn() {
    this.said = false;
    this.turnTokens = 0;
    this.streamChars = 0;
    this.thinkingTokens = 0;
  }

  /**
   * Ends the session. Background shells and agents it started are stopped first: closing
   * Claude Code alone left them running (on Windows its child processes outlive it).
   */
  close(): void {
    this.closed = true;
    const running = this.taskTracker.list().filter((t) => t.status === 'running');
    const end = () => {
      this.input.end();
      this.q.close();
    };
    if (!running.length) return end();
    const stops = Promise.allSettled(running.map((t) => this.stopTask(t.id)));
    void Promise.race([stops, new Promise((r) => setTimeout(r, 5000))]).finally(end);
  }

  private say(text: string) {
    this.said = true;
    this.emit({ type: 'chat.assistant', tabId: this.tabId, text });
  }

  /** Live token count for the status line, like Claude Code's "↓ 1.2k tokens" (at most twice a second). */
  private countTokens(ev: { type: string; delta?: unknown; usage?: unknown }) {
    if (ev.type === 'content_block_delta') {
      const d = ev.delta as { text?: string; thinking?: string; partial_json?: string };
      this.streamChars += (d.text ?? d.thinking ?? d.partial_json ?? '').length;
    } else if (ev.type === 'message_delta') {
      this.turnTokens +=
        (ev.usage as { output_tokens?: number } | undefined)?.output_tokens ?? Math.ceil(this.streamChars / 4) + this.thinkingTokens;
      this.streamChars = 0;
      this.thinkingTokens = 0;
    } else {
      return;
    }
    this.progress(ev.type === 'message_delta');
  }

  /** Sends the turn's output tokens so far to the status line (at most twice a second unless `now`). */
  private progress(now = false) {
    const at = Date.now();
    if (!now && at - this.progressAt < 500) return;
    this.progressAt = at;
    this.emit({
      type: 'chat.progress',
      tabId: this.tabId,
      outputTokens: this.turnTokens + this.thinkingTokens + Math.ceil(this.streamChars / 4),
    });
  }

  /** The context meter, live: each main-thread message's own input (cached parts included), then plus its output. */
  private trackContext(ev: { type: string; message?: unknown; usage?: unknown }) {
    type Usage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
    if (ev.type === 'message_start') {
      const u = ((ev.message as { usage?: Usage } | undefined)?.usage ?? {}) as Usage;
      this.contextIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (this.contextIn > 0) this.emit({ type: 'chat.context', tabId: this.tabId, tokens: this.contextIn });
    } else if (ev.type === 'message_delta' && this.contextIn > 0) {
      const out = (ev.usage as Usage | undefined)?.output_tokens ?? 0;
      this.emit({ type: 'chat.context', tabId: this.tabId, tokens: this.contextIn + out });
    }
  }

  private setBusy(busy: boolean, toolRunning = false) {
    this.busy = busy;
    this.toolRunning = toolRunning;
    if (!toolRunning) this.toolName = undefined;
    this.hooks.onStateChange();
  }

  private async consume() {
    let resumeFailed = false;
    try {
      for await (const msg of this.q) {
        // One message Harv can't handle (a new shape, a failed write) is logged and skipped; it never ends
        // a session Claude Code is still running fine (the full review, S19).
        try {
          this.handle(msg);
        } catch (err) {
          console.error(`[harv] skipped a Claude message in ${this.tabId}:`, err);
        }
      }
    } catch (err) {
      if (this.resume && !this.started) {
        resumeFailed = true;
        this.hooks.onResumeFailed();
      } else if (!this.closed) {
        this.emit({ type: 'chat.error', tabId: this.tabId, message: `Claude session ended: ${(err as Error).message}` });
      }
    } finally {
      this.ended = true;
      if (this.busy) this.emit({ type: 'chat.done', tabId: this.tabId, ok: false, stopped: this.stopping });
      this.setBusy(false);
      // A dead session left in place swallowed every later message (the tab stayed "thinking").
      if (!resumeFailed) this.hooks.onEnded?.();
    }
  }

  private handle(msg: SDKMessage) {
    const tabId = this.tabId;
    // Not in the SDK's types yet: the CLI saying it queued, started or completed one of our messages.
    const life = msg as unknown as { type: string; command_uuid?: string; state?: string };
    if (life.type === 'command_lifecycle') {
      this.lifecycle = true;
      if (life.state === 'started' && life.command_uuid && this.folding.delete(life.command_uuid)) {
        // Taken after the reply ended (or was stopped): it's a turn of its own, not a background one.
        const newTurn = !this.busy;
        if (newTurn) {
          this.newTurn();
          this.setBusy(true);
        }
        this.hooks.onFolded?.(life.command_uuid, newTurn);
      }
      return;
    }
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'thinking_tokens') {
          this.thinkingTokens += Math.max(0, msg.estimated_tokens_delta);
          this.progress();
          return;
        }
        if (this.taskTracker.apply(msg)) {
          this.emit({ type: 'chat.tasks', tabId, tasks: this.taskTracker.list() });
          return;
        }
        if (msg.subtype === 'commands_changed') {
          this.hooks.onCommands?.(toCommandInfo(msg.commands));
          return;
        }
        if (msg.subtype === 'compact_boundary') {
          this.emit({ type: 'chat.notice', tabId, message: 'Conversation compacted: the older part is summarized now.' });
          return;
        }
        if (msg.subtype !== 'init') return;
        this.started = true;
        void this.q
          .supportedCommands()
          .then((commands) => this.hooks.onCommands?.(toCommandInfo(commands, msg.terminal_slash_commands ?? [])))
          .catch(() => {});
        this.hooks.onSessionId(msg.session_id);
        if (!SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) {
          // Hard stop: this would bill per token instead of using the subscription.
          this.emit({
            type: 'chat.error',
            tabId,
            message: `Refused: Claude Code is authenticating with "${msg.apiKeySource}" instead of your subscription.`,
          });
          this.close();
        }
        return;

      case 'user': {
        if (msg.parent_tool_use_id) return;
        if (msg.uuid) this.chainEnd = msg.uuid;
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const output =
              typeof block.content === 'string'
                ? block.content
                : (block.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n');
            const why = this.struggle.toolResult(block.tool_use_id, block.is_error === true, output);
            if (why) this.hooks.onStruggle?.(why);
          }
        }
        const text = typeof content === 'string' ? content : '';
        const output = [...text.matchAll(LOCAL_OUTPUT)]
          .map((m) => m[1]!.replace(ANSI, '').trim())
          // Claude Code confirming a model or effort switch is never a reply: the tag already says what runs.
          // It showed as a Harv line after resumes and step-ups (the ShopNotes chat, 2026-11-10).
          .filter((line) => line && !SETTING_CONFIRM.test(line));
        if (output.length) this.say(output.join('\n\n'));
        return;
      }

      case 'stream_event': {
        if (msg.parent_tool_use_id) return;
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          if (ev.delta.text.trim()) this.gate.spoke(tabId);
          this.emit({ type: 'chat.delta', tabId, text: ev.delta.text });
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking') {
          this.thought = { index: ev.index, at: Date.now(), text: '' };
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta' && this.thought?.index === ev.index) {
          this.thought.text += ev.delta.thinking;
        } else if (ev.type === 'content_block_stop' && this.thought?.index === ev.index) {
          const { at, text } = this.thought;
          this.thought = null;
          if (text.trim())
            this.emit({ type: 'chat.thinking', tabId, text: text.trim(), seconds: Math.max(1, Math.round((Date.now() - at) / 1000)) });
        } else if (ev.type === 'message_start' && this.toolRunning) {
          this.setBusy(true, false);
        } else if (ev.type === 'message_start' && !this.busy && !this.closed) {
          // A turn nobody sent: Claude picked something up by itself (a background task finished).
          this.newTurn();
          this.hooks.onAutoTurn?.();
          this.setBusy(true);
        }
        this.countTokens(ev);
        this.trackContext(ev);
        return;
      }

      case 'assistant': {
        for (const block of msg.message.content) {
          const input = (block.type === 'tool_use' ? block.input : undefined) as
            { command?: unknown; run_in_background?: unknown } | undefined;
          if (block.type === 'tool_use' && block.name === 'Bash' && input?.run_in_background && typeof input.command === 'string') {
            this.shellCommands.set(block.id, input.command);
          }
        }
        if (msg.parent_tool_use_id) return;
        if (msg.uuid) this.chainEnd = msg.uuid;
        if (msg.error === 'rate_limit' && this.noCredits) return;
        if (msg.error === 'rate_limit') {
          this.hooks.onRateLimit({ status: 'rejected' });
          // Claude Code's own "You've hit your limit" text isn't a reply: one limit line says it (below).
          this.limitLine(ERROR_TEXT.rate_limit!);
          return;
        }
        if (msg.error && msg.error !== 'max_output_tokens') {
          this.emit({ type: 'chat.error', tabId, message: ERROR_TEXT[msg.error] ?? `Claude error: ${msg.error}` });
        }
        let text = '';
        let usedTool = false;
        const stuck = this.struggle.said(msg.message.content.map((block) => (block.type === 'text' ? block.text : '')).join(' '));
        if (stuck) this.hooks.onStruggle?.(stuck);
        for (const block of msg.message.content) {
          if (block.type === 'text') text += block.text;
          if (block.type === 'tool_use') {
            if (!text.trim() && this.gate.saysFirst(tabId, block.name)) continue; // sent back to say first: not shown
            const command = (block.input as { command?: unknown } | undefined)?.command;
            this.struggle.toolUse(block.id, typeof command === 'string' ? command : undefined);
            usedTool = true;
            if (MEMORY_TOOLS.includes(block.name)) this.usedMemoryTool = true;
            // A note Harv read with recall is in this chat now: it doesn't join a later message again.
            if (block.name === 'mcp__harv__recall') {
              const names = (block.input as { names?: unknown } | undefined)?.names;
              if (Array.isArray(names)) for (const n of names) if (typeof n === 'string') this.seenMemories.shown.add(n);
            }
            this.toolName = block.name.replace(/^mcp__harv__/, '');
            if (text) {
              this.say(text);
              text = '';
            }
            const input = (block.input ?? {}) as Record<string, unknown>;
            this.emit({
              type: 'chat.tool',
              tabId,
              id: block.id,
              // Harv's own tools by their short name; desktop control as "desktop · open Calculator".
              name: isDesktopTool(block.name) ? DESKTOP_SERVER : block.name.replace(/^mcp__harv__/, ''),
              detail: describeTool(block.name, input, (id) => this.store.title(id)),
            });
          }
        }
        if (text) this.say(text);
        if (usedTool) {
          this.setBusy(true, true);
          // A tool is running: messages the user queued can go in now, and Claude reads them after it.
          this.hooks.onToolUse?.();
        }
        return;
      }

      case 'result': {
        // This chat's own memory edits are already in its context; don't report them back to it.
        if (this.usedMemoryTool) this.memory = memorySnapshot();
        this.usedMemoryTool = false;
        const ok = msg.subtype === 'success' && !msg.is_error;
        // A command that answered without a message (e.g. /clear) still shows what it said.
        if (ok && !this.said && msg.result.trim()) this.say(msg.result.trim());
        const total = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : this.costSoFar;
        const costUsd = total >= this.costSoFar ? total - this.costSoFar : total;
        this.costSoFar = total;
        let error: string | undefined;
        if (!ok && !this.stopping && !this.limitShown)
          error = msg.subtype === 'success' ? msg.result : msg.errors.join('; ') || msg.subtype;
        this.emit({
          type: 'chat.done',
          tabId,
          ok,
          stopped: this.stopping,
          error,
          ...(this.struggle.troubled ? { troubled: true } : {}),
          usage: {
            // Cached context counts too: it's most of what a long chat sends.
            inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
            outputTokens: msg.usage.output_tokens,
            durationMs: msg.duration_ms,
            costUsd,
          },
        });
        this.stopping = false;
        if (this.chainEnd) this.hooks.onChainEnd?.(this.chainEnd);
        this.setBusy(false);
        return;
      }

      case 'rate_limit_event': {
        const info = msg.rate_limit_info;
        const resets = info.resetsAt ? ` It resets at ${clock(info.resetsAt)}.` : '';
        if (info.isUsingOverage || info.overageInUse) {
          // Extra usage is billed. Harv is subscription-only, so stop right here and wait for the reset.
          this.hooks.onRateLimit({ ...info, status: 'rejected' });
          this.emit({
            type: 'chat.error',
            tabId,
            message: `Stopped: Claude was about to use paid extra usage, which Harv never does. Turn extra usage off at claude.ai › Settings › Usage.${resets}`,
          });
          void this.stop();
          return;
        }
        if (info.status === 'rejected' && info.errorCode === 'credits_required') {
          // Not a plan limit: this model wants paid credits. Only it is out; Harv never buys any.
          this.noCredits = true;
          const model = modelFamily(this.model);
          this.hooks.onNoCredits?.(model, info.resetsAt ? info.resetsAt * 1000 : undefined);
          this.limitShown = true;
          this.emit({
            type: 'chat.error',
            tabId,
            message: `${model[0]!.toUpperCase()}${model.slice(1)} needs paid usage credits, which aren't part of your plan, and Harv never buys them. Send it again and it runs on Opus.`,
          });
          return;
        }
        this.hooks.onRateLimit(info);
        if (info.status === 'rejected') {
          // Never offer to buy credits or use overage: Harv is subscription-only.
          this.limitLine(`Claude Pro usage limit reached.${resets}`);
        }
        // `allowed_warning` comes with every API call above Claude's own mark, so it says nothing
        // here: the usage meter warns once per threshold (Settings › Usage warnings).
        return;
      }

      default:
        return;
    }
  }
}
