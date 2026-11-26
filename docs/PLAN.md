# Harv: build plan

The current state: what's built, decided and open. Code and tests refer to the § numbers below, so keep them.

Status (release 1), for Harv to know: **You're a fresh install of Harv.** Everything below is built and working: chats in tabs with the Auto router, the safety gate, memory, projects, the stats panel, the watchdog, the terminal, the file explorer, the shared browser, scheduled tasks, voice, desktop control and Gemini pictures. What the user turns on is in Settings; ask them before assuming an extra (voice, desktop control, pictures) is set up. **Dev detail:** this release was cut from a private build: the phone app, device sync, the LED strip and Linux desktop control are not in it; leftover comments that name those (§6m, §6n, §6q phone parts, §6z) point at nothing here.

## Open now

This is the one list of what is left. **Update it in the same commit that builds, drops or decides an item**, and before reporting "what's next" check each line against `git log` and the code.

**Next:** nothing picked. Ideas: hands-free voice (end-of-speech detection, a wake word), a speed round for desktop control and the shared browser, a free local image generator on the GPU.

**Keeping this file short:** the top of this file holds only the newest three status lines (Harv's `recentWork()` reads three). Each status line starts with what Harv should know (~400 characters), then `**Dev detail:**` and anything only developers need. When a new one is added, move the oldest one out (to a `docs/PLAN-history.md` if you want to keep it). Each § below says what is built and decided now, in a few lines.

## 1. Can Harv run on a Claude subscription?

Yes, for personal use on your own computers ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)): plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK". The terms also say third-party apps may not offer Claude.ai login to *other* people unless approved: Harv is something you run yourself, on your own login. Re-read the terms before relying on this; they change.

Rules Harv follows: personal use only, never hosted or shared; login only through Claude Code's own flow (Harv never reads or stores tokens, `~/.claude/.credentials.json` is blocked); the Claude Code binary unmodified; branded "Harv", never "Claude Code"; no 24/7 loops hammering the plan; the SDK gets an explicit `env` without `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`; a `rejected` rate-limit event pauses Harv until the reset, never buys anything.

## 2. Key technical findings

- Engine: `@anthropic-ai/claude-agent-sdk`, one streaming-input `query()` per tab; `setModel()` and `applyFlagSettings({ effortLevel })` change model and effort mid-session with context kept; `resume` reopens chats; `interrupt()` stops.
- Safety: `PreToolUse` hook (allow/deny/ask, `updatedInput`) plus `canUseTool` as a backstop.
- Plan usage: `/usage` as a prompt returns a `usage_report` (session and weekly percent, reset times, `extra_usage.is_enabled`) for 0 tokens; `rate_limit_event`s update it live. Experimental shape: parse defensively.
- Hardware: LibreHardwareMonitor's web server (127.0.0.1:8085, needs admin) is the main source; `systeminformation` (slow on Windows) for processes and volumes; `nvidia-smi` as the GPU fallback.

## 3. Architecture

npm workspaces, TypeScript strict, Vitest, ESLint + Prettier. `apps/server` (Fastify + ws, Agent SDK sessions, router, safety gate, metrics, usage, SQLite via `node:sqlite`), `apps/web` (React + Vite + Tailwind, Mission Control Glass), `apps/desktop` (Tauri 2 app, §6p), `packages/shared` (the WebSocket protocol). The dashboard talks to the server over one WebSocket. Harv's own data lives in `~/.harv/` (workspace, backups, `harv.db`, settings, memory, logs). Code map: CLAUDE.md "Code layout" (short) and `docs/CODE-MAP.md` (detail).

## 4. Safety gate

Every tool call goes `PreToolUse` → `safety/classify.ts` → **never / ask / run** (in code the tiers are blocked / red+`ask` / green·yellow·red); the reasoning is `docs/brief/brief.md`.
- **Never (three hard stops):** per-token billing; the *contents* of login secrets (names and listings are fine); wiping the system (the system disk by `safety/disks.ts`, `rm -rf /` or `~`, a drive root). A disk Harv can't identify is never too; any other disk asks.
- **Ask = held in the chat** (`gate.ts` `hold`, `safety/judge.ts`): antivirus, firewall, system folders, the read-only list, Harv's data, Claude Code's history, persona rule 17's list (`ASK_LIST`: uninstall, drivers, registry, services, kill, elevated except installs, force push / remote deletes, another author), sending nobody asked for, risky desktop steps, hidden-code scripts. **Like Claude Code's auto mode**, the job the user asked for in their recent messages is the yes for the steps it plainly needs (`askedOutright`, `TASK_PROMPT`: one Haiku call that answers `covered`; a broad goal doesn't cover system changes Harv picked himself; a hand-off or a computer that isn't the user's needs an outright request). Otherwise one gate line names the exact call; the user's next message is read (rules, one Haiku call when unclear); a yes grants exactly that call once. Yes / No buttons under the held steps answer without a judge call. Unattended turns hold for the report.
- **Run:** everything else, backed up where files change, logged, Undo; local git rewrites back up `.git` first (`Verdict.keep`). No approval cards except `format_drive`, questions and plans.
- **The user's other computers:** commands sent over ssh are judged with that computer's paths; on the computers in Settings › Safety › My other computers, copying files there isn't sending and a job asked for there covers its steps.
- **USB drives:** `list_drives`/`format_drive` (`tools/drives.ts`): USB only, never boot/system, name must match, always a card.
- Held actions are kept in `harv.db` (`held` table) and survive a restart; a yes is never kept.

## 5. Auto router (model + effort)

Pipeline: instant rules → a cheap Haiku classifier → the table → escalation → the log. Every reply is tagged `[model·effort]` with the reason on hover. Tuned for Claude Pro (quality first, usage second). Code in `apps/server/src/router/`; any change needs `router.test.ts` cases.

- **Ladder:** haiku·medium → sonnet·medium → sonnet·high → opus·medium → opus·high → opus·xhigh → opus·max (Fable steps only with Settings › AUTO › Allow Fable, which needs paid credits on Pro: off).
- **Rules:** `/opus`, `/sonnet`, `/haiku`, `/low`…`/max` at the start of a message; small talk → haiku·medium; a risky verb plus a PC object → at least sonnet·high; code or large input → at least sonnet·high.
- **Classifier:** one Haiku·low turn, no tools, 20 s timeout: category, difficulty 1–5, stakes, a chat title and summary, the skill that fits, the memory notes the topic needs. On failure sonnet·medium.
- **Table:** d1–2 haiku·medium, d3 sonnet·medium (sonnet·high for code), d4 opus·medium, d5 opus·high; high stakes one step up, never above opus·medium; research gets sonnet·high at d2–3. Above ~70% weekly usage, d1–3 are trimmed, never below haiku·medium.
- **Follow-ups:** a short message within 20 min reuses the task's decision; new work in the task is classified again but never drops below the task's pick.
- **Escalation:** "↑ try harder" (one step); `StruggleWatch` steps an AUTO reply up mid-reply on failing tests/builds or repeated failed calls (twice at most, never past opus·high, never the user's own pick); a reply that ends well drops the task back.
- **Log:** `routes` table in `harv.db` (model, effort, reason, category, tokens, notional cost, feedback).

## 5b. Plan usage meter and limits

`usage/meter.ts`: `/usage` at start, every 2 min while chatting, 10 min idle, and after turns; live `rate_limit_event`s in between. Warnings at the Settings marks (75/90/95% session, 75/90% weekly). A limit pauses Harv: new messages queue, a cut-off turn queues a "continue", and after the reset the queue runs in order (the resume checks the wall clock every 30 s, so a laptop that slept through the reset still comes back). Near the session's end `usage/budget.ts` adds notes: from 75% say when a big task may not fit, from 90% start nothing big and stop cleanly. **Cost guide:** each turn's notional cost and the meter's readings give `plan_usage` a guide (% of the session per reply on each model), which Harv uses to estimate a plan's usage as a range.

## 6. Milestones

The dashboard, the hardware panel, chat on the subscription, tabs + history + persona + memory, files, the safety gate, the Auto router, the usage meter, settings, and the desktop app (§6p) are built.

## 6b. Harv's identity: one set of behaviours

`harv/persona.md` (no personal data) is loaded into every chat and followed by dev sessions in Claude Code; `harv/dev-rules.md` in project chats; `~/.harv/memory/` holds the private facts (scoped `remember`/`recall`/`forget` tools), loaded by topic: core notes in full in every chat, an index of the rest, a note's full text added to a message when its topic comes up (`agent/memory.ts`). The newest status lines of this file reach every chat as "Recent work on you" (`harvSelf.ts`).

## 6c. One Harv across tabs

Every tab is its own session, all the same Harv: persona and memory in each, a note when another tab changed memory, the 10 most recent other chats in the prompt (each with a one-line summary from the classifier), `list_chats`/`read_chat` over the history, `hand_off` to run a task in another or a new tab.

## 6d. Tools inside each chat: terminal, files

The chat bar's view switch shows a chat's log, File Explorer, Terminal or Browser (§6x). Terminal: PowerShell in node-pty + xterm.js, scrollback restored; Harv's `terminal_run`/`terminal_read` type into a Terminal tab of the chat's own. File Explorer: works like Windows 11's, Recycle Bin, drag and drop. Tabs, views, folders and drafts come back after a restart (`~/.harv/ui.json`).

## 6e. Settings

`HarvSettings` (`packages/shared/src/settings.ts`), cleaned field by field on every read (`server/src/settings.ts`), edited in `SettingsView.tsx`: Look (background, accent, size, glass, blur, motion), Chat, AUTO, Stats panel, Usage warnings, Default folder, Safety (read-only folders, backups, My other computers), Startup, Projects, What Harv can do (desktop control, voice, pictures, watchdog, scheduled tasks), This computer.

## 6f. Project mode: Harv as Claude Code

A chat bound to a project runs with the `claude_code` system prompt preset plus Harv's append (persona, project notes, `harv/dev-rules.md`, memory), `cwd` = the project, `settingSources: ['user', 'project', 'local']`. Tools: `start_project` (folder, `git init`, starter CLAUDE.md, a GitHub repo: always ask private or public), `open_project`, `list_projects`, `remove_project`, `project_status`. A code map of each project is kept in `~/.harv/codemaps/` (`agent/codeMap.ts`). Inside the folder only the risky kinds ask.

## 6g. Running Harv day to day

`npm run harv` (server without auto-restart + Vite), driven by `scripts/harv.ps1` (`harv.sh` on Linux) `start|stop|restart`; Settings › Startup › Restart Harv calls `POST /api/restart`. Chats work like Claude Code: `/name` runs Claude Code commands and skills (billed or terminal-only ones refused), `/btw`, `/report`, `/fresh`, `/clear`, `/plan`, `/rewind`; thinking shows folded; messages sent mid-reply go in at the next tool step (§6ac).

## 6i. The user's Claude Code setup in chats

Every chat loads the user's Claude Code settings: skills, plugins, claude.ai connectors. The gate judges the known connectors tool by tool (`safety/connectors.ts`): reads run; the user's own changes run; mail out, invites and shares follow the sending rule; deleting for good and public links are asked.

## 6j. PC watchdog

"Not annoying": long background CPU/GPU hogs (programs without a window), overheating, Windows Defender detections and status, known miners, programs from Temp. Every alert needs a lasting condition and a cooldown. No Claude usage. Code: `apps/server/src/watchdog`.

## 6m, 6n. Several devices, project sync

Not in this build.

## 6p. The Harv app

A Tauri 2 frameless window loading the dashboard from :4316, tray with status icons, Ctrl+Alt+H, notifications when not in front, updates by `git pull`; it starts Harv with `harv.ps1` or attaches. `dragDropEnabled` stays false. Settings › App › "Open Harv when I log in" (off by default).

## 6q. Voice

Whisper on this computer hears (Settings › What Harv can do › Voice; the mic in `harv>`, or hold Ctrl+Alt+Space anywhere, sent when let go); the `transcribe` tool hears audio files; Piper speaks Harv's reply after a spoken message (English). The phone app of the original build is not in this release.

## 6r. Attaching by path

Files and folders on the PC are attached by path (the ATTACH menu, `@` in `harv>`, the explorer's Send to chat). The gate trusts them in that chat like a project folder, but yellow. Uploads go to the workspace.

## 6s. Everything claude.ai and Claude Code can do

Every chat has Claude Code's full toolset; a side preview pane (HTML sandboxed, SVG, Mermaid, pictures, PDFs, Markdown), rich text, question and plan cards, rewind with file checkpoints, scheduled tasks (`apps/server/src/schedule`, run in the chat that made them).

## 6t. Desktop control

Windows-MCP **0.8.8** pinned and reviewed, in `~/.harv/windows-mcp/venv`, the MCP server `desktop`; telemetry always off; an allow-list of 16 tools (never its own shell, file, registry, process or web tools); started through `tools/windows_mcp_quiet.py`. Gate (`safety/desktop.ts`): looking runs; acting runs, except a risky action (Send/Buy/Delete, Enter in a message box, a password or card field) the message didn't ask for. While Harv acts: his pill (topmost, out of screenshots, STOP) over a soft glow around that monitor; his window steps aside and comes back. One monitor (Settings › Works on); windows Harv opens move onto it. Windows-MCP refuses to act within 10 s of real input.

## 6u. Polish

Done as review passes over the look and settings; nothing open.

## 6w. Image generation through the Gemini website

`generate_image` drives the free Gemini website in a headless Chrome on `~/.harv/gemini-profile` (the user signs in once, Settings › What Harv can do › Pictures); pictures go to `~/.harv/workspace/images`; the `image-prompt` skill writes the prompt.

## 6x. A browser in the chat window

Real web views the app places over a chat's Browser view (`src-tauri/src/browser.rs`, one browser per computer shared by every chat); Harv's `browser_*` tools reach it through the dashboard (`tools/harvBrowser.ts`, `browserHost.ts`), judged by `safety/browser.ts`. The 3 most recent tabs stay live, older ones sleep; downloads go to Downloads and the step that caused them says where; dropdowns and file upload work; a page that refuses Harv's fetch opens there instead.

## 6z. The LED strips

Not in this build.

## 6ab. Skills

Harv uses fitting skills by himself and mentions them in passing; the router's classifier names the skill a new task fits (`agent/skillMap.ts`). Harv's own skills are in `harv/skills/` (diagnose, deslop, ui-check, learn-from-session, image-prompt, video, google, figma-templates, clone, resolve, prompt-writer, skill-finder), copied to `~/.claude/skills` on every start. A skill from outside is installed only after a review (`skill-finder`) and the user's OK; no paid services.

## 6ac. A message sent mid-reply goes in at the next step

A message sent while Harv works waits in the queue (editable, "send now") until the reply's next tool step, then goes in. Words spoken mid-reply go into the running reply too. "Start a new chat and …" opens a new chat by rule, with the whole sentence as its first message.

## 6ad. Presence notifications

Harv's own notices go through his presence: in the app a one-line bubble from his face (warnings amber and stay, normal ones fade), outside the app the pill says the line; levels urgent / warning / normal, a queue with repeats merged, two code-made sounds (Settings › Appearance › Notifications), silent while a full-screen app is in front; today's notices under the header logo.

## 6ae. Outside skills and tools

Reviewed and built in: a code map per project, sound effects for Resolve (`resolve/scripts/sfx.py`), colour-correction LUTs (`grade.py`), hearing audio (`ears.py`), watching reels and videos (`video` skill: frames + Whisper), video report pages.

## 6af. Smaller items

`scripts/ui-check/smoke.mjs` runs every free check in one report; `docs/review/test-scenarios.md` lists every feature with what to do, what should happen and the cost.
