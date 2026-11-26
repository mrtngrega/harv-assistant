import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Attachment } from '@harv/shared';
import { buildOptions, SUBSCRIPTION_KEY_SOURCES } from '../agent/options.ts';
import { classifierList, type SkillUse } from '../agent/skillMap.ts';
import type { Classification } from './table.ts';

export const PROMPT = `You route messages for Harv, a personal assistant on the user's computer, to the right Claude model. You never answer the message itself.
Reply with ONLY one JSON object, no prose:
{"category": "<one or two words: chat, question, writing, research, code, debugging, analysis, planning, pc-task, math, ...>", "difficulty": <1-5>, "stakes": "low" | "normal" | "high", "ambiguous": <true|false>, "simple": <true|false>, "title": "<chat title>", "summary": "<one line on the whole chat>", "skill": "<a skill name from the list below, or none>"}
simple: true only for a greeting or thanks, a one-fact answer, switching lights, opening an app, reading out a computer stat, or a quick yes/no. Explaining, writing, code, research, planning and anything on the user's screen are never simple. When unsure: false.
difficulty: 1 = trivial (a greeting, a fact, a one-liner), 2 = easy (a short explanation, a small edit), 3 = moderate (a normal task, some code, a few steps), 4 = hard (multi-step work, real code changes, careful reasoning), 5 = very hard (deep research, architecture, tricky debugging, long precise work).
stakes: high when a mistake would cost the user something real (their files, money, health, legal, security, sending things to other people).
title: a short tab name for the whole chat: at most 3 words, under 24 characters, in the language the user writes in, like "Week plan", "GPU driver update", "Contract renewal"; "PS5 rental for GTA 6" is too long, "PS5 rental" fits. Name what the whole chat is about (the current summary plus the new message), not only the new message; a leading /report or /btw is a command, not the topic. If a current title is given and still fits the whole chat, repeat it exactly.
summary: one plain sentence (under 160 characters) on what this whole chat is about, so Harv in other chats knows what was talked about here: the topics, what was decided or done, what's left, always in English (whatever language the chat is in). If a current summary is given, keep what still matters from it and add the new message's topic. The new message has NOT been answered yet: say what it asks for, never an answer or a result (you don't know them). Facts from the chat only; no guesses.`;

/** The skill part of the prompt: Harv loads the named skill before he starts (agent/skillMap.ts). */
export const skillPrompt = (skills: SkillUse[]) =>
  `skill: the one skill below whose use clearly fits what the new message asks for, else "none". Pick one only when the message itself is that kind of task (a quick fact, small talk, a yes/no or a short follow-up is "none"); several fit: the most specific.
Skills:
${classifierList(skills)}`;

/** A memory note the classifier can name: Harv gets its full text with the message (agent/memory.ts). */
export interface MemoryUse {
  name: string;
  about: string;
}

/** The memory part of the prompt, added to the JSON shape as "memories". */
export const memoryPrompt = (memories: MemoryUse[]) =>
  `topic and memories: add these two fields to the JSON object, topic first. topic: "…", the one thing the new message is about, named as exactly as the message and the chat let you (with the chat title and summary, "where did we stop?" in a chat about one project is about that project: "the booking-app school project", "the user's own car", "the game controller setup"; "" for small talk). memories: ["names"], the notes below whose facts Harv needs to answer the new message well: the user's own things, people, plans, projects, devices, preferences or past decisions it touches, also when it only hints at them ("my watch", "that car", "the class project", "the boys", "my teacher", "those cheap ones"): match a hint against what each note is about; a message in any language. A note applies only when its thing is the topic you wrote, or a part of it (that device, person, project, plan or habit). A word they share ("battery", "performance", "engine", "clean", "car" inside a name like "CarShop") or a thing of the same kind (another device, another project, other school work) doesn't make it apply: a message about the user's notebook doesn't need a note about their car, and work on one project doesn't need the notes of the others. Only notes about the topic itself: when unsure, leave it out (Harv sees the index and can still read it). [] for small talk or when none is about the topic. Names only from this list:
${memories.map((m) => `${m.name}: ${m.about}`).join('\n')}`;

/** Message text passed to the classifier, trimmed to keep the call cheap. */
const MAX_CHARS = 2000;
const TIMEOUT_MS = 20_000;

/** A tidy tab title, or undefined when the model's suggestion is unusable. */
export function cleanTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const title = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'“”‘’`\s]+|["'“”‘’`.!?:;,\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // At most 3 words (the user, 2026-11-20: "short, like 3 words max"): a longer one is no name, the chat keeps the one it has.
  if (!title || title.split(' ').length > 3) return undefined;
  return title.length > 28 ? `${title.slice(0, 27)}…` : title;
}

/** A chat summary on one line, capped; undefined when the model's suggestion is unusable. */
export function cleanSummary(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const summary = raw
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’`\s]+|["'“”‘’`\s]+$/g, '')
    .trim();
  if (summary.length < 8) return undefined;
  return summary.length > 200 ? `${summary.slice(0, 199)}…` : summary;
}

/** Pulls the classification out of the model's reply; null if it isn't usable. */
export function parseClassification(
  reply: string,
  skills: readonly string[] = [],
  memories: readonly string[] = [],
): Classification | null {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (!json) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const difficulty = Math.round(Number(raw.difficulty));
  if (!(difficulty >= 1 && difficulty <= 5)) return null;
  const stakes = raw.stakes === 'high' || raw.stakes === 'low' ? raw.stakes : 'normal';
  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim().slice(0, 30) : 'task';
  const title = cleanTitle(raw.title);
  const summary = cleanSummary(raw.summary);
  const skill = typeof raw.skill === 'string' && skills.includes(raw.skill.trim()) ? raw.skill.trim() : undefined;
  const named = Array.isArray(raw.memories) ? raw.memories.filter((m): m is string => typeof m === 'string').map((m) => m.trim()) : [];
  const notes = [...new Set(named.filter((m) => memories.includes(m)))];
  return {
    category,
    difficulty: difficulty as Classification['difficulty'],
    stakes,
    ambiguous: raw.ambiguous === true,
    simple: raw.simple === true,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(skill ? { skill } : {}),
    ...(notes.length ? { memories: notes } : {}),
  };
}

/**
 * One Haiku·low turn with no tools and no saved session. It counts against the
 * plan like any call, so the router only asks when its rules can't decide.
 */
export async function classify(
  text: string,
  files: Attachment[],
  context?: string,
  title?: string,
  summary?: string,
  skills: SkillUse[] = [],
  memories: MemoryUse[] = [],
): Promise<Classification | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const message = [
    title ? `Current chat title: "${title}"` : '',
    summary ? `Current chat summary: "${summary}"` : '',
    context ? `Earlier in this chat (for context only; route the new message):\n${context}` : '',
    files.length ? `Attached files: ${files.map((f) => `${f.name} (${Math.round(f.size / 1024)} KB)`).join(', ')}` : '',
    `Message:\n${text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const q = query({
    prompt: message,
    options: {
      ...buildOptions('haiku', 'low', abort),
      systemPrompt: [PROMPT, skills.length ? skillPrompt(skills) : '', memories.length ? memoryPrompt(memories) : '']
        .filter(Boolean)
        .join('\n'),
      tools: [],
      maxTurns: 1,
      persistSession: false,
      includePartialMessages: false,
    },
  });
  try {
    for await (const msg of q) {
      // Same hard stop as chat sessions: never run on anything but the subscription.
      if (msg.type === 'system' && msg.subtype === 'init' && !SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) return null;
      if (msg.type === 'result')
        return msg.subtype === 'success'
          ? parseClassification(
              msg.result,
              skills.map((s) => s.name),
              memories.map((m) => m.name),
            )
          : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}
