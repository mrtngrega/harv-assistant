---
name: git-and-checks
description: Commit only on a real green run; format and stage only your own files; check every "what's left" item against git and the code
metadata:
  type: feedback
---

- **Commit on green:** keep the real exit code of the tests and lint and commit inside an `if` on it. `npm test | grep Tests && git commit` commits a failing run, because grep succeeds. Never chain a restart after a piped test run either.
- **No sed on code:** sed mangles regexes and quotes inside TypeScript strings. Use Edit, or a Python script written with the Write tool.
- **Format only your files:** `npm run format` rewrites the whole repo. Use `npx prettier --write <the files you changed>` and stage files by name.
- **Verify the open list:** before reporting "what's next" or "not done", check each item against `git log --grep`, the code and the skills. Never copy plan lines as they stand. `docs/PLAN.md` "Open now" is the one open list; update it in the same commit that builds, drops or decides an item.
- Branches: `main` is the default. Commit or push only when asked or at "bye" ([[routine-bye-fresh]]).
