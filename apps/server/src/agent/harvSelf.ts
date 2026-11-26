import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARV_HOME } from '../paths.ts';

// Harv knowing itself (the user's wish, 2026-10-31: "all about him, all the logs, history and
// everything"): where its code, logs, database and settings are, and a read-only look into its
// database (the chats, every routing pick, every action it took).

/** The Harv repo on this computer (this file is apps/server/src/agent/harvSelf.ts). */
export const HARV_REPO = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]$/, '');

const DB_ROWS = 200;
const DB_CHARS = 12_000;

/**
 * What was built and decided lately (the user's wish, 2026-11-01: "make it so that Harv also
 * remembers everything we talk about"): Harv is developed in Claude Code sessions, and each one
 * ends with a status line at the top of docs/PLAN.md, so the newest few go into every chat. A git
 * pull brings them to the other computer too.
 */
export function recentWork(plan = join(HARV_REPO, 'docs', 'PLAN.md'), count = 3, max = 1500): string {
  if (!existsSync(plan)) return '';
  const lines = readFileSync(plan, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('Status ('))
    .slice(0, count)
    // A status line's dev detail (after "Dev detail:") stays in the plan: every chat pays for what it
    // carries (the full review, K20: ~800 tokens of file splits and smoke scripts per chat).
    .map((l) => l.split(DEV_DETAIL)[0]!.trim())
    .map((l) => `- ${l.length > max ? `${l.slice(0, max)}…` : l}`);
  if (!lines.length) return '';
  return [
    '## Recent work on you',
    "The newest status lines of your plan (docs/PLAN.md), written at the end of each session the user and Claude Code spend building you: what you can do now and what was decided. The plan has the current state of each feature, docs/PLAN-history.md the full history, and those sessions' own notes are in ~/.claude/projects (the Harv repo's folder).",
    ...lines,
  ].join('\n');
}

/** Where a status line's part for Harv ends and the developers' detail begins. */
const DEV_DETAIL = /\s*\*\*Dev detail:\*\*|\s*Dev detail:/;

/** The prompt section: what Harv is made of and where everything about it lives. */
export function selfContext(): string {
  return [
    '## About yourself',
    [
      `- Your code is the Harv repo at ${HARV_REPO} (docs/PLAN.md is the plan: the current state of every feature, docs/PLAN-history.md its full history, CLAUDE.md the short map of the code and its rules, docs/CODE-MAP.md the detailed map, harv/persona.md your rules). Read it to answer how you work; changing its code is project work (open_project "Harv"), while a lesson may edit your rules, dev rules and skills (harv/persona.md, harv/dev-rules.md, harv/skills) from any chat (learn-from-session).`,
      // 2026-11-05: a chat wrote its Resolve lessons into the installed copy and the next start wiped them.
      `- Your own skills (diagnose, resolve, video, clone…) come from ${join(HARV_REPO, 'harv', 'skills')}/<name>; the copy in ~/.claude/skills/<name> is replaced on every start, so a lesson or fix for one of them goes into the repo's file (same path under harv/skills), never into the copy.`,
      `- Your data is in ${HARV_HOME}: harv.db (the database, read it with harv_db), logs/ (harv.log is this run's server log, harv.previous.log the run before, harv-script.log every start/stop/restart, app.log the desktop app), settings.json (Settings), ui.json (open tabs and drafts), memory/ (your memory), backups/ (one folder per backed-up action), terminals/ (saved terminal output), watchdog.json, sync/ (the sealed sync repo shared with the user's other device), workspace/ (your files).`,
      "- Read all of it freely. Changes go through your own tools and the user's Settings, never by editing those files: remember/recall/forget for memory, open_project/remove_project for the project list, Settings for settings (your safety settings are the user's alone). When no tool covers a change the user asks for, say so in one line and note it with report_note instead of refusing flatly. The keys in there (the browser profiles and any login a tool keeps) are never read.",
      '- Your own Claude Code sessions are in ~/.claude/projects too (normal chats run in the workspace folder, project chats in the project folder).',
      // The user's report, 2026-11-01: a chat said automatic lights didn't exist. New features are
      // built in Claude Code, so this list is how a chat knows they're there.
      "- What you do by yourself, outside any chat (built into your server, each with its Settings section): the PC watchdog (overheating, hogs, Defender, miners: toasts), scheduled tasks (schedule_task), plan usage meters with warnings and a pause at the limit, image generation through Gemini, a shared browser and per-chat terminals, desktop control with your pill at the top of the screen, and your presence in the chat (the hammock with your face while you work, notices from it). Before saying something like this doesn't exist, check its tool, Settings or docs/PLAN.md.",
      // The full review, K22: nothing lasting said he can hear and speak, so he'd deny it once the status lines rolled on.
      "- You hear and speak (Settings › What Harv can do › Voice): the user talks to you with the mic button in harv> (the words wait in the line), or by holding Ctrl+Alt+Space anywhere (sent when let go). Whisper on this computer hears it; the transcribe tool hears audio files. After a spoken message you answer aloud too, in English only for now (a Slovak voice is parked).",
    ].join('\n'),
    recentWork(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** harv_db: a read-only SQL query on harv.db, or its tables when no query is given. */
export function queryHarvDb(sql: string | undefined, file = join(HARV_HOME, 'harv.db')): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!sql?.trim()) {
      const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as {
        name: string;
      }[];
      return tables
        .map(({ name }) => {
          const cols = (db.prepare(`pragma table_info("${name}")`).all() as { name: string }[]).map((c) => c.name).join(', ');
          const { n } = db.prepare(`select count(*) n from "${name}"`).get() as { n: number };
          return `${name} (${n} rows): ${cols}`;
        })
        .join('\n');
    }
    if (!/^\s*(select|with|pragma\s+table_info)\b/i.test(sql))
      return 'Only reading queries (SELECT, WITH, PRAGMA table_info): harv_db never changes the database.';
    // It runs on the server's only thread: an endless WITH RECURSIVE would freeze Harv (the full review, D22).
    if (/\brecursive\b/i.test(sql))
      return 'harv_db takes no WITH RECURSIVE queries (one that never ends would freeze Harv): query the rows directly.';
    // Row by row, stopping at DB_ROWS: `select * from lines` read the whole table first (the full review, K27).
    const rows: unknown[] = [];
    for (const r of db.prepare(sql).iterate()) {
      rows.push(r);
      if (rows.length >= DB_ROWS) break;
    }
    if (!rows.length) return 'No rows.';
    const out = rows.map((r) => JSON.stringify(r)).join('\n');
    return out.length > DB_CHARS ? `${out.slice(0, DB_CHARS)}\n[…cut at ${DB_CHARS} characters: narrow the query]` : out;
  } catch (err) {
    return `Query failed: ${(err as Error).message}`;
  } finally {
    db.close();
  }
}
