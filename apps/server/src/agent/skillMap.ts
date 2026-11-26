import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Which skill fits which everyday task (the user, 2026-11-19: "make sure Harv uses them when they are
// needed"). A skill's own description is written for coding work ("captures findings as a Markdown file
// in the repo"), so a car search never looked like `research`. This map says it in the user's terms, once:
// the router's classifier picks from it on every new task (no extra model call) and the turn starts with
// a note naming the skill; every chat's prompt carries it too, for follow-ups and when the router can't see it.

export interface SkillUse {
  name: string;
  /** When it fits, in the words a user would use. */
  when: string;
  /** Only project chats load it (coding work; normal chats list `CHAT_SKILLS` only). */
  project?: boolean;
  /** One of Claude's own document skills (always there, no folder in ~/.claude/skills). */
  builtIn?: boolean;
}

export const SKILL_MAP: SkillUse[] = [
  {
    name: 'research',
    when: 'finding and comparing things to buy or choose (cars, phones, watches, parts, deals, prices, specs), checking facts or rules the user will act on, what could be wrong with a car, appliance or other physical thing from its symptoms, gathering what sources say about a topic',
  },
  {
    name: 'teach',
    when: 'the user wants to learn or understand a subject step by step (a school subject, a language, a tool, "teach me", "explain it so I get it")',
  },
  {
    name: 'grilling',
    when: 'the user wants a plan or idea stress-tested ("grill me", "poke holes"), or a big new job with open choices is about to start',
  },
  {
    name: 'diagnose',
    when: "something is broken or misbehaving: an error, a crash, a hang, slowness, a program, game, the computer, a build or test that fails, a fix that didn't work",
  },
  {
    name: 'impeccable',
    when: 'designing, redesigning or judging how an interface looks or feels: an app or web page, a dashboard, a watch face, a screen layout',
  },
  {
    name: 'figma-templates',
    when: 'starting something visual from scratch where a ready template saves work: an app or web UI, a poster, slides, a logo or icon set',
  },
  {
    name: 'diagram-design',
    when: 'a diagram or chart to draw: a flowchart, timeline, architecture, org chart, mind map, comparison graphic',
  },
  { name: 'image-prompt', when: 'a picture to make: a photo, illustration, logo, icon, wallpaper, poster, sticker' },
  {
    name: 'prompt-writer',
    when: 'a prompt for another AI tool (ChatGPT, Gemini, Midjourney, Suno, Cursor…), or improving one the user has',
  },
  { name: 'skill-finder', when: '"is there a skill / tool / MCP for X", or a link or reel about a skill or AI tool to check' },
  { name: 'video', when: 'a video link or reel (YouTube, Instagram, TikTok…): what it says or shows, a summary, notes' },
  { name: 'google', when: "the user's Gmail, Google Calendar, Drive, Docs or Sheets" },
  { name: 'resolve', when: 'anything in DaVinci Resolve: editing a video, cuts, colour, titles, subtitles, sound, renders' },
  { name: 'clone', when: "building the user's own version of an existing app, or asking how an app works in order to rebuild it" },
  { name: 'find-docs', when: 'how to use a specific library, framework, CLI, SDK or API (current syntax, config, versions)' },
  {
    name: 'learn-from-session',
    when: 'the user corrects how Harv works and the lesson should be kept, or a session ends ("bye", the fresh routine)',
  },
  { name: 'pdf', when: 'reading, filling, merging or making a PDF file', builtIn: true },
  { name: 'docx', when: 'a Word file (.docx) to read, make or change', builtIn: true },
  { name: 'xlsx', when: 'a spreadsheet file (.xlsx, .csv) to read, make or change', builtIn: true },
  { name: 'pptx', when: 'a PowerPoint file (.pptx) to read, make or change', builtIn: true },
  { name: 'tdd', when: 'building a feature or fixing a bug test-first, or adding real tests', project: true },
  { name: 'prototype', when: 'trying a UI or logic idea quickly as a throwaway before building it for real', project: true },
  { name: 'codebase-design', when: "designing a module's interface, where a seam goes, making code easier to test", project: true },
  { name: 'improve-codebase-architecture', when: "how to restructure or clean up a whole codebase's architecture", project: true },
  { name: 'deslop', when: 'cleaning up or slimming down code that grew over many fix rounds, after a big feature', project: true },
  { name: 'ui-check', when: 'checking a screen in the real app after a UI change, or when something looks off', project: true },
  {
    name: 'writing-for-agents',
    when: 'writing or editing a skill, CLAUDE.md, AGENTS.md or other instructions for an AI agent',
    project: true,
  },
];

const SKILLS_DIR = join(homedir(), '.claude', 'skills');

/** The skills a chat can load: built-ins, and the others only when their folder is there. */
export function skillsFor(project: boolean, installed: (name: string) => boolean = (n) => existsSync(join(SKILLS_DIR, n))): SkillUse[] {
  return SKILL_MAP.filter((s) => (project || !s.project) && (s.builtIn || installed(s.name)));
}

/** The list the router's classifier picks from (one line each). */
export const classifierList = (skills: SkillUse[]) => skills.map((s) => `${s.name}: ${s.when}`).join('\n');

/** The section in every chat's prompt. */
export function skillMapText(skills: SkillUse[]): string {
  return [
    '## Which skill fits (persona rule 12)',
    "Before you start a task that matches one of these, load that skill with the Skill tool and follow it, and mention it in passing inside a natural sentence (never as a label like \"Using research.\"). Several fit: the most specific one. When the turn starts with a [Skill: …] note, the router saw a fit: load it first, unless on a closer look it clearly doesn't fit (then just go on without it; don't say you're not using it). A quick one-line answer needs no skill.",
    ...skills.map((s) => `- ${s.name}: ${s.when}`),
  ].join('\n');
}

/** The note in front of a turn whose new task fits a skill. */
export const skillNote = (name: string) =>
  `[Skill: this task fits your \`${name}\` skill. Load it with the Skill tool before you start and say so in a few words.]\n\n`;
