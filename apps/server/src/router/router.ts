import { AUTO_FALLBACK, type Attachment, type ChatUsage, type RouteDecision, type RouteSource } from '@harv/shared';
import { memoryIndex } from '../agent/memory.ts';
import { skillsFor, type SkillUse } from '../agent/skillMap.ts';
import type { CostGuide, RouteStore } from '../store/routes.ts';
import { classify as haikuClassify, type MemoryUse } from './classifier.ts';
import { asksForWork, instantRules, isAgreement, isFollowUp, parseOverride, saysStillWrong } from './rules.ts';
import { atLeast, pickFor, stepUp, struggleStep, tag, type Classification, type Pick } from './table.ts';

type Classify = (
  text: string,
  files: Attachment[],
  context?: string,
  title?: string,
  summary?: string,
  skills?: SkillUse[],
  memories?: MemoryUse[],
) => Promise<Classification | null>;

interface TabState {
  /** The decision for the task in progress (small talk doesn't replace it). */
  task?: { pick: Pick; why: string; at: number; c?: Classification; base?: { pick: Pick; why: string } };
  /** The last turn ended in an error, so the next follow-up steps up. */
  failed?: boolean;
  /** "Still wrong" messages in a row for the current task, and when the last message came (the three-approaches note). */
  wrong?: { n: number; at: number };
}

/** In front of the turn after the user's third "still wrong" (brief: three truly different approaches, then stop and show). */
export const THREE_TRIES_NOTE =
  '[Three tries have failed. If this one is not a truly different approach that works, stop: show the best result so far and say exactly what is missing.]\n\n';

/** What the router knows about the chat a message is in. */
export interface RouteContext {
  /** A project chat: real dev work, so at least PROJECT_FLOOR. */
  project?: boolean;
  /** The last few lines of the chat, so the classifier judges a follow-up in context. */
  recent?: string;
  /** Spoken (Siri, voice mode): no classifier call, the instant rules or SPOKEN_PICK (speed matters here). */
  spoken?: boolean;
  /** The chat's current one-line summary, which the classifier keeps up to date (docs/PLAN.md §6c). */
  summary?: string;
}

/**
 * A spoken message that no instant rule decides. The classifier's ~2 s made Siri give up at 8 s on
 * nearly every question (2026-11-14); Sonnet keeps the answer good, medium keeps it quick.
 */
export const SPOKEN_PICK: Pick = { model: 'sonnet', effort: 'medium' };

/** The least a project chat's work runs at (small talk excepted): the user wants the best result first. */
export const PROJECT_FLOOR: Pick = { model: 'sonnet', effort: 'high' };
/** "Try harder" on at least this many similar tasks, and this share of them, starts that kind one step higher. */
const LEARN_MIN_HARDER = 2;
const LEARN_SHARE = 0.25;
const LEARN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * AUTO: picks model·effort for each message. Instant rules first, then a cheap
 * Haiku classifier, then the table; "Try harder" and failures climb the ladder.
 * Every decision is logged for tuning.
 */
/** A follow-up's reason without its "same task (…)" wrapping: the task's own reason. */
const taskWhy = (why: string) => why.replace(/^same task \((.*)\)$/, '$1');

/** The task's first reason, under every "same task" and "back to the task's own pick" layer (they nested three deep, 2026-11-21). */
const baseWhy = (why: string): string => {
  const inner = why.replace(/^(?:same task|back to the task’s own pick, it works again) \((.*)\)$/, '$1');
  return inner === why ? why : baseWhy(inner);
};

export class Router {
  private tabs = new Map<string, TabState>();

  constructor(
    private log: RouteStore,
    private classify: Classify = haikuClassify,
    /** Weekly plan usage in % (the meter's), undefined until it's known. */
    private weeklyUsed: () => number | undefined = () => undefined,
    /** The "allow Fable in AUTO" setting. */
    private allowFable: () => boolean = () => false,
    /** The skills a chat can load, for the classifier to pick from (agent/skillMap.ts). */
    private skills: (project: boolean) => SkillUse[] = (project) => skillsFor(project),
    /** Harv's topic notes (not in every prompt), for the classifier to name the ones a message touches. */
    private memories: () => MemoryUse[] = () => memoryIndex(),
  ) {}

  private state(tabId: string): TabState {
    let s = this.tabs.get(tabId);
    if (!s) this.tabs.set(tabId, (s = {}));
    return s;
  }

  /**
   * Decides a message's model·effort. `text` comes back without any `/opus`-style override words.
   * When the classifier ran, `title` is its short name for the chat (given the current `title`).
   */
  async route(
    tabId: string,
    message: string,
    files: Attachment[] = [],
    title?: string,
    ctx: RouteContext = {},
  ): Promise<{ decision: RouteDecision; text: string; title?: string; summary?: string; skill?: string; memories?: string[] }> {
    const s = this.state(tabId);
    const override = parseOverride(message);
    const text = override.text;

    if (override.model) {
      const pick: Pick = { model: override.model, effort: override.effort ?? 'high' };
      return { decision: this.record(tabId, pick, 'override', 'you asked for it'), text };
    }

    const auto = await this.auto(s, text, files, title, ctx);
    let { pick, source, why } = auto;
    if (ctx.project && why !== 'small talk' && atLeast(pick, PROJECT_FLOOR) !== pick) {
      pick = PROJECT_FLOOR;
      why = `${why}; project work runs at least ${tag(PROJECT_FLOOR)}`;
    }
    if (override.effort) {
      pick = { ...pick, effort: override.effort };
      source = 'override';
      why = `effort you asked for; ${why}`;
    }
    if (why !== 'small talk') s.task = { pick, why, at: Date.now(), ...(auto.c ? { c: auto.c } : {}) };
    // A follow-up reuses the task's classification for the log, but only a fresh one names the chat.
    const fresh = auto.source === 'followup' ? undefined : auto.c;
    return {
      decision: this.record(tabId, pick, source, why, auto.c),
      text,
      ...(fresh?.title ? { title: fresh.title } : {}),
      ...(fresh?.summary ? { summary: fresh.summary } : {}),
      // A new task that fits a skill: Harv is told to load it (agent/skillMap.ts); follow-ups keep going in it.
      ...(fresh?.skill ? { skill: fresh.skill } : {}),
      // The memory notes it touches: their full text joins the turn (agent/memory.ts; once per session).
      ...(fresh?.memories ? { memories: fresh.memories } : {}),
    };
  }

  private async auto(
    s: TabState,
    text: string,
    files: Attachment[],
    title?: string,
    ctx: RouteContext = {},
  ): Promise<{ pick: Pick; source: RouteSource; why: string; c?: Classification }> {
    const rule = instantRules(text, files);
    const inTask = !!s.task && isFollowUp(text, files, s.task.at);
    // "Still wrong" in an ongoing task: one step up, like a struggling reply (never past STRUGGLE_CEILING).
    if (s.task && inTask && saysStillWrong(text)) {
      const up = struggleStep(s.task.pick) ?? s.task.pick;
      return { pick: up, source: 'stepup', why: `you said it still doesn't work (was ${tag(s.task.pick)})`, c: s.task.c };
    }
    // A bare "yes" / "ok" in an ongoing task answers Harv's question: it stays on the task's model.
    if (rule?.kind === 'decide' && !(s.task && inTask && isAgreement(text))) return { pick: rule.pick, source: 'rule', why: rule.why };

    // A follow-up keeps the task's pick; new work in it ("now redesign the whole engine") is classified
    // again, but never below the task (the full review, S17: a project chat never re-routed, and a
    // follow-up's lower pick replaced the task's). One Haiku call (the user's OK, review Q7).
    if (s.task && inTask) {
      const why = taskWhy(s.task.why);
      // A floor rule (desktop, mail, code…) inside the task: the higher of the two, no classifier call.
      if (rule && rule.kind !== 'decide') {
        const pick = atLeast(s.task.pick, rule.pick);
        return { pick, source: 'followup', why: `same task (${why}); at least ${tag(rule.pick)} for ${rule.why}`, c: s.task.c };
      }
      if (!asksForWork(text)) {
        const up = s.failed ? struggleStep(s.task.pick) : null;
        if (up) return { pick: up, source: 'followup', why: `stepped up after the last turn failed (${why})`, c: s.task.c };
        return { pick: s.task.pick, source: 'followup', why: `same task (${why})`, c: s.task.c };
      }
    }
    const taskFloor = s.task && inTask ? s.task.pick : undefined;

    if (ctx.spoken) {
      const pick = rule ? atLeast(SPOKEN_PICK, rule.pick) : SPOKEN_PICK;
      return { pick, source: 'rule', why: rule ? `spoken; at least ${tag(rule.pick)} for ${rule.why}` : 'spoken, answered quickly' };
    }
    const c = await this.classify(text, files, ctx.recent ?? s.task?.why, title, ctx.summary, this.skills(!!ctx.project), this.memories());
    if (!c) {
      const pick = rule ? atLeast(AUTO_FALLBACK, rule.pick) : AUTO_FALLBACK;
      return { pick, source: 'fallback', why: 'the classifier didn’t answer, so the default' };
    }
    const table = pickFor(c, this.weeklyUsed(), this.allowFable());
    // Learned from "Try harder": this kind of task keeps needing more, so start it a step higher.
    const seen = this.log.harderStats(c.category, c.difficulty, Date.now() - LEARN_WINDOW_MS);
    if (seen.harder >= LEARN_MIN_HARDER && seen.harder / seen.turns >= LEARN_SHARE) {
      const up = stepUp(table.pick, this.allowFable());
      if (up) {
        table.pick = up;
        table.why += `, a step up (you asked to try harder on ${seen.harder} similar tasks)`;
      }
    }
    if (rule && atLeast(table.pick, rule.pick) !== table.pick) {
      return { pick: rule.pick, source: 'rule', why: `${table.why}; at least ${tag(rule.pick)} for ${rule.why}`, c };
    }
    if (taskFloor && atLeast(table.pick, taskFloor) !== table.pick) {
      return { pick: taskFloor, source: 'classifier', why: `${table.why}; kept at the task's ${tag(taskFloor)} (new work in it)`, c };
    }
    return { pick: table.pick, source: 'classifier', why: table.why + (c.ambiguous ? ', ambiguous' : ''), c };
  }

  /** A short title for a chat no AUTO classification named (manual mode, quick rules, spoken turns): one cheap classifier call. */
  async name(text: string, files: Attachment[] = [], summary?: string): Promise<{ title?: string; summary?: string }> {
    const c = await this.classify(text, files, undefined, undefined, summary);
    return { ...(c?.title ? { title: c.title } : {}), ...(c?.summary ? { summary: c.summary } : {}) };
  }

  /** "Try harder": one step up from what the last turn ran at. Null when that was already the top. */
  harder(tabId: string, from: Pick): RouteDecision | null {
    const up = stepUp(from, this.allowFable());
    if (!up) return null;
    this.log.markLast(tabId, 'harder');
    const s = this.state(tabId);
    const why = `you asked to try harder (was ${tag(from)})`;
    s.task = { pick: up, why, at: Date.now() };
    return this.record(tabId, up, 'harder', why);
  }

  /**
   * A reply is struggling (tests failing, tool calls failing in a row): one step up mid-reply, at most
   * up to STRUGGLE_CEILING. The task keeps the new pick while it struggles; once a reply ends with it
   * working again, its follow-ups drop back to the task's own pick (finished; the user's rule, 2026-11-09).
   */
  struggling(tabId: string, from: Pick, why: string): RouteDecision | null {
    const up = struggleStep(from);
    if (!up) return null;
    const reason = `↑ stepped up from ${tag(from)}: ${why}`;
    const s = this.state(tabId);
    // The task's own pick, from before the first step up (never below it when dropping back).
    const base = s.task?.base ?? { pick: s.task?.pick ?? from, why: s.task?.why ?? tag(from) };
    s.task = { pick: up, why: reason, at: Date.now(), base, ...(s.task?.c ? { c: s.task.c } : {}) };
    return this.record(tabId, up, 'stepup', reason);
  }

  /**
   * Counts the user's "still wrong" messages for the task, in AUTO and manual mode alike: a new task
   * (not a follow-up) starts over. From the third on, the turn gets THREE_TRIES_NOTE in front.
   */
  tries(tabId: string, text: string, now = Date.now()): string {
    const s = this.state(tabId);
    const last = s.wrong?.at ?? s.task?.at;
    if (saysStillWrong(text)) s.wrong = { n: (isFollowUp(text, [], last, now) ? (s.wrong?.n ?? 0) : 0) + 1, at: now };
    else if (!isFollowUp(text, [], last, now)) s.wrong = undefined;
    else if (s.wrong) s.wrong.at = now;
    return (s.wrong?.n ?? 0) >= 3 ? THREE_TRIES_NOTE : '';
  }

  /** Logs a turn the user picked the model for (manual mode), so Harv's stats count every turn. */
  manual(tabId: string, decision: RouteDecision): void {
    this.record(tabId, decision, decision.source, decision.reason);
  }

  /**
   * A turn ended; failures make the next follow-up step up, and the follow-up window starts now (a long
   * reply doesn't use it up). A stepped-up task that works again (the reply ended well, its last tool
   * call didn't fail) drops back to its own pick: quality first, but no xhigh for the rest of the task.
   */
  /** What replies cost here, from the log (plan_usage's cost guide). */
  costGuide(): CostGuide {
    return this.log.costGuide();
  }

  finished(tabId: string, ok: boolean, stopped: boolean, usage?: ChatUsage, troubled = false): void {
    const s = this.state(tabId);
    s.failed = !ok && !stopped;
    if (s.task?.base && ok && !stopped && !troubled) {
      const { pick, why } = s.task.base;
      s.task = {
        pick,
        why: `back to the task’s own pick, it works again (${baseWhy(why)})`,
        at: Date.now(),
        ...(s.task.c ? { c: s.task.c } : {}),
      };
    }
    if (s.task) s.task.at = Date.now();
    if (s.wrong) s.wrong.at = Date.now();
    if (usage) this.log.finishLast(tabId, usage);
  }

  forget(tabId: string): void {
    this.tabs.delete(tabId);
  }

  private record(chatId: string, pick: Pick, source: RouteSource, reason: string, c?: Classification): RouteDecision {
    this.log.add({ chatId, ...pick, source, reason, category: c?.category, difficulty: c?.difficulty, stakes: c?.stakes });
    return { ...pick, source, reason };
  }
}
