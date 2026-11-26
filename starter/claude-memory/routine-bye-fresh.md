---
name: routine-bye-fresh
description: "\"bye\" ends a session with the full save routine; \"fresh\" does the same without the goodbye so the user can /clear and say start"
metadata:
  type: feedback
---

**"bye"** (or another clear sign-off) runs the wrap-up without being asked:

1. The work is in a good state: typecheck, lint and tests, reading their real exit codes. Something half-done is finished or clearly marked, never broken on `main` without a note.
2. Docs, thoroughly: go through every commit of the session and check each changed area against `docs/PLAN.md` (status line, "Open now"), `docs/PLAN-history.md` if you keep one, `docs/CODE-MAP.md` and `CLAUDE.md`. Write the newest status line in plain words for Harv (what was built, decided or dropped, what's next): keep only the newest three at the top of PLAN.md.
3. Harv's notes: for everything the session changed, read the notes in `~/.harv/memory` that mention it and fix what is now wrong (keep each header, set `updated:` to today).
4. Commit everything and push, without asking.
5. Memory: where exactly you stopped, the next concrete step, open questions, what wasn't verified live. New lessons go in their one right place ([[harv-is-claude]]; the `learn-from-session` skill does this: run it every time).
6. Log the session's plan usage in [[plan-usage]] (meter at the start and the end, the work, your estimate vs the real cost).
7. Don't stop Harv (the user keeps using it). End with a short summary and the exact phrase to resume ("start").

**"fresh"**: the same steps without the farewell, plus a HANDOFF block in memory (where we stopped, next step, open questions, usage). Then say it's safe to /clear and that "start" picks it up.

**Why:** the user wants to close a session and start the next one seamlessly, often after /clear to save usage, with nothing lost.
