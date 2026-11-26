---
name: harv-setup
description: Install and set up Harv on this Windows computer, or change an earlier setup. Use when the user says "set up Harv", "install Harv", "run the setup again", wants an optional extra added (sensors, voice, desktop control, pictures, Google apps, DaVinci Resolve), or wants to change what Harv knows about them from the setup.
---

# Setting up Harv

You are Claude Code, opened in a fresh clone of Harv. Walk the user from nothing to a running Harv app that knows a little about them. Do the work yourself: install, build, write the files. The user only does what needs a person (UAC prompts, browser sign-ins, answers about themselves). `docs/SETUP.md` is the same path for a human and the place for troubleshooting.

## Rules for the whole setup

- **Subscription only.** Harv runs on the user's Claude subscription through Claude Code's login. Never set, ask for or use an Anthropic API key. If `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set in the user's environment (`[Environment]::GetEnvironmentVariable(<name>, 'User')` and `'Machine'`), tell them: with it, Claude Code bills per token. Offer to remove it from the user environment.
- **Never read Claude's credentials** (`~/.claude/.credentials.json`) or any login secret, not even to "check the login". `claude --version` and Harv's own startup check are enough.
- **Say what you'll install before you install it**, once, as one list. On a yes, install everything on the list without asking again. Use `winget` (`--accept-source-agreements --accept-package-agreements --silent`). If an id doesn't resolve, `winget search` for it and say what you picked.
- **Shell:** use PowerShell for Windows commands. Write any script with backslashes or multi-line text to a file first. Git Bash heredocs eat backslashes.
- **Re-runs.** If `~/.harv/memory/user-profile.md` exists, this is a re-run. Ask what to change (their answers, an extra to add, a repair) and do only that. Keep everything else.
- **When something breaks, fix it; don't stop.** A failed install, build, test or start is yours to solve: read the real error, find the cause (the `diagnose` skill; `docs/SETUP.md` "When something breaks"; `docs/GOTCHAS.md`), fix it, and run that step again. Hand a step to the user only when it truly needs them (a UAC prompt, a sign-in, a reboot) and say exactly why. If a fix needs a change to Harv's own code, make it in their repo and commit it with a clear message. Name every fix in the final summary.
- Keep the user posted with one short line per step. At the end, give a short summary: what's installed, what was skipped and why, what you fixed on the way, and how to start Harv.

## 0. Say what this is

Before anything runs, tell the user in a few plain sentences:
- what Harv is: a Jarvis-style assistant app for their PC, built on Claude Code and running only on their own Claude subscription, never anything billed;
- what the setup will do: check and install the tools, build the app, ask a few questions about them, and offer some optional extras;
- roughly how long it takes (20–40 minutes, mostly builds and downloads);
- what will need them: a few UAC prompts and a GitHub sign-in in the browser.

Then go on without waiting, unless they want to ask something.

## 1. Check the computer

Run the checks together and report one table: found, version, missing.

| Need | Check | Install (winget id) |
|---|---|---|
| Windows 10 22H2 or 11 | `[Environment]::OSVersion`, `winget --version` | (no winget: the App Installer from the Microsoft Store) |
| Node.js 24 | `node -v` (major 24 or newer) | `OpenJS.NodeJS` |
| Git | `git --version` | `Git.Git` |
| Python 3.14 with the `py` launcher | `py -3.14 --version` | `Python.Python.3.14` |
| Rust (for the app) | `cargo --version` (also `~/.cargo/bin`) | `Rustlang.Rustup`, then `rustup default stable` |
| C++ build tools (Rust on Windows needs the MSVC linker) | `vswhere` finds a VC tools install | `Microsoft.VisualStudio.2022.BuildTools` with `--override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| WebView2 (built into Windows 11) | the Edge WebView2 Runtime in installed programs | `Microsoft.EdgeWebView2Runtime` |
| GitHub CLI | `gh --version` | `GitHub.cli` |
| Claude Code, logged in | `claude --version` | the user already has it (they opened you). If they're not logged in, they run `/login` |

After installs, a new PowerShell may be needed for PATH. Refresh `$env:Path` from the machine and user values instead of asking the user to restart.

## 2. Ask about them (the interview)

Use your **AskUserQuestion** tool: multiple-choice cards, "Other" is always there for their own words, at most 4 questions per call. Two or three rounds. Ask only about the user and their choices. The good working rules are defaults (short straight answers, check don't guess, plan big tasks first, push back once when something's off, build then verify, commit on green, the safety gate). Don't ask about those. They come with `harv/persona.md`, `harv/dev-rules.md` and the starter memory, and the user can edit those files.

Round 1, about them:
- What should Harv call you? (offer the Windows account name and "Other")
- Which language should Harv write in? (English, plus 2–3 likely ones and "Other". Spoken replies are English only for now.)
- How should Harv talk to you? (Casual / Neutral / Formal)
- How much do you code? (New to it: explain more / Some experience / Experienced: keep it brief)

Round 2, what Harv gets (multiSelect where it fits):
- Which extras do you want now? (Hardware sensors / Voice / Desktop control / Pictures through Gemini / Google apps / DaVinci Resolve). Section 6 covers each one. Any can be added later by running the setup again.
- What are you into? (a few broad interests plus "Other". This is only a starting note; Harv learns the rest as you talk.)

Round 3, where things go:
- Your own copy of Harv: a private GitHub repo of yours (recommended: you can change anything and still get updates) / a public fork / no repo for now.
- Projects folder: `~\Code\Projects` (recommended) / Documents\Projects / Other.

## 3. Their repo and updates

The clone's `origin` is the public Harv repo. Make it `upstream` so updates come with `git pull upstream main`, and push their own work to their own repo:

1. `gh auth status`. If not logged in: `gh auth login --web --git-protocol https`. The browser part is theirs, so tell them a browser window will open. Then `gh auth setup-git`. Default scopes only; never ask for `delete_repo`.
2. `git remote rename origin upstream`.
3. Private repo (the default): `gh repo create <name> --private --source . --remote origin --push`. Public fork instead: `gh repo fork --remote --remote-name origin` (a fork of a public repo stays public: say so). No repo: skip.
4. Tell them how an update works: "say 'update Harv from upstream' in Claude Code here: it pulls `upstream/main` and merges it into your changes". To send something back: push that branch to a public fork and open a pull request there.

## 4. Install and build

1. `npm install` in the repo root. npm's `allowScripts` blocks install scripts from packages not listed in `package.json`. If a new one is blocked, review what its script does before `npm install-scripts approve <pkg>`.
2. Checks: `npm run typecheck`, `npm test` (a few minutes; a test that needs something not installed is skipped), `npm run build`. A failure here is a bug in the repo or the computer: diagnose it and fix it, don't hide it.
3. The app: `npm run app` (Rust builds take ~5–10 minutes the first time). Then install it per-user: run `apps/desktop/src-tauri/target/release/bundle/nsis/Harv_*_x64-setup.exe /S`. It lands in the Start menu as **Harv**.

## 5. Write Harv's first memory and settings

Do this before Harv's first start.

- `~/.harv/memory/`: copy every file from `starter/harv-memory/` and set each one's `updated:` to today (YYYY-MM-DD). Fill `user-profile.md` from the interview (name, language, tone, coding level, interests). Keep its header (`about`, `always: true`, `updated:` today). Only what they said goes in: no guesses.
- `~/.harv/settings.json`: write only the keys from the interview, for example `{ "deviceName": "<their PC's name>", "projectsDir": "<chosen folder>", "startSensors": <true if sensors were picked> }`. Harv fills in the rest with defaults when it reads the file. Create the projects folder.
- Claude Code's memory for this repo: `~/.claude/projects/<slug>/memory/`. `<slug>` is this repo's full path with every character that isn't a letter or digit turned into `-` (`D:\Code\Harv` → `D--Code-Harv`). Copy `starter/claude-memory/*` there (including its `MEMORY.md` index), and fill `user-profile.md` the same way as Harv's.
- Skills: copy each folder in `harv/skills/` (Harv's own) and in `harv/outside-skills/` (other authors', each with its LICENSE) to `~/.claude/skills/<name>`. Then Claude Code has them everywhere, not only Harv; Harv copies its own again on every start, so edits belong in the repo. Tell the user in one line that they never need to call a skill by name: Harv and Claude Code pick a fitting one themselves and say which.
- **impeccable** (the UI design skill) has no license file to ship, so it comes from its source: clone `https://github.com/pbakaus/impeccable` into a temp folder, find the folder whose `SKILL.md` says `name: impeccable` and copy it to `~/.claude/skills/impeccable`. Read its scripts before you copy (no network calls you didn't expect, no hooks). Say what version you got.

## 6. The optional extras (only the ones they picked)

Start Harv first: `powershell -File scripts/harv.ps1 start` (or open the app, which starts it). Wait for `http://127.0.0.1:4317/api/health`. Calls to Harv's own API need the dashboard's origin: `-Headers @{ Origin = 'http://127.0.0.1:4316' }`.

- **Hardware sensors** (fans, temperatures, clocks): `winget install LibreHardwareMonitor.LibreHardwareMonitor`. In its folder (`%LOCALAPPDATA%\Microsoft\WinGet\Packages\LibreHardwareMonitor.LibreHardwareMonitor_*`), write `LibreHardwareMonitor.config` with these `appSettings` keys: `runWebServerMenuItem` true, `listenerPort` 8085, `startMinMenuItem` true, `minTrayMenuItem` true, `minCloseMenuItem` true. The web server listens on every address, so add an inbound firewall rule from an elevated PowerShell (one UAC prompt, theirs to accept): `New-NetFirewallRule -DisplayName "Harv: block remote access to LibreHardwareMonitor (8085)" -Direction Inbound -Protocol TCP -LocalPort 8085 -Action Block`. Harv starts LHM elevated each time it starts (a UAC prompt). Settings › Startup › "Start the hardware sensors" turns that off.
- **Voice** (Whisper hears, Piper speaks; an NVIDIA card makes Whisper fast, the CPU works too): `POST /api/voice/install`, then `POST /api/voice/speech/install`. Both take a few minutes, and Settings › What Harv can do › Voice shows progress. Then: the mic beside ATTACH, or hold Ctrl+Alt+Space anywhere.
- **Desktop control** (Harv clicks and types in other apps, with a pill and a STOP button): `POST /api/desktop/install` (Windows-MCP 0.8.8, pinned and reviewed). The user switches it on in Settings › What Harv can do › Desktop control. Never switch it on yourself.
- **Pictures through Gemini** (free; needs Google Chrome: `Google.Chrome`): `POST /api/gemini/signin` opens a Chrome window, and the user signs in to gemini.google.com with a Google account (Harv's own account if they want one). That one sign-in is all.
- **Google apps** (Gmail, Calendar, Drive, Docs, Sheets): these are claude.ai connectors. The user turns them on at claude.ai › Settings › Connectors with their Google account. Harv uses them through the same login, with nothing to install. Harv's `google` skill knows the limits.
- **DaVinci Resolve**: only the free **Resolve 21.1.0** (or Studio) works; from 21.1.1 on the free Console can't run Harv's bridge. They install it from Blackmagic's support page and never accept an update. The `resolve` skill does the rest the first time they ask for something in Resolve.

## 7. First start and the tour

1. Open **Harv** from the Start menu. The first message in a new chat proves the login works. A refusal that names `apiKeySource` means an API key is set: see the rules above.
2. Offer to walk through `docs/GUIDE.md` together: tabs, AUTO and the `[model·effort]` tags, the safety gate, memory, projects, the routines (start, bye, fresh), the `/` commands, the stats panel, voice, the browser and desktop control, usage limits.
3. Tell them where things live: their notes in `~/.harv/memory` (plain Markdown, theirs to edit), settings in Settings, logs in `~/.harv/logs`. For Harv's own code: open Claude Code in this folder. `CLAUDE.md` is the map, and "start" begins a dev session there.
