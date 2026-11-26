import type { Attachment, EffortLevel } from '@harv/shared';
import type { Pick } from './table.ts';

const MODEL_WORDS: Record<string, string> = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', fable: 'fable' };
const EFFORT_WORDS: Record<string, EffortLevel> = {
  low: 'low',
  med: 'medium',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/** `/opus`, `/max`, `/sonnet /high` at the start of a message. The words are removed from the text. */
export function parseOverride(text: string): { model?: string; effort?: EffortLevel; text: string } {
  let rest = text;
  let model: string | undefined;
  let effort: EffortLevel | undefined;
  for (;;) {
    const m = /^\s*\/([a-z]+)\b\s*/i.exec(rest);
    const word = m?.[1]!.toLowerCase();
    if (!m || !word) break;
    if (!model && MODEL_WORDS[word]) model = MODEL_WORDS[word];
    else if (!effort && EFFORT_WORDS[word]) effort = EFFORT_WORDS[word];
    else break;
    rest = rest.slice(m[0].length);
  }
  return { model, effort, text: model || effort ? rest : text };
}

const SMALL_TALK =
  /^(hi|hey|hello|yo|hiya|thanks|thank you|thx|ty|cheers|ok|okay|k|cool|nice|great|perfect|got it|good (morning|evening)|lol|yes|no|yep|nope|sure|ahoj|čau|cau|ďakujem|dakujem|vďaka|vdaka|diky|díky|jo|áno|ano|nie|dobre|super)(?![\p{L}])[\s!.,?:)]*$/iu;

/** A bare yes / no / ok: in an ongoing task it answers Harv's question, so it stays on the task's model. */
const AGREEMENT = /^(ok|okay|k|yes|no|yep|nope|sure|got it|jo|áno|ano|nie|dobre)(?![\p{L}])[\s!.,?:)]*$/iu;
export const isAgreement = (text: string) => AGREEMENT.test(text.trim());

/**
 * The user says the result is still wrong (English and Slovak): the struggle step-up didn't see it,
 * because the tools all ran fine (the "File explorer layout" chat, 2026-11-11).
 */
// Whole phrases only: "zase", "stále", "furt" alone were in "do it again for the other file" and the
// like, and stepped the model up (the full review, S21).
const STILL_WRONG =
  /\b(still (wrong|broken|not working|doesn'?t work|the same|bad)|(it )?(doesn'?t|does not|didn'?t|did not) work|not working|same (problem|issue)|wrong again|nope,? (still|again))\b|(?<![\p{L}])(nefunguje|nefungovalo|(stále|stale|furt|zase) (nefunguje|nejde|zle|to isté|to iste|rovnaké|rovnake|chyba)|nejde to|stale nie|stále nie)(?![\p{L}])/iu;
export const saysStillWrong = (text: string) => text.trim().length <= 300 && STILL_WRONG.test(text);

/**
 * The user signing off ("bye", persona rule 14): the wrap-up is real work (memory, learn-from-session),
 * so it isn't small talk for Haiku. "bye" went to Haiku on 2026-10-26 and nothing was saved or learned.
 */
const SIGN_OFF =
  /^(bye( bye)?( harv)?|good ?bye|see (you|ya)( later| tomorrow)?|cya|good ?night|gn|i'?m (off|done)( for (today|now|the day))?)\b[\s!.,:)]*$/i;

export function isSignOff(text: string): boolean {
  return SIGN_OFF.test(text.trim());
}

/** Asks for something on the PC that the safety gate would treat as red. */
const RISKY_VERB = /\b(delete|uninstall|install|wipe|erase|kill|terminate|regedit|registry|reformat|overwrite)\b/i;
const PC_THING =
  /\b(files?|folders?|director(y|ies)|apps?|programs?|software|process(es)?|packages?|drivers?|services?|registry|settings|startup|disk|drive|partition|downloads|desktop|documents)\b|[a-z]:\\/i;

/**
 * Asks Harv to act in an app or on the screen (desktop control, English and Slovak). Such a task looks
 * easy ("open word and type hello") but takes many steps of looking and acting: Haiku clicked with
 * coordinates from the wrong monitor and gave up (2026-11-10), so it gets at least Sonnet.
 */
const DESKTOP_ACT =
  /(?<![\p{L}])(open|click|double-click|right-click|type|press|scroll|switch to|close|minimi[sz]e|maximi[sz]e|drag|fill in|select|otvor|klikni|napíš|napis|stlač|stlac|prepni|zavri|zatvor|vyplň|vypln|označ|oznac)(?![\p{L}])/iu;
const DESKTOP_THING =
  /(?<![\p{L}])(word|excel|powerpoint|notepad|paint|calculator|apps?|programs?|windows?|screen|desktop|monitor|browser|chrome|brave|edge|firefox|discord|steam|spotify|explorer|button|menu|field|wordu?|okn[oe]|obrazovk\p{L}*|aplikáci\p{L}*|aplikaci\p{L}*|tlačidl\p{L}*|tlacidl\p{L}*|prehliadač\p{L}*|prehliadac\p{L}*)(?![\p{L}])/iu;
export const asksForDesktopWork = (text: string) => DESKTOP_ACT.test(text) && DESKTOP_THING.test(text);

/**
 * About his mail or calendar (English and Slovak). Such a turn reads other people's text and picks
 * among dozens of connector tools, so it gets at least Sonnet (connectors plan K2).
 */
const MAIL_OR_CALENDAR =
  /(?<![\p{L}])(e-?mails?|mails?|gmail|inbox|calendar|meetings?|invites?|invitations?|rsvp|po[sš]t[aeuy]|schr[aá]nk\p{L}*|kalend[aá]r\p{L}*|udalos[tť]\p{L}*|pozv[aá]nk\p{L}*|stretnuti\p{L}*)(?![\p{L}])/iu;
export const asksAboutMailOrCalendar = (text: string) => MAIL_OR_CALENDAR.test(text);

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|py|rs|go|java|kt|cs|cpp|cc|c|h|hpp|rb|php|swift|sql|sh|ps1|lua|vue|svelte)$/i;
/** Attachments bigger than this in total count as "large files". */
const LARGE_FILES_BYTES = 2 * 1024 * 1024;

export type RuleResult =
  | { kind: 'decide'; pick: Pick; why: string }
  /** The classifier still decides, but never below this. */
  | { kind: 'floor'; pick: Pick; why: string }
  | null;

/** Instant rules: no model call. */
export function instantRules(text: string, files: Attachment[]): RuleResult {
  const t = text.trim();
  if (!files.length && isSignOff(t)) return { kind: 'decide', pick: { model: 'sonnet', effort: 'medium' }, why: 'wrapping up' };
  if (!files.length && SMALL_TALK.test(t)) return { kind: 'decide', pick: { model: 'haiku', effort: 'medium' }, why: 'small talk' };
  // A floor, not a decision (the full review, S22; the user's pick, Q6): the gate holds what is truly
  // risky, so "how do I uninstall apps?" needn't be Opus, and a hard task with "delete" isn't capped.
  if (RISKY_VERB.test(t) && PC_THING.test(t)) {
    return { kind: 'floor', pick: { model: 'sonnet', effort: 'high' }, why: 'an action on your PC' };
  }
  const code = /```/.test(t) || files.some((f) => CODE_FILE.test(f.name));
  const large = files.reduce((sum, f) => sum + f.size, 0) > LARGE_FILES_BYTES || t.length > 6000;
  if (code || large) {
    return { kind: 'floor', pick: { model: 'sonnet', effort: 'high' }, why: code ? 'code' : 'large input' };
  }
  if (asksForDesktopWork(t)) return { kind: 'floor', pick: { model: 'sonnet', effort: 'medium' }, why: 'work on your desktop' };
  if (asksAboutMailOrCalendar(t)) return { kind: 'floor', pick: { model: 'sonnet', effort: 'medium' }, why: 'your mail or calendar' };
  return null;
}

/** Words that start a new task rather than continue the current one. */
const NEW_TASK =
  /\b(new (task|question|topic)|different (thing|question)|something else|unrelated|now (write|build|make|create|find|research|plan))\b/i;

/** Asking for real work ("now add tests for it", "fix the login bug"), not just reacting to the last answer. */
// "re" in front counts too, and "tests": "redesign the engine … with full tests" was missed (the full
// review, S17). No plural "-s" on the rest: "does it look right?" isn't new work.
const WORK_REQUEST =
  /\b(?:re)?(do|build|implement|fix|add|make|write|create|refactor|change|update|remove|rename|design|research|plan|review|debug|analy[sz]e|compare|set up|install|migrate|rewrite|test|tests|optimi[sz]e|convert|generate)\b/i;

/** A message that asks for work on its own, so a cheap pick from small talk mustn't carry over to it. */
export function asksForWork(text: string): boolean {
  const t = text.trim();
  return t.length > 25 && WORK_REQUEST.test(t);
}

/** How long a tab's last decision counts for follow-ups. */
export const FOLLOWUP_WINDOW_MS = 20 * 60 * 1000;

/** A short reply in an ongoing task reuses the previous decision instead of asking the classifier. */
export function isFollowUp(text: string, files: Attachment[], lastAt: number | undefined, now = Date.now()): boolean {
  if (lastAt === undefined || now - lastAt > FOLLOWUP_WINDOW_MS) return false;
  const t = text.trim();
  return !files.length && t.length > 0 && t.length <= 160 && !NEW_TASK.test(t);
}
