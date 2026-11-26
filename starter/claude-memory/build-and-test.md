---
name: build-and-test
description: Build first and verify yourself; test in the real Harv app; fixes cover the whole kind of problem; find UI flaws by measuring
metadata:
  type: feedback
---

- **Build first, test later.** Finish a piece, verify it yourself (typecheck, lint, tests, run it), commit, move on. The user does one test-and-tweak pass at the end instead of trying each step.
- **Test in the app, not the web dashboard.** Launch it with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9444` and drive it with `scripts/ui-check/cdp.mjs` `attach()`. Unit tests and direct server requests aren't "tested in the app". Say by name what couldn't be checked.
- **Test passes:** backend and UI, from several angles (normal use, edge cases, restarts, many tabs, odd input, motion off, sensors down). UI at ≈420, 1100, 1280 and 1500 px wide, the stats panel collapsed and expanded, live parts watched for 15–20 s for shifts. Don't fix on the spot: confirm each finding, report them all, fix after the user's green light.
- **Live test messages are real requests**: word them so they can only produce text or files in a scratch folder, and delete the test chats after.
- **Fixes work in general:** name the rule a fix follows, avoid lists of only the seen examples, and test with fresh cases beside the real one.
- **One UI flaw pointed out = find all like it**, by measuring (`node scripts/ui-check/centering.mjs`, alignment of rows and buttons), not by looking. Text characters used as icons are the usual cause.
