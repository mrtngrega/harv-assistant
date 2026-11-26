# CLAUDE.md

This file guides Claude Code when it works in this repository.

## Project

Harv is a personal AI assistant in the spirit of Jarvis: a local dashboard and a desktop app on Windows, running on your own Claude subscription through Claude Code.

- **`docs/PLAN.md`**: the current state (what's built, decided and open), one § per feature. Read it at session start and before any feature; keep it short and true. Code comments refer to its § numbers, so keep them.
- **`docs/CODE-MAP.md`**: the detailed code map. Read the part for an area before changing it; update it with the code.
- **`docs/GOTCHAS.md`**: traps that already cost time (Windows shells, WebView2, the Agent SDK, Vite). Read the matching part before debugging.
- **`docs/SETUP.md`**: installing Harv on a new computer (the `harv-setup` skill, `.claude/skills/harv-setup/`, walks through it; "set up Harv" again changes answers or adds an extra). `docs/GUIDE.md` is the tour for the user.
- **`starter/`**: the first notes the setup copies: `harv-memory/` → `~/.harv/memory`, `claude-memory/` → this repo's Claude Code memory. Rules only, no personal data. `harv/outside-skills/` holds other authors' skills (each with its LICENSE), copied to `~/.claude/skills` by the setup.

Stack: TypeScript everywhere, npm workspaces. `apps/server`: Node 24, Fastify, ws, `@anthropic-ai/claude-agent-sdk`, systeminformation, nvidia-smi, LibreHardwareMonitor, SQLite (`node:sqlite`). `apps/web`: React, Vite, Tailwind v4. `apps/desktop`: the Tauri 2 app (Rust).

## Harv's identity: same rules for you

**The behaviour taught in dev sessions IS Harv.** `harv/persona.md` is Harv's rulebook: the running Harv loads it into its system prompt, and you follow it too.
- A behaviour rule that applies to Harv generally goes into `harv/persona.md`. Rules for dev work on any project (testing, wrap-up, build first…) go in `harv/dev-rules.md`, which Harv loads in project chats. Dev-only rules for this repo stay here.
- **The newest three status lines at the top of `docs/PLAN.md` reach every Harv chat** as "Recent work on you" (`recentWork()` in `harvSelf.ts`: the part before `**Dev detail:**`, 1500 characters at most). Write them for Harv too: what was built, what the user decided, what's next, in plain words.
- Harv's own skills live in `harv/skills/<name>/`, copied to `~/.claude/skills` on every start (`agent/ownSkills.ts`): edit them in the repo, never the installed copy.
- Personal facts never go in the repo: they live in `~/.harv/memory/*.md`, which Harv changes only through its `remember`/`recall`/`forget` tools (`agent/memory.ts`). Each note keeps its header (`about`, `keys`, `always`, `updated`).
- Skills: Harv's (`harv/skills`) and the outside ones the setup installed are in `~/.claude/skills`, so you have them here too. The user never calls skills by name: use a fitting one by yourself and say which (persona rule 12).

Harv's rulebook and dev rules, loaded into every session here (Claude Code imports): where they name Harv's own tools (`remember`, `hand_off`, the gate's held steps), use your own equivalents: memory files, the user's yes in the chat.

@harv/persona.md

@harv/dev-rules.md

## Design: "Mission Control Glass"

- IBM Plex Mono throughout.
- A photo of the user's choice, blurred, behind a dark scrim `rgba(10,16,24,0.55)`. Frosted glass panels `rgba(16,24,34,0.5)`, 22px blur, thin light border. Accent ice blue `#A8C8E8`; amber `#F2B880` for warnings at 85% or above.
- Header: the model switcher with **AUTO** first; each reply's `[model·effort]` tag says what AUTO picked. Harv's status is a Claude Code-style line above the `harv>` prompt (`StatusLine.tsx`).
- Left: a collapsible chat history. Center: Chrome-style chat tabs over a log-style chat, attachment chips and a `harv>` command line. Right: a stats panel that starts narrow and expands to show everything, including Claude plan usage.
- Subtle animations, with a switch to turn motion off.

## Auto router

Auto picks model and effort for each task: the best result first, saving usage second. Pipeline: instant rules → a cheap Haiku classifier (which also names the skill a new task fits, `agent/skillMap.ts`) → a lookup table → escalation ("Try harder", automatic step-up) → logging. Tuned for Claude Pro. Spec: `docs/PLAN.md` §5. Any change needs `router.test.ts` cases.

## Hard constraint: subscription only, never anything billed

Harv runs only on the user's Claude subscription, through the Claude Agent SDK / Claude Code login.

- Never use an Anthropic API key or the API's billing: no Messages API, Admin/Usage API, Managed Agents, or any paid third-party service.
- Keep `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset in Harv's process environment (`env.ts` strips them at startup; keep it first). If either is set, Claude Code bills per token.
- No paid fallbacks. When plan limits run out, Harv pauses, shows the reset time, and queues work.
- Every model call counts against plan limits, the router's Haiku classifier included. Keep overhead calls cheap and rare.

## Terms

Harv is for personal use on your own computers with your own Claude login: never host it, never share a login, never read or store Claude credentials, keep the Claude Code binary unmodified, and brand it "Harv", never "Claude Code". Anthropic's terms for apps that use a subscription login can change: read them (`docs/PLAN.md` §1).

## Environment

- Windows 10/11; PowerShell and Git Bash both work. Node.js 24, Python 3.12+, Rust for the app. Default branch `main`.
- Nothing loads a `.env`. If a local secret is ever needed, it goes in a gitignored `.env` and only a `.env.example` with the names is committed.
- Shell gotcha: Git Bash heredocs (even `<<'EOF'`) and `node -e` strings can eat backslashes, silently changing Windows paths and `\\n`. Write scripts with the Write tool, or use forward slashes. `.claude/settings.json` has a PreToolUse hook (`scripts/heredoc-guard.mjs`) that refuses a heredoc with a backslash, plus a plan-usage status line (`scripts/statusline.mjs`).
- New npm packages with install scripts are blocked by npm's allowScripts. Review a package before `npm install-scripts approve <pkg>` (esbuild is approved).

## Hardware sensors

- LibreHardwareMonitor (`winget install LibreHardwareMonitor.LibreHardwareMonitor`) with its web server on `127.0.0.1:8085`, minimized to the tray. It must run as admin to read sensors. Optional: without it the stats panel shows less.
- **Harv starts LHM, not Windows**: `metrics/lhmLauncher.ts` launches it elevated on server start (a UAC prompt); Settings › Startup › "Start the hardware sensors" off (or `HARV_START_LHM=0`) skips it; `HARV_LHM_PATH` overrides the exe path.
- Never create logon tasks or other autostart entries yourself. The only one is the user's switch: Settings › App › "Open Harv when I log in".
- http.sys listens on all addresses, so add an inbound firewall rule that blocks remote access to port 8085.

## Network exposure

Harv listens on localhost only. Never expose a port beyond it.

## DaVinci Resolve (the `resolve` skill)

- Tested with free **Resolve 21.1.0.17**. **Never update Resolve**: from 21.1.1 on, the free Console's Lua lost `dofile`/`io`/`ffi` and Harv's bridge can't answer. See `harv/skills/resolve/`.
- Test in a throwaway project, never the user's; Studio-only calls open a blocking dialog.

## Developing Harv while it runs

- `npm run harv` runs Harv: the **server doesn't auto-restart**. `apps/web` changes show at once (Vite hot reload). `apps/server` and `packages/shared` changes need a restart: finish, run the checks, commit, then `POST /api/restart` with the dashboard's Origin or `scripts/harv.ps1 restart`, and verify after it. Never restart while a chat is mid-reply (`node scripts/ui-check/busy.mjs` says whether one is).
- Editing a web module that isn't a React component (e.g. `apps/web/src/lib/*.ts`) makes Vite **reload the whole dashboard page**: it looks like a restart, but the server keeps running (real starts are logged in `~/.harv/logs/harv-script.log`).
- Saving `apps/web/vite.config.ts` restarts the running Vite at once. Change the port, the proxy or `allowedHosts` only together with the server, the app and a restart.
- Vite's watcher on Windows sometimes misses a change: check what it serves (`curl -s http://127.0.0.1:4316/src/<file>`); `touch` the file, else restart Harv.
- **Inside a Harv chat working on Harv** (a project chat), the chat runs inside the Harv it changes: never stop or restart Harv there (no killing node/tsx/vite, no ports 4317/4316, no `scripts/harv.ps1`, `npm run dev` or `npm run harv`); ask the user to press **Settings › Startup › Restart Harv**.
- Verify without restarting where you can: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `node scripts/ui-check/…` against the running dashboard (`scripts/ui-check/README.md`). `node scripts/ui-check/usage.mjs` shows the plan meters.
- **Verify every UI change in the app, not only in a browser.** Launch it with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9444` (never 9333, which `launch()` in `scripts/ui-check/cdp.mjs` uses) and drive it with `attach()` from `cdp.mjs` (`app-look.mjs`, `app-chat.mjs` (with `MSYS_NO_PATHCONV=1` in Git Bash, or `/model` turns into a path), `app-startup.mjs`, `app-tabs.mjs`, `app-pass.mjs`). CDP screenshots leave out the shared browser and the pill (out of captures by design): capture the screen, or check the pill with `EnumWindows`.
- OS-specific code asks `platform.ts` (`IS_WINDOWS`, `osPath`, `pathKey`, `OS_NAME`); OS-specific tests use `it.runIf`. The core also runs on Linux (`scripts/harv.sh`), without desktop control there.

## Commands

- `npm run harv`: how Harv normally runs (server without auto-restart, plus the dashboard). `scripts/harv.ps1 start|stop|restart` drives it; stop asks the server to shut down (`POST /api/shutdown`) before cleaning its ports. Logs in `~/.harv/logs`.
- `npm run dev`: server (tsx watch, http://127.0.0.1:4317) and web (Vite, http://127.0.0.1:4316, proxying `/api` and `/ws`).
- `npm test` (Vitest across workspaces; one file: `npx vitest run apps/server/src/env.test.ts`; one test: `npx vitest run -t "removes API credentials"`), `npm run typecheck`, `npm run lint`, `npm run format` (rewrites the whole repo: prefer `npx prettier --write <your files>`).
- `npm run build`: builds the dashboard (the server runs from TypeScript via tsx, no server build).
- `npm run app`: builds the desktop app into `apps/desktop/src-tauri/target/release/` (`harv.exe` and `bundle/nsis/Harv_*_x64-setup.exe`). Needs Rust (`~/.cargo/bin`). The app attaches to a running Harv, so testing it restarts nothing; its tray Restart/Quit do. Log: `~/.harv/logs/app.log`. Rust checks: `cargo clippy` and `cargo fmt` in `apps/desktop/src-tauri`.
- Stopping a background `npm run dev` on Windows can leave orphaned `tsx`/`vite`/`node` children holding ports 4317/4316: check `netstat -ano | grep -E ":(4317|4316)"` and kill those PIDs by tree. Never kill the user's `claude.exe`.

## Code layout

One line per area; **`docs/CODE-MAP.md` has the detail: read its part before changing an area.**

- `packages/shared`: the WebSocket protocol (`ServerMessage`/`ClientMessage`), settings and metrics types, consumed as TS source.
- `apps/server/src/index.ts`: makes the services and checks every request; routes in `routes/` (files, devices, system), `/ws` in `ws.ts`. It refuses a foreign `Origin`, `Sec-Fetch-Site: cross-site/same-site` and a foreign `Host`; dashboard messages are shape-checked (`wsInput.ts`) and a throwing handler is logged, never fatal.
- `agent/`: one `ChatSession` per tab (a long-lived streaming `query()`), `manager.ts` (tabs, status, queue, router, hand-off, rewind, project mode), `options.ts` (every query's options: env without API key, cwd `~/.harv/workspace`, Claude Code's tools, the user's setup, Harv's prompt and tools, the gate's hooks), `chatTools.ts` (Harv's `mcp__harv__*` tools), `skillMap.ts`, `harvSelf.ts`, `btw.ts`, `tasks.ts`, `attachments.ts`, `projectLink.ts`/`projectRepo.ts` (projects and their GitHub repos). A session refuses to run unless `apiKeySource` is `none`/`oauth`.
- `router/`: the Auto router (`rules`, `classifier`, `table`, `router`, `struggle`); `store/routes.ts` logs every turn and its cost (the cost guide in `plan_usage`).
- `safety/`: the permission gate (`classify.ts` with `base`/`shell`/`sensitive`/`sending`/`readOnly`/`project`, `gate.ts`, `judge.ts`, `backup.ts`, `desktop.ts`, `browser.ts`, `secrets.ts`, `remote.ts`); `store/actions.ts` the action log. Any change needs `classify.test.ts`/`gate.test.ts`/`judge.test.ts` cases; when the gate can't see what a delete or disk command touches, it asks or refuses.
- `metrics/`: LHM (main; values are locale-formatted, always `parseLhmValue`), systeminformation (slow on Windows: processes, volumes, fallback), nvidia-smi fallback; `metrics.tick` every ~1 s; missing sources leave fields undefined and the UI hides them.
- `usage/meter.ts`: plan usage from `/usage` plus live rate-limit events, warnings, the pause and the queue; `usage/budget.ts` the notes near a session's end.
- `store/chats.ts`: chat history in `~/.harv/harv.db`; `settings.ts` (`~/.harv/settings.json`, cleaned on every read), `ui.ts` (`~/.harv/ui.json`, the saved layout), `background.ts` (the user's photo, `~/.harv/background.*`, never commit it).
- `tools/`: per-chat terminal (`terminal.ts`), file explorer (`files.ts`, `fileOps.ts`), Gemini images (`chrome.ts`, `gemini.ts`), the shared browser (`harvBrowser.ts`, `browserHost.ts`), desktop control (`windowsMcp.ts`, Windows-MCP **0.8.8** pinned: a newer version needs a new review), USB drives (`drives.ts`).
- `watchdog/`: the PC watchdog; keep it quiet: anything new needs a lasting condition, a cooldown and a test. `schedule/`: scheduled tasks. `voice/`: Whisper and Piper on this computer.
- `apps/web/src`: `App.tsx` (layout, look settings), `lib/socket.ts` (the one WebSocket), stores via `lib/createStore.ts` (`useHarvSocket.ts`, `chatStore.ts`), `components/chat/` (replies, cards, preview pane), `components/tools/` (views, terminal, explorer), `SettingsView.tsx` (sections in `components/settings/`). `activeId` can be `SETTINGS_TAB`: code that needs a real chat goes through `chat.ensureTab()`. Use `var(--app-h)` instead of `100vh`; the root is `overflow-clip`; set `scrollLeft` instead of `scrollIntoView` for horizontal scrolling; chat lines are memoized (`ChatLine`).
- `apps/desktop`: the Tauri app; the dashboard reaches it through `apps/web/src/lib/desktop.ts` (and `lib/browser.ts` for the browser's web views); a new app command goes in `build.rs` and `capabilities/main.json` too. `dragDropEnabled` stays false. With browser pages open, look up the window (`get_window`) and the dashboard (`get_webview("main")`) apart, never `get_webview_window`. Async commands for anything that builds a window (a sync one deadlocks on Windows); they run side by side, so never rely on their order.

## Harv's safety model

Every action Harv takes goes through a permission gate built on Agent SDK hooks (not prompt instructions), so it can't be skipped. It ends one of three ways: **never**, **ask**, **run**. Detail: `docs/PLAN.md` §4, `docs/CODE-MAP.md` "safety", the reasoning in `docs/brief/brief.md`.

- **Never (three hard stops, nothing lifts them):** per-token billing (an API key, `ANTHROPIC_*` settings); reading, copying or sending the *contents* of login secrets (Claude's credentials, browser profiles, password stores, SSH private keys, token files, `.env`, loose `*.pem`/`*.key`, a public certificate's name excepted); wiping the system (`rm -rf /` or `~`, a drive root, any format/wipe of the system disk or of a disk Harv can't identify: `safety/disks.ts`). Names and listings are not secrets. The refusal tells Harv to do the rest, never to hand the command to the user.
- **Ask (held in the chat, not a card):** antivirus/firewall changes, the system folders, the user's read-only folders, Harv's own data, Claude Code's session history, sending nobody asked for, a risky desktop step, a script that hides its code, and `ASK_LIST` (uninstalling, drivers, registry writes, services/startup/power/scheduled tasks, killing programs, anything elevated except a package install, force pushes / remote deletes / `gh|glab api` writes, committing as another author). Like Claude Code's auto mode, the job the user asked for in their recent messages is already the yes for the steps it plainly needs (`askedOutright` with the job rule, one Haiku call; a broad goal doesn't cover system changes Harv picked himself). Otherwise the gate writes one line with exactly what waits; the user's reply is read by `safety/judge.ts`, and a yes grants exactly those calls once. Turns nobody typed (scheduled, background, hand-offs) never ask: held for the report.
- **Run:** everything else, backed up where files change, logged, Undo. Local git rewrites run after a copy of the repo's `.git` and its changed files (`Verdict.keep`).
- **Other computers** (`safety/remote.ts`): what a command runs over ssh is judged as that computer's. On Settings › Safety › My other computers, copying there isn't sending and a job the user asked for there covers its steps.
- Blocks and asks count only what **runs** (`runningText`); scripts are read before they run (`scriptVerdict`); hand-offs and outside text never count as the user asking or saying yes.

Always on: a stop button with a hotkey that cancels the current action, user-defined read-only folders, and a full action log.
