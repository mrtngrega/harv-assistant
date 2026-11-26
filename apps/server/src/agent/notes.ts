import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { loadSettings } from '../settings.ts';

// Harv's notes files, both synced between the user's devices (sync/engine.ts SHARED_FILES):
// harv_report.md (the user's /report and Harv's report_note: bugs and wishes) and harv_skills.md
// (Harv's reviews of skills, tools and reels, report_note with skill_review).

/** The top of harv_skills.md when Harv writes its first review. */
const SKILLS_HEADER =
  "# Harv skills\n\nHarv's reviews of skills, tools and reels you sent (report_note with skill_review). The short list of bugs and wishes stays in harv_report.md.\n\n";

/** One /report note for harv_report.md: `- [25 Oct 13:05 · PC · chat name] text`, on one line. */
export function ideaLine(text: string, at: Date, device: string, chat: string): string {
  const day = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `- [${day} ${time} · ${device} · ${chat.replace(/\s+/g, ' ').trim()}] ${text.replace(/\s+/g, ' ').trim()}`;
}

/** Appends one dated note to `file` and says so in a line for the chat (or why it couldn't). */
export function appendNote(file: string, skills: boolean, text: string, chat: string): string {
  const name = skills ? 'harv_skills.md' : 'harv_report.md';
  try {
    if (skills && !existsSync(file)) appendFileSync(file, SKILLS_HEADER, 'utf8');
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const line = ideaLine(text, new Date(), loadSettings().deviceName || hostname(), chat);
    appendFileSync(file, `${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`, 'utf8');
    return `Noted in ${name}.`;
  } catch (err) {
    return `Couldn’t write ${name}: ${(err as Error).message}`;
  }
}
