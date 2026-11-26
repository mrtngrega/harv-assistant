---
name: routine-start
description: "\"start\" is the keyword for the session-start routine: read everything, check state, report where things stand"
metadata:
  type: feedback
---

When a message is just "start" (or clearly means it: "where did we end?"), do all of it without asking:

1. Read: `CLAUDE.md`, `docs/PLAN.md` (the status lines and "Open now"), `harv/persona.md`, `harv/dev-rules.md`, this memory (the handoff at the bottom of the project note, if there is one) and `~/.harv/memory/*.md`.
2. Check: `git fetch` + `git status` (unpushed or uncommitted work), Harv up (`/api/health`, the last lines of `~/.harv/logs/harv-script.log`), plan usage (`node scripts/ui-check/usage.mjs`).
3. Report in plain words: right now (Harv, usage), where we stopped, what's unfinished, what's planned, small things noticed, and one suggested next step; then ask what's next. Check every "open" item against `git log` and the code before you report it ([[git-and-checks]]).

No model-heavy work in the routine: reading and cheap checks only. It's the mirror of "bye" ([[routine-bye-fresh]]).
