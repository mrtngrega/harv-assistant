# Setting up Harv

The easy way: open Claude Code in this folder and say **"set up Harv"**. The `harv-setup` skill (`.claude/skills/harv-setup/SKILL.md`) does everything below, asks you a few questions, and only hands you the parts that need a person: UAC prompts and browser sign-ins. This file is the same path by hand, plus what to do when something breaks.

## What you need

- Windows 10 (22H2) or 11, with `winget` (the App Installer from the Microsoft Store).
- A Claude subscription (Pro or higher) and [Claude Code](https://code.claude.com) logged in with it.
- About 10 GB free for the tools and the app build, more for voice (~3 GB).

**Never set an Anthropic API key** for Harv. If `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set, Claude Code bills per token. Harv strips both at start and refuses to run a chat that isn't on your subscription login.

## 1. Tools

```powershell
winget install OpenJS.NodeJS Git.Git Python.Python.3.14 Rustlang.Rustup GitHub.cli
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Microsoft.EdgeWebView2Runtime   # Windows 10 only; 11 has it
rustup default stable
```

Open a new terminal afterwards so the new PATH is picked up. Check: `node -v` (24 or newer), `py -3.14 --version`, `cargo --version`, `gh --version`.

## 2. Your own repo

Keep your work in a repo of your own, and take updates from the public one:

```powershell
gh auth login --web --git-protocol https
gh auth setup-git
git remote rename origin upstream
gh repo create my-harv --private --source . --remote origin --push
```

Updates: `git pull upstream main` (or ask Claude Code to "update Harv from upstream" and it merges them into your changes). To send a change back, push that branch to a public fork and open a pull request.

## 3. Install, check, build

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run app
apps\desktop\src-tauri\target\release\bundle\nsis\Harv_0.1.0_x64-setup.exe /S
```

`npm run app` takes 5–10 minutes the first time (Rust). The installer puts **Harv** in the Start menu. The app starts Harv's server itself, or attaches to one already running.

## 4. Harv's first notes

Before the first start, copy `starter/harv-memory/*` to `%USERPROFILE%\.harv\memory\`, fill `user-profile.md` with a few lines about yourself and set `updated:` in each file to today's date. Copy `starter/claude-memory/*` to Claude Code's memory for this folder: `%USERPROFILE%\.claude\projects\<slug>\memory\`, where `<slug>` is this folder's path with every character that isn't a letter or digit turned into `-` (`D:\Code\Harv` → `D--Code-Harv`). Copy the folders in `harv/outside-skills/` to `%USERPROFILE%\.claude\skills\`.

## 5. Optional extras

All of them can be added later: run the setup again and ask for the one you want.

| Extra | What it gives | How |
|---|---|---|
| Hardware sensors | fans, temperatures, clocks, power in the stats panel | `winget install LibreHardwareMonitor.LibreHardwareMonitor`; turn on its web server on port 8085 (Options › Remote Web Server, or its `.config`); block port 8085 from the network with an inbound firewall rule. Harv starts it elevated each time (a UAC prompt). |
| Voice | the mic in `harv>`, hold Ctrl+Alt+Space anywhere, spoken replies | Settings › What Harv can do › Voice › Install (Whisper), then Install Harv's voice (Piper). Faster on an NVIDIA card. |
| Desktop control | Harv clicks and types in other apps, with a pill and STOP | Settings › What Harv can do › Desktop control › Install (Windows-MCP 0.8.8, pinned), then the switch. |
| Pictures | `generate_image` through the free Gemini website | Google Chrome installed; Settings › What Harv can do › Pictures › Sign in, once. |
| Google apps | Gmail, Calendar, Drive, Docs, Sheets | claude.ai › Settings › Connectors, with your Google account. |
| DaVinci Resolve | editing through the `resolve` skill | Free **Resolve 21.1.0** only (or Studio). Never update it: from 21.1.1 the free Console can't run the bridge. |

## When something breaks

- **Harv doesn't start, or the app shows nothing:** `%USERPROFILE%\.harv\logs\` (`harv-script.log`, the server log, `app.log`). `scripts/harv.ps1 restart` restarts it cleanly.
- **Ports 4317/4316 busy:** an old `node`/`tsx`/`vite` still holds them. `netstat -ano | findstr ":4317 :4316"`, then end those processes by tree.
- **A chat says it refuses to run (`apiKeySource`):** an API key is set somewhere in your environment. Remove it and restart Harv.
- **`npm install` stops at "install scripts blocked":** a new package wants to run a script. Look at what it does, then `npm install-scripts approve <package>`.
- **The app build fails at linking:** the C++ build tools are missing (`link.exe` not found). Install the VCTools workload above.
- **No temperatures or fans:** LibreHardwareMonitor isn't running as admin, or its web server is off. Settings › Startup shows the sensors' state, with "Start sensors".
- **Anything else:** open Claude Code here and describe it. `CLAUDE.md` and `docs/GOTCHAS.md` hold the known traps, and the `diagnose` skill finds causes.
