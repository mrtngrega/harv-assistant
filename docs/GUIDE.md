# A tour of Harv

Harv is one assistant in many tabs. Everything below works on your own Claude subscription; nothing is billed.

## The window

- **Center: chats in tabs.** `+` opens a new chat; drag tabs to reorder; right-click or F2 renames one. Each tab is its own Claude Code session, all the same Harv: the same memory, the recent chats of the others in every prompt, and hand-offs ("ask another chat to…", "start a new chat and…").
- **Left: history** (collapsed at first). Every chat with messages, searchable, with a one-line summary on hover; projects at the top.
- **Right: the stats panel.** Narrow by default (label, %, a thin bar); click it to expand everything: CPU, GPU, RAM, disks, network, fans and temperatures (with the sensors extra), your Claude plan usage and Harv's own tracking. Amber means 85% or more.
- **Above the prompt: the status line**, like Claude Code's: `✻ thinking… (12s · ↓ 340 tokens · esc to stop)`.
- **The view switch** in the chat bar shows a chat's log, its File Explorer, its Terminal or the Browser.

## Talking to Harv

- Type at `harv>`; **Enter** sends (Settings › Chat can make it Ctrl+Enter). A message sent while Harv works goes in at his next step.
- **Esc** stops the current reply (and whatever it was doing).
- **Attach:** the ATTACH menu, drag files in, or `@` to attach a path. Files on your PC are attached by path, like in Claude Code.
- **Thinking** shows folded under a reply. Tools show as small lines; click to see what ran.

## AUTO: the model picker

The header's model switcher starts on **AUTO**: a small classifier picks the model and effort for each new task (Haiku for small talk, Sonnet for most work, Opus for hard work). Every reply is tagged `[model·effort]`; hover it for the reason. **↑ try harder** reruns one step up; AUTO also steps up by itself when a reply struggles (failing tests, repeated errors). Pick a model yourself any time, or start a message with `/opus`, `/sonnet`, `/haiku`, `/low`…`/max` for that one message.

## The safety gate

Every step Harv takes passes a gate built on Claude Code's hooks, which can't be skipped. It ends one of three ways:

- **Run:** what your request plainly covers just runs, and file changes are backed up first. Each step that changed something has **Undo** on its line, and the action log in the expanded stats panel lists everything.
- **Ask:** steps beyond your request wait in the chat with one line saying exactly what waits: uninstalling, drivers, the registry, services and startup, killing programs you didn't mention, force pushes, sending messages nobody asked for, risky desktop clicks. Answer yes or no in your own words, or with the Yes / No buttons.
- **Never:** per-token billing; reading your login secrets (Claude's credentials, browser profiles, password stores, SSH private keys, `.env` files); wiping the system disk.

Settings › Safety also holds your read-only folders (Harv never changes them) and the backups.

## Memory

Harv keeps plain Markdown notes about you in `%USERPROFILE%\.harv\memory`. A few core notes (who you are, how you like answers) are in every chat; the rest come in when their topic does. Tell him things ("remember that…"), correct him ("that's not true any more"), or open the files and edit them yourself. A quiet "from memory: …" line shows which notes a message brought in.

## Projects

"Start a new project called…" makes the folder (in your projects folder), git, a `CLAUDE.md` and a GitHub repo (he asks private or public). A project chat works in that folder exactly like Claude Code, with Harv's memory and rules on top. "Open the X project" binds a chat to one you have; any chat can ask where a project stands.

## The routines

- **start**: at the beginning of a work session: Harv reads the project's docs and memory, checks git and your usage, and says where things stand and what's next.
- **bye**: at the end: checks, docs, commit and push, memory, lessons learned; ends with the phrase to resume.
- **/fresh**: the same save, then a fresh session in the same tab, when a chat has grown long (long chats cost more of your plan).

## Commands

Type `/` for the menu. Harv's own:

| Command | What it does |
|---|---|
| `/btw <question>` | A side question answered from this chat, without adding to it |
| `/report <text>` | A dated note in `harv_report.md`: bugs and wishes for later |
| `/fresh` | Save everything, then continue in a fresh session |
| `/plan [on\|off]` | Plan mode: Harv only reads and plans, then shows a plan to approve |
| `/rewind` | Back to before your last message: files and chat |
| `/model auto\|opus\|sonnet\|haiku [effort]` | Switch model and effort |
| `/new`, `/attach`, `/clear`, `/help` | New tab, attach files, empty this tab, list commands |

Claude Code's own commands and your skills work too (billed or terminal-only ones are refused).

## Skills

Skills are packaged know-how Harv loads when a task needs it. You never call them by name: Harv (and Claude Code in this folder) picks a fitting one by himself and says which. They live in `%USERPROFILE%\.claude\skills`.

| Skill | When it comes in |
|---|---|
| `diagnose` | something is broken, slow or crashing |
| `video` | a YouTube link, a reel, "what does this video say" |
| `image-prompt` | "make me a picture of…" |
| `google` | your mail, calendar, Drive, Docs, Sheets |
| `resolve` | anything in DaVinci Resolve |
| `ui-check`, `deslop` | checking a screen, cleaning up code that grew messy |
| `clone` | "make my own version of app X" |
| `prompt-writer` | a prompt for another AI tool |
| `skill-finder` | "is there a skill for…", or reviewing one someone sent you |
| `learn-from-session` | at "bye": Harv writes down what he learned |
| `figma-templates` | starting a design from a Figma template |
| `tdd`, `grilling`, `prototype`, `research`, `teach`, `find-docs`, `codebase-design`, `improve-codebase-architecture`, `writing-for-agents`, `impeccable` | coding test-first, stress-testing a plan, quick prototypes, researching a question, learning a topic step by step, library docs, code structure, writing for agents, UI design |

New skills: ask Harv ("find a skill for…"); he reviews one before anything is installed.

## Tools in every chat

- **Terminal:** a PowerShell per chat; Harv can type into it and read it (`terminal_run`), in its own Terminal tab so you can watch.
- **File Explorer:** works like Windows 11's: drag and drop, the Recycle Bin, newest first, send a file to the chat.
- **Browser:** a real browser inside the window, shared by every chat. Harv can open pages, click, type, upload and download; logins and payments stay yours (the gate holds sending and buying).
- **Scheduled tasks:** "every morning at 8, check…" runs in the chat that made it (missed runs happen once at the next start).

## The extras

- **Voice:** the mic beside ATTACH fills the line; hold **Ctrl+Alt+Space** anywhere to talk and send on release. Replies to spoken messages are read aloud (English). You can talk while he works: it joins the running reply.
- **Desktop control:** Harv clicks and types in your other apps on one monitor (Settings › Works on). A pill at the top of the screen shows what he's doing, with **STOP**; a soft glow marks the monitor. It's off until you switch it on.
- **Pictures:** "make me a picture of…" goes through the free Gemini website; pictures land in `.harv\workspace\images`.
- **Google apps:** with the claude.ai connectors on, Harv reads and drafts mail, events and documents; sending to other people follows the sending rule (asked for → it goes; his own idea → he asks).
- **DaVinci Resolve:** "cut the pauses out of this clip", "add titles"… through the `resolve` skill (free Resolve 21.1.0).

## Plan limits

The stats panel shows your 5-hour session and weekly usage. Harv warns at 75% and 90%, says when a big task may not fit, and near 90% finishes the step and stops cleanly. When a limit is reached he **pauses**: new messages queue, the reset time shows, and the queue runs by itself after the reset. He never switches to anything paid.

## Shortcuts

| Keys | What |
|---|---|
| Enter / Shift+Enter | Send / new line |
| Esc | Stop the reply |
| Ctrl+Alt+H | Show or hide the Harv window |
| Ctrl+Alt+Space (hold) | Talk to Harv from anywhere |
| F2 | Rename the tab |

## Changing Harv

Harv is yours to build on: open Claude Code in this folder and say what you want. `CLAUDE.md` is the map, `docs/PLAN.md` the state of every feature, `harv/persona.md` Harv's rules (Claude Code follows them too). Your notes and settings live outside the repo, so updates from upstream never touch them.
