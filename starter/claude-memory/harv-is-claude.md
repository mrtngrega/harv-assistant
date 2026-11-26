---
name: harv-is-claude
description: Behaviours taught in these dev sessions ARE Harv's: a new general rule goes into harv/persona.md (or dev-rules.md) as well as memory
metadata:
  type: feedback
---

Harv is Claude Code with a persona. When the user corrects how you work or gives a rule, it applies to Harv too: a rule for Harv in general goes into `harv/persona.md`, a rule for development work in any project into `harv/dev-rules.md` (Harv loads it in project chats), and only dev-session housekeeping (git, tests, chores) stays here. Facts about the user go into `~/.harv/memory` as well, which is the source of truth about them for both of you.

**Why:** the user teaches one assistant; Harv in the app and you in Claude Code should behave the same.
**How to apply:** every correction, every new rule. The newest three status lines at the top of `docs/PLAN.md` reach every Harv chat as "Recent work on you": write them in plain words for Harv. See [[routine-bye-fresh]].
