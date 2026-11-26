---
name: plan-usage
description: Subscription only; quality first near the limit; helper agents cost a lot; log what work costs and estimate from it
metadata:
  type: reference
---

- **Subscription only.** Harv and these sessions run on the user's Claude plan. Never an API key, never anything billed. When a limit runs out, wait for the reset.
- **Quality first near the limit:** never switch to cheaper models to save usage. Say up front when a big task may not fit. Around 90% of the session, finish the step, commit what's sound, say what's left, and wait. When the user names a stop number, work up to it in small finished steps.
- **Helper agents are dear:** each one re-reads the repo cold, roughly 5 session points on Pro for ~8k lines read (a Fable-class reviewer ~30). Prefer doing the work yourself. If you spawn helpers, say the estimate first and check the meter after.
- **The meter:** `node scripts/ui-check/usage.mjs` (session %, weekly %). Read it before and after sizeable work.
- **Biggest hidden costs:** long chats (every turn resends the context), screenshots, helpers. Small edits in a fresh session cost about half of the same edits late in a long one. Do big mechanical work early or after "fresh".

## Measured costs (add a row at every bye; at ~10 rows, fold them into the rules above)

| Date | Work | Model | Before → after | Cost |
|---|---|---|---|---|
