# Prompt audit: persona, dev rules, skills (2026-11-15)

Findings only. Nothing was changed. Yardstick: `docs/fable-playbook.md` 2.5 and 5.2, `docs/brief/brief.md`, the `writing-for-agents` skill.

Tags: **[code]** read in the code at that line · **[seen]** read in the prompt file at that line · **[plan]** from `docs/PLAN.md` or `CLAUDE.md` · **[not checked]**.

## Summary

1. Three stale claims: `image-prompt` says Gemini can't edit pictures (it can), `skill-finder` cites the wrong persona rule, and two Settings paths in the persona miss a level.
2. The biggest waste is the same safety text three times in every chat: persona rules 16–21, `SAFETY_NOTE` in `options.ts`, and the gate's own notes that arrive at the moment they matter. About 385 words per chat can go.
3. `dev-rules.md` repeats the persona (grill, do it yourself, honest reports), three tool descriptions and the `ui-check` skill. About 475 words can go.
4. Seven real conflicts: where yt-dlp may live, "ask first" against "don't ask ahead of the gate", git backups, which memory a project chat writes, `format_drive`, where a lesson goes, and three brief rules the persona lost.
5. No names, emails or addresses in the audited files. A few soft identifiers remain (P28).

## Word counts

| File | Now | Proposed | Saved |
|---|---|---|---|
| `harv/persona.md` (every chat) | 1,909 | ~1,540 | ~370 |
| `harv/dev-rules.md` (project chats) | 1,646 | ~1,170 | ~475 |
| `SAFETY_NOTE`, `options.ts:153-157` (every chat) | 213 | ~20 | ~195 |
| `skills/clone/SKILL.md` | 784 | ~765 | ~20 |
| `skills/deslop/SKILL.md` | 1,196 | ~1,175 | ~20 |
| `skills/diagnose/SKILL.md` | 1,094 | ~1,070 | ~25 |
| `skills/image-prompt/SKILL.md` | 656 | ~650 | ~5 |
| `skills/learn-from-session/SKILL.md` | 636 | ~625 | ~10 |
| `skills/prompt-writer/SKILL.md` | 1,260 | ~1,215 | ~45 |
| `skills/resolve/SKILL.md` | 869 | ~855 | ~15 |
| `skills/skill-finder/SKILL.md` | 729 | ~690 | ~40 |
| `skills/ui-check/SKILL.md` | 673 | ~660 | ~15 |
| `skills/video/SKILL.md` | 463 | ~455 | ~10 |

Counted with `wc -w` [code]. "Proposed" is an estimate from the findings below.

For scale, what else rides in a normal chat's system prompt [code]: `selfContext()` 436 words (`harvSelf.ts:41-52`), "Recent work on you" 80 words of heading plus the three status lines (626 words today), the "Right now" block about 670 words (`options.ts:196-212`), "Your other chats" 321 words (`options.ts:98-109`), the memory block (2,193 words today, capped at 12,000 characters, `memory.ts:14`), `DESKTOP_NOTE` 529 words when desktop control is on (`options.ts:87`), and the ten skill descriptions (461 words).

## Not looked at

- The skills' `references/` files and scripts (only checked that each file a SKILL.md names exists: all do [code]).
- `DESKTOP_NOTE`, `otherChats()`, `selfContext()` and the tool descriptions were read for overlaps only, not audited line by line.
- `~/.harv/memory` contents (private; only the word count).
- Claude Code's own system prompt and the outside skills in `~/.claude/skills`; overlaps with them are judged from their descriptions only.
- Nothing was run: no chat was started to see whether a skill really fires. Trigger findings are read from the wording [not checked in a live chat].
- Whether the gate holds `python -m venv` or `pip install` inside `~/.harv/tools` (P3) [not checked].

---

## Stale

### P1 · stale · image-prompt says Gemini can't edit or use the user's pictures

**Where:** `harv/skills/image-prompt/SKILL.md:8` ("it won't edit existing pictures (it says so)") and `:34` ("Gemini can't use their photo as a base on this account") [seen]. Against `apps/server/src/agent/chatTools.ts:510` ("or change one of their pictures… Pass images only when the user gave you pictures for this") and `apps/server/src/tools/gemini.ts:19-21, 151, 216-220` (input pictures are uploaded through Gemini's own upload menu) [code].

**What's wrong:** The skill tells Harv not to try what the tool does. Harv will describe the user's car in words when it could pass the photo. Line 8's "about 25 s a picture" also sits beside the tool's "up to a few minutes" (`gemini.ts:22`, a 240 s limit) [code]; the usual time is [not checked].

**Change:** Line 8, last sentence: "Harv's `generate_image` runs Google's Gemini on its website: it can take a few minutes, the free account has a daily limit, and it can edit or build on up to 4 of the user's pictures (`images`; they go to Google, so only pictures the user gave for this)." Line 34: "**A picture of the user's own thing** (their car, their room): pass their photo in `images` and say what to change and what stays. No photo: describe it in detail (model, colour, details)."

**Saves:** 0 (correctness).

### P2 · stale · skill-finder cites the wrong persona rule

**Where:** `harv/skills/skill-finder/SKILL.md:8` ("install only with the user's OK (persona rule 13)") [seen]. Skills are rule 12 (`harv/persona.md:26`); rule 13 is "Remember and learn" (`:27`) [seen].

**What's wrong:** The pointer leads to the memory rule.

**Change:** "(persona rule 12)".

**Saves:** 0.

### P3 · stale · Two Settings paths in the persona miss a level

**Where:** `harv/persona.md:51` ("Settings › Startup › Restart Harv") and `:48` ("Settings › Phone access") [seen]. In the app: group "This computer" › "Startup" › button "Restart Harv" (`apps/web/src/components/settings/computer.tsx:136-137, 160`); group "Phone" › "Phone access" › switch "Open Harv from my phone" (`apps/web/src/components/settings/phone.tsx:220, 17-20`) [code].

**What's wrong:** Harv tells the user to press a path that has one more step. Small, but the user reads it literally.

**Change:** "ask the user to press Settings › This computer › Startup › Restart Harv" and "never turn on Settings › Phone › Phone access yourself". (`CLAUDE.md` uses the same short paths; fix it with the persona.)

**Saves:** 0 (adds 4).

---

## Conflicts

### P4 · conflict · The video skill installs into a folder the prompt forbids

**Where:** `harv/skills/video/SKILL.md:18` ("yt-dlp lives in `~/.harv/tools/yt-dlp` (a venv)… `python -m venv ~/.harv/tools/yt-dlp`… update it with that venv's pip") [seen]; `harv/skills/video/scripts/transcript.py:26` [code]. Against `apps/server/src/agent/options.ts:210` ("Your own working files… go in your workspace… never anywhere else under ~/.harv") and `apps/server/src/safety/paths.ts:49` (`isHarvData`: everything in `~/.harv` outside `workspace` is Harv's data, which the gate holds for a yes; `classify.ts:808` notes a hold that involved `~/.harv/tools`) [code].

**What's wrong:** The skill says "ask once, then install"; the system prompt says never there; the gate treats the folder as Harv's own data. Whether the install or the update is actually held is [not checked], but the three texts disagree.

**Change:** One of two. (a) Move the venv to `~/.harv/workspace/tools/yt-dlp` (script line 26 and skill line 18). (b) Keep the path and add `tools/` to the allowed places in `options.ts:210` and `paths.ts:49`. (a) needs no gate change.

**Saves:** 0.

### P5 · conflict · "Ask first" against "don't ask ahead of the gate"

**Where:** `harv/persona.md:18` (rule 4: "Ask first: … money … anything that can't be undone"), `:43` (rule 19: "When sending is your own idea, ask first") against `:41` (rule 17: "Don't ask ahead of the gate: make the call, and the gate holds it… then ask") and `options.ts:156` ("Don't ask ahead of the gate: make the call, let it hold, then ask") [seen][code]. Rule 17's own list has "sending something the user didn't ask you to send", "spending money" and things that can't be undone.

**What's wrong:** For the same action two rules say "ask before" and two say "call first, ask after". The gate does hold unasked sending (`gate.ts:414`) and buy clicks (`desktop.ts:179`, `browser.ts:27`) [code], so rule 17 is the one that matches the code.

**Change:** Rule 4 keeps only what the gate can't see: "4. **Some things aren't yours to decide. Ask first:** other people (anything in someone's name, their accounts, messages to them), the user's taste (names, looks, what of theirs to keep or delete). Then do as they say. Money and what can't be undone: rule 17." Rule 19 becomes one sentence: "19. **Sending.** When the user tells you to send something to someone, send it: that is the approval." (The own-idea half is already item "sending something the user didn't ask you to send" in rule 17. Keep the number 19: `gate.ts:414` and playbook 5.2 point at it.)

**Saves:** ~25.

### P6 · conflict · Dev rules tell Harv to back up `.git` by hand; the gate already does

**Where:** `harv/dev-rules.md:42` ("Throwing away work (`branch -D`, `reset --hard`, `reflog expire`, `filter-branch`, `clean`): back up first (a copy of `.git` or a backup branch) or ask") [seen]. Against `apps/server/src/safety/classify.ts:724` (`keep: [join(root, '.git')]`: the gate copies `.git` before such a command) [code], `CLAUDE.md` "Run" ("Local git rewrites… run after a copy of the repo's `.git`") [plan], and `harv/persona.md:42` ("Everything else runs, backed up") [seen].

**What's wrong:** The prompt asks Harv to do what a hook does, and offers "or ask" for something that just runs. Playbook 2.5: "Never ask the prompt to enforce what a hook enforces."

**Change:** "- Throwing away local work (`branch -D`, `reset --hard`, `reflog expire`, `filter-branch`, `clean`) runs; the gate copies `.git` first. Anything that rewrites or deletes on the remote is held (persona rule 17)."

**Saves:** ~10.

### P7 · conflict · Which memory does a project chat save to?

**Where:** `harv/dev-rules.md:12` (rule 6: "Save the project's state, decisions and the user's new rules to your memory") and `:52` (End of session 4: "Save to memory: where exactly you stopped…") [seen]. Against `apps/server/src/agent/options.ts:173` ("Your project memory is Claude Code's auto-memory for this folder… What Harv knows about the user in general is below; change that with remember/forget") [code] and `harv/persona.md:27` (rule 13: "Save durable facts… to memory") [seen].

**What's wrong:** "Your memory" means two stores in a project chat. The project's state belongs in the folder's auto-memory; a general rule belongs in `remember`. The dev rules don't say which, so project state can land in the 12,000-character block every chat pays for.

**Change:** Rule 6: "6. **Remember across sessions.** The project's state, decisions and next step go to the project memory (Claude Code's auto-memory for this folder); the user's general rules go to `remember`." End of session 4: "Save to the project memory: where exactly you stopped, the next concrete step, open questions." Then cut the first two sentences of `options.ts:173` down to "(see dev rule 6)".

**Saves:** ~10 in dev-rules, ~35 in `options.ts`.

### P8 · conflict · `format_drive` is listed under chat holds but asks with a card

**Where:** `harv/persona.md:40` (rule 17 list: "formatting a drive") with `:41` ("the gate holds it… then ask") [seen]. Against `apps/server/src/agent/chatTools.ts:259` ("The user always gets a card to approve it") and `apps/server/src/safety/gate.ts:395` ("Only format_drive, questions and plans wait here for a card") [code].

**What's wrong:** For a USB format Harv is told both "ask in the chat with the risk" and "the card asks". The card is what happens.

**Change:** In the rule 17 list write "formatting a drive (a USB drive: `format_drive`, which shows its own card)".

**Saves:** 0 (adds 9).

### P9 · conflict · Where a lesson goes: the skill and the persona disagree

**Where:** `harv/persona.md:27` (rule 13: "A lesson goes in its one right place, by yourself (memory or a skill before a new rule here)") [seen]; `docs/brief/brief.md:26` (the same preference) [seen]. Against `harv/skills/learn-from-session/SKILL.md:32` (the table's first row sends general behaviour to `harv/persona.md`, with no preference stated) and `:39` ("Number new persona or dev rules after the last one") [seen].

**What's wrong:** The skill invites new persona rules; the persona and the brief say a new rule there is the last choice. A rule numbered "after the last one" would also land in the Models section (the last rule is 24, `persona.md:57`), against the playbook's order (2.5: who, how, safety, models).

**Change:** Line 39, last sentence: "A new persona rule is the last choice: first sharpen an existing rule, or use memory or a skill. If one is needed, put it in the section it belongs to and tell the user the number." Add to the first table row: "only when no existing rule, memory or skill can hold it".

**Saves:** 0 (adds ~20 to the skill; keeps the persona from growing).

### P10 · conflict · Three brief rules are missing from the persona

**Where:** `docs/brief/brief.md:18` (2.8: "Don't ask 'which one' when the chat, project, memory or screen tells you"), `:22` (2.12: "No tips, no small talk"), `:88` ("He keeps his models: no cheaper model to stretch the plan") [seen]. None of the three is in `harv/persona.md` (rules 7, 10 and 24, lines 21, 24, 57) [seen]. `budget.ts:17-18` does say "Same models and effort as always" from 75% [code].

**What's wrong:** The brief is the source of truth; the persona dropped these. The first two are behaviour only the prompt can carry. Also: brief 2.15 names three routines ("start", "bye", "fresh routine"); the persona has only "bye" (`:28`), "start" lives only in dev-rules (`:7`), and "fresh routine" is only in a skill description (`learn-from-session/SKILL.md:3`). `/fresh` exists as a command (`manager.ts:681`) [code]; the spoken "fresh routine" has no rule anywhere [seen].

**Change:** Rule 7, add: "Don't ask 'which one' when the chat, project, memory or screen tells you." Rule 10, add: "No tips, no small talk." Decide with the user whether "fresh routine" means `/fresh`; if yes, one clause in rule 14: "'fresh routine': save like 'bye', then continue in a fresh session (`/fresh`)."

**Saves:** 0 (adds ~35; pays for itself in fewer needless questions).

---

## Duplicates, by words saved

### P11 · duplicate · `SAFETY_NOTE` repeats persona rules 16–18 in the same prompt

**Where:** `apps/server/src/agent/options.ts:153-157` (213 words), added to both prompts at `:174` and `:201` [code]. The persona is in the same prompt (`:168`, `:194`); its rules 16–18 (`harv/persona.md:35-42`) say the same: three hard stops, the held list, "one line with exactly what waits", "their outright request is already the yes", "Don't ask ahead of the gate" [seen].

**What's wrong:** Every chat pays for the safety rules twice. The two lists also differ in small ways (the note has "stopping programs", the persona "killing programs that aren't yours"; the note leaves out money and formatting), so they can drift.

**Change:** Cut the note to what the persona doesn't have: on Linux only, "- sudo can't type a password here, so leave anything that needs it to the user." On Windows: nothing. Update the comment at `:152`.

**Saves:** ~195 per chat on Windows, ~180 on Linux.

### P12 · duplicate · Rule 17's mechanics repeat what the gate says at the moment it holds

**Where:** `harv/persona.md:41` (257 words) [seen]. Against the gate's own texts [code]:
- `apps/server/src/safety/gate.ts:344`: "This needs the user's yes. Don't retry it and don't do it another way. If the rest of the task doesn't depend on it, finish the rest first, then ask once at the end about everything held, in plain words with the risk. If everything depends on it, ask now. When they say yes, run this same call again unchanged."
- `gate.ts:356`: "ask once more, briefly." · `:362`: "these held actions are dropped… Don't run them." · `:364`: "Run exactly those calls again now, unchanged; nothing else was approved."
- `apps/server/src/safety/judge.ts:71` reads "yes but not 2"; `judge.ts:95-98` holds "A goal is not a yes for a step Harv chose", "much bigger than what was asked", "A question about what would happen… is not".

**What's wrong:** How a reply is read ("yes", "jo", "yes but not 2", goal vs step, a question is not a request) is decided by `judge.ts`, not by Harv. Harv only sees the gate's note, which already tells him what to do. The persona carries the judge's manual in every chat.

**Change:** Keep the list (`:40`) as it is. Replace `:41` with:

> The gate **holds** such an action, shows the user exactly what waits, and tells you what to do next: follow its note. Don't ask ahead of the gate: make the call. Don't retry a held call and don't go round it. Ask in plain words with the risk: "Uninstall Steam? It can't be undone; the games stay on D:. Go?" A yes covers what was named and shown, nothing more. Touch your own data in `~/.harv` only when the user asked for it in this chat. Only if the gate let something from this list through that was your own idea, stop and ask anyway.

One thing would be lost: "say in one line what was dropped". Add it to the gate's note at `gate.ts:362` ("…Don't run them; say in one line what was dropped."), where it arrives exactly when needed.

**Saves:** ~160 per chat.

### P13 · duplicate · Dev rules restate persona rules

**Where** [seen]:
- `harv/dev-rules.md:10` (rule 4 "Do it yourself", 36 words) = `harv/persona.md:15` (rule 1), almost word for word.
- `dev-rules.md:8` (rule 2, first two sentences) = `persona.md:16-17` (rules 2, 3).
- `dev-rules.md:13` (rule 7, first sentence) = `persona.md:11` and `:20` (honest; "what failed, what you guessed, what you skipped"; "changed, not checked").
- `dev-rules.md:43` ("Committing in someone else's name… ask first") = `persona.md:40` ("signing work as someone else"); the gate holds it (`classify.ts:635-669`) [code].
- `dev-rules.md:41` ("Never commit secrets… `.env`") overlaps `persona.md:37`; keep it, it is a different act.

**What's wrong:** A project chat loads both files (`options.ts:168, 182`) [code], so each of these is paid twice.

**Change:** Cut rule 4 and Git line 43. Rule 2: "2. **Grill, then build** (persona rule 3). Before a round of several items, list exactly what's in it and name anything you added beyond the plan." Rule 7: "7. **Report honestly.** Keep what you read or ran apart from what you inferred (\"the log shows…\" vs \"probably…\"). Keep the user posted on long work with a short line now and then." Renumbering changes "dev-rules rule 11" in `docs/fable-playbook.md` (part 5, "Applied 2026-11-13"); keep the numbers and leave rule 4 as a gap, or update that line.

**Saves:** ~115.

### P14 · duplicate · "New projects" is written three times

**Where:** `harv/dev-rules.md:59` (72 words) [seen]; `apps/server/src/agent/chatTools.ts:378` (the `start_project` description, 102 words, always loaded with the tool); `apps/server/src/agent/options.ts:202` (normal chats) [code]. All three say: use `start_project`, never by hand, ask private or public first, it makes the folder, git, `CLAUDE.md` and the repo.

**What's wrong:** The tool description is the one place that is always present when the tool is. The other two are copies.

**Change:** Dev-rules: "## New projects\n\nStart one with `start_project` (never by hand); then fill in its `CLAUDE.md` (project, stack, commands)." Cut `options.ts:202` to "- A new project starts with start_project, never by hand."

**Saves:** ~55 in dev-rules, ~45 in `options.ts`.

### P15 · duplicate · Dev-rules "Testing" repeats the ui-check skill

**Where:** `harv/dev-rules.md:31-33` (108 words: window widths "phone, ~1100px, ~1280px, wide", many tabs, live parts watched, re-check each finding, report in one list, wait for the green light) [seen]. Same content in `harv/skills/ui-check/SKILL.md:15, 27-30, 36, 40-42` [seen].

**What's wrong:** The sizes and the report-first rule live in two places. Only the non-UI parts are unique to dev-rules (backend, restarts, odd input, "time from the user's moment").

**Change:** "1. Test backend and frontend from many angles: normal use, edge cases, restarts, odd input. UI: use `ui-check`. Time anything that should feel quick from the user's moment (pressing the power button, logging in, clicking), not from when your own part starts.\n2. Don't fix on the spot. Re-check each finding to make sure it's real, report all of them in one list (what, where, how to reproduce, severity), then wait for the green light." Items 4 and 5 stay.

**Saves:** ~50.

### P16 · duplicate · Rule 23 repeats the `set_model` description

**Where:** `harv/persona.md:56` (88 words) [seen]. `apps/server/src/agent/chatTools.ts:222` (83 words): plain-word examples, "stays for this chat until they pick AUTO again", "auto" gives the choice back [code]. The slash words are real (`packages/shared/src/commands.ts:11`) [code].

**What's wrong:** When to call `set_model` and how long it lasts is in the tool. The persona only needs what no tool says: don't guess who picked the model.

**Change:** "23. **Models.** AUTO picks a model per message and steps up by itself when a reply struggles; the user can pick one in the header or with `/opus`, `/sonnet`, `/haiku` for one message. The `[model·effort]` tag and its reason tell what ran and why. Never guess who picked a model: read the reason. Asked in plain words to change it, use `set_model`."

Open point: no code was found that puts the tag's reason into Harv's own context (it goes to the dashboard: `manager.ts:1138`) [code]; where Harv should "read the reason" is [not checked]. If he can only find it with `harv_db` (the `routes` table, `chatTools.ts:274`), say so in the rule.

**Saves:** ~30.

### P17 · duplicate · Rule 24 and dev rule 9 repeat the plan notes the server injects

**Where:** `harv/persona.md:57` (49 words: 75%, 90%, "finish the step, save the sound part and say where you stopped") and `harv/dev-rules.md:15` (first two sentences) [seen]. `apps/server/src/usage/budget.ts:7-8, 17-18, 24`: a `[Plan: …]` note goes in front of every turn from 75% and between tool calls from 90%, with the same instructions [code].

**What's wrong:** Below 75% (most chats) the thresholds do nothing; from 75% the note says it all, with the live numbers.

**Change:** "24. **Plan usage.** From 75% of the session a `[Plan: …]` note tells you what fits: follow it. Keep overhead low: no needless calls or words. Never a cheaper model to stretch the plan." Dev rule 9: start at "Learn what things cost: …" under the title "**Know what things cost.**"

**Saves:** ~25 in the persona, ~25 in dev-rules.

### P18 · duplicate · The end-of-session learning step is in four places

**Where:** `harv/persona.md:27` (rule 13, last sentence) and `:28` (rule 14); `harv/dev-rules.md:53` (End of session 5); `apps/server/src/agent/manager.ts:150` (`BYE_NOTE`, put in front of every sign-off: "save anything worth keeping to memory, then run the learn-from-session skill… end with a short list of what you learned") [code]; `harv/skills/learn-from-session/SKILL.md:3, 44` [seen].

**What's wrong:** `BYE_NOTE` arrives exactly at "bye" and names the skill; the skill says how to list the lessons. The persona and dev-rules lines are copies.

**Change:** Persona rule 13: cut "At the end of a session run `learn-from-session` and list what you learned." Dev-rules End of session 5: "Run `learn-from-session`." Keep `BYE_NOTE`.

**Saves:** ~15 in the persona, ~15 in dev-rules.

### P19 · duplicate · Rule 21 is the gate's own message

**Where:** `harv/persona.md:45` (30 words) [seen]. `apps/server/src/safety/gate.ts:341`: "Nobody is here (a scheduled or background turn). Do the rest of the task and list this in your report; it stays held until the user says yes in this chat." [code]

**What's wrong:** The same instruction, delivered by the gate on the held call itself.

**Change:** Cut the rule's text but keep the number so "persona rules 16–21" (`options.ts:152`, `CLAUDE.md`) stays true: "21. **Nobody there:** the gate's note says what to do."

**Saves:** ~20.

### P20 · duplicate · Two standing rules that code or a skill already hold

**Where:** `harv/persona.md:50` ("A light that refused a login is never asked again (the strip locks)") [seen]: enforced in `apps/server/src/devices/lights.ts:228-234` [code]; Harv only has `lights_list`/`lights_set`. `harv/persona.md:47` ("In Resolve, test in a throwaway project") [seen]: Resolve work only happens through the `resolve` skill, whose own rule is different and better ("duplicate the timeline… work on the original", `harv/skills/resolve/SKILL.md:35`) [seen].

**What's wrong:** The first restates code. The second is a dev-session rule (it is in `CLAUDE.md`) that reads oddly for the runtime Harv, who is asked to work in the user's real projects.

**Change:** Cut line 50. Line 47: "Never update DaVinci Resolve (it stays on 21.1; a newer one breaks your bridge), and never update Windows-MCP by yourself."

**Saves:** ~22.

### P21 · duplicate · "Say in a few words that you're using it" in all ten skills

**Where:** line 10 of every `harv/skills/*/SKILL.md` [seen]. `harv/persona.md:26` (rule 12: "say which in a few words (\"using find-docs\")") [seen].

**What's wrong:** One rule, eleven places. Each copy costs about 13 words when its skill loads.

**Change:** Cut the sentence from each skill. In `diagnose` and `deslop` keep the rest of that line.

**Saves:** ~13 per skill use (~130 across the files).

### P22 · duplicate · A hand-off's brief is described three times

**Where:** `harv/persona.md:25` (rule 11: "A helper or a hand-off gets a brief that stands on its own (it starts cold)") [seen]; `apps/server/src/agent/options.ts:104` ("a complete request: the other chat can't see this conversation"); `apps/server/src/agent/chatTools.ts:320` ("with everything it needs (it can't see this conversation)") [code].

**What's wrong:** The hand-off half is covered twice in code. The persona's line is still needed for helpers (the Agent tool).

**Change:** Rule 11: "A helper gets a brief that stands on its own (it starts cold); never guess its result before it reports." Cut the clause from `options.ts:104`.

**Saves:** ~5 in the persona, ~10 in `options.ts`.

---

## Wordy, wishes, one-incident rules

### P23 · wordy · Dev rule 8 is a skill pasted into one paragraph

**Where:** `harv/dev-rules.md:14` (192 words) [seen].

**What's wrong:** It says "least code" four ways ("least code", "no features, options or abstractions", "touch only what the task needs", "be lazy about the solution"), then ends with a credit and a date. "End with one line on what you skipped" repeats rule 7.

**Change:** "8. **Keep changes small.** Touch only what the task needs; mention unrelated problems instead of fixing them. Before writing, take the first that fully works: not needed at all → already in this codebase → the standard library or platform → an installed dependency → the least new code (never a new dependency for a few lines). Finish every caller, test and config the change touches. A bug fix finds every caller first and fixes the root cause once, in the shared code. New non-trivial logic (a branch, a parser, money or security) leaves one small test. Never cut validation at trust boundaries, error handling that prevents data loss, security or accessibility."

**Saves:** ~80.

### P24 · wordy · Preambles, dates and credits the model can't act on

**Where** [seen]:
- `harv/persona.md:3` (30 words: who loads the file). `options.ts:167` already says who Harv is.
- `harv/dev-rules.md:3` (58 words). `options.ts:181` already heads it "How the user likes project work done". Only "The project's own `CLAUDE.md` comes first when the two disagree" is a rule, and `options.ts:172` says it too.
- `dev-rules.md:8` "(the user asked mid-build, 2026-11-13)"; `:14` "(Adapted from the Ponytail skill, reviewed 2026-11-09.)"; `skills/prompt-writer/SKILL.md:8` "(Ideas adapted from Prompt Master by nidhinjs, MIT, reviewed 2026-11-09.)"; `skills/deslop/SKILL.md:30` "(… ideas from the Untangle skill, reviewed 2026-11-09)"; `skills/skill-finder/SKILL.md:8` "(The search method is adapted from Vercel's find-skills; the review is Harv's own.)".

**What's wrong:** History and credits belong in `docs/PLAN-history.md` or a LICENSE file, not in text sent to the model. (Where a licence demands a notice, the footer lines in `deslop` and `diagnose` already do it right: at the end, once.)

**Change:** Persona line 3: "No personal data here; that lives in your memory." Dev-rules line 3: "The project's own `CLAUDE.md` comes first when the two disagree. No personal data here." Cut the parentheticals; move the credits to a footer line or a `LICENSE-*.txt` beside the skill.

**Saves:** ~20 persona, ~45 dev-rules, ~45 across three skills.

### P25 · wordy · Wishes and no-ops

**Where** [seen]:
- `harv/persona.md:7` "Like Jarvis: a task in a few words, done properly." A wish; rules 1, 2 and 6 are its actionable form.
- `harv/dev-rules.md:12` "so any later session (in Harv or elsewhere) picks up seamlessly"; `:11` "so the next session doesn't hit them again"; `:39` "Commit in meaningful steps with clear messages" (the model's default).
- `harv/persona.md:27` (rule 13, 99 words) says "one place" twice ("update the note that exists instead of adding a second"; "A lesson goes in its one right place").
- `harv/skills/diagnose/SKILL.md:10` and `harv/skills/deslop/SKILL.md:10`: "The user isn't a programmer". A fact about the user, repeated in two public files; it belongs in memory once (`clone/SKILL.md:41` has a third copy).

**Change:** Cut the four clauses. Rule 13: "13. **Remember and learn.** Save durable facts, decisions and the user's rules to memory without being asked; update the note that exists, fix or forget wrong ones; never store secrets. Memory holds what the user said or decided, not your guesses or what a page claimed. A \"never do X\" goes to memory at once and stays until the user lifts it. A lesson goes in its one right place, by yourself (memory or a skill before a new rule here)." In the skills write "Explain causes and fixes in plain words." and drop the reason.

**Saves:** ~35 persona, ~30 dev-rules, ~15 skills.

---

## Skill descriptions (triggers)

### P26 · trigger · deslop overlaps Claude Code's `simplify`, `code-review` and `improve-codebase-architecture`

**Where:** `harv/skills/deslop/SKILL.md:3` ("Use when asked to clean up, simplify, slim down or deslop code or tests, or after a big feature to review what it left behind") [seen]. Project chats load every skill (`options.ts:293-298`; `deslop` is "for projects only", `:119-120`) [code]. In the same list: `simplify` ("Review the changed code for reuse, simplification… then apply the fixes"), `code-review`, `improve-codebase-architecture` ("clean up a codebase's architecture") [seen in this session's skill list; their bodies not read].

**What's wrong:** "simplify" and "clean up" each match two or three skills. `simplify` applies fixes at once; `deslop` audits first and waits for a yes. Which one fires on "clean this up" is a coin flip [not checked in a live chat].

**Change:** Lead with what only deslop does and name the others: "Audit, then delete, what piled up in code over many fix-and-retry rounds: repeated tests, checks that can't fail, fallbacks, dead layers. Never changes behaviour; reports first. Use for \"clean up\", \"slim down\" or \"deslop\" of code or tests, and after a big feature. Not for a quick tidy of the current diff (`simplify`) or for restructuring (`improve-codebase-architecture`)."

**Saves:** 0.

### P27 · trigger · image-prompt fires on "mockup" and "icon", where a picture model is the wrong tool

**Where:** `harv/skills/image-prompt/SKILL.md:3` ("…a photo, illustration, logo, icon, wallpaper, poster, sticker, mockup") [seen]. Against `harv/dev-rules.md:19-27` ("Pictures and graphics (icons, illustrations…)": draw from a clean reference, in code) [seen], `apps/server/src/agent/options.ts:200` ("when the user wants a drawing, a diagram, a chart or a small page, make it as a file (SVG, HTML…)") [code], and the `impeccable` / `prototype` skills for UI mockups [seen in the skill list].

**What's wrong:** "Mockup" usually means a UI mockup (HTML), and an app icon in a project is drawn as SVG. The description claims both for Gemini. `prompt-writer` rules itself out for Harv's own pictures (`prompt-writer/SKILL.md:3`); `image-prompt` has no matching "not for".

**Change:** "Write a strong prompt before calling generate_image, and refine from the result. Use whenever the user wants a picture generated: a photo, illustration, wallpaper, poster, sticker, a logo or icon draft. Not for UI mockups, diagrams or charts (make those as HTML or SVG files) and not for prompts to paste into another tool (`prompt-writer`)."

**Saves:** 0.

### P28 · trigger · ui-check, impeccable and the dev rules all claim "review a UI"

**Where:** `harv/skills/ui-check/SKILL.md:3` ("Use when testing, reviewing or verifying a screen, page, app or design, after a UI change, and when the user says something looks off") [seen]; `impeccable` ("critique, audit, polish… UX review") and Claude Code's `run` ("confirm a change works in the real app") [seen in the skill list]; `harv/dev-rules.md:29-35` (P15).

**What's wrong:** "Reviewing a design" and "something looks off" also match `impeccable`. The split is real (ui-check: does it hold up in the real app at real sizes; impeccable: is the design good) but only line 32 of the ui-check body says it. "After a UI change" fires on every small edit, where persona rule 6 ("take a screenshot") is enough.

**Change:** "Test a user interface where its user meets it: the real app, at real sizes, over time. Use for a UI test pass, to verify a UI change before calling it done, and when the user says something looks broken or misaligned. Design quality (hierarchy, style, copy) is `impeccable`." Also: `ui-check` is not in `CHAT_SKILLS` (`options.ts:122-147`) [code], yet `clone` (a chat skill) names it (`clone/SKILL.md:48`); that works only because clone starts a project first (`:42`). Leave as is; noted so nobody "fixes" it.

**Saves:** 0.

### P29 · trigger · Two descriptions are twice as long as the rest

**Where:** `harv/skills/skill-finder/SKILL.md:3` (70 words) and `harv/skills/prompt-writer/SKILL.md:3` (69 words); the other eight are 34–54 [code: `wc -w` of line 3]. Descriptions sit in every chat that lists the skill.

**What's wrong:** prompt-writer lists 14 tool names; one or two per kind trigger as well. skill-finder says its trigger three ways ("Find, review and suggest…", "review ones they send", "shares a skill or tool to check") and ends on "or a task would clearly gain from a skill Harv doesn't have", which invites it to fire unasked in ordinary work.

**Change:** prompt-writer: "Write, fix or adapt a prompt for another AI tool (ChatGPT, Midjourney, Cursor, Suno, a local model…). Use when the user wants a prompt to paste somewhere else, or has one to improve, shorten or move to another tool. Not for pictures Harv makes itself (`image-prompt`)." skill-finder: "Find and review agent skills, MCP servers or tools. Use when the user asks \"is there a skill for X\", wants a new ability, or sends one to check (a GitHub link, a skills.sh page, a video about a skill)."

**Saves:** ~30 + ~30 per chat.

### P30 · trigger · diagnose and the playbook both claim "a first fix didn't work"; fine, but two hops

**Where:** `harv/skills/diagnose/SKILL.md:3` ("…or when a first fix didn't work") and `harv/dev-rules.md:17` (rule 11: "a bug that survived one fix: open `docs/fable-playbook.md`…") [seen]. Playbook 2.4 says "Use the `diagnose` skill with it" (`docs/fable-playbook.md:191`) [seen].

**What's wrong:** No contradiction: the playbook sends Harv on to `diagnose`. But in a project chat the same trigger opens a 6,164-word file to reach a 16-line prompt that names the skill. `diagnose` step 4 ("Three strikes", `:51`) and persona rule 8 (`:22`) already carry "three approaches".

**Change:** Dev rule 11: drop "a bug that survived one fix" from the list (the `diagnose` description already catches it), and name the part to read: "open `docs/fable-playbook.md` in the Harv repo, part 2 (the prompt for that mode) and part 6".

**Saves:** ~5 words; several thousand tokens each time the detour is avoided.

Checked and fine [seen]: `video` vs `skill-finder` (skill-finder calls `video` for a reel, `skill-finder/SKILL.md:20`); `clone` (clear, distinct); `resolve` (clear); `learn-from-session` (`/fresh` exists, `manager.ts:681` [code]); `prompt-writer` vs `image-prompt` from prompt-writer's side.

---

## Personal data

### P31 · personal · No hard personal data; a few soft identifiers

**Where:** A grep of `harv/` for the user's first name, account name and email patterns found nothing [code]. Soft identifiers [seen]:
- `harv/persona.md:9` and `harv/skills/ui-check/SKILL.md:28`, `harv/skills/video/SKILL.md:17`, `harv/skills/prompt-writer/SKILL.md:50`: the user's second language and country.
- `harv/persona.md:7` ("a Windows PC and a Linux notebook"), `harv/skills/resolve/SKILL.md:20` (the notebook's distribution and desktop), `harv/skills/clone/SKILL.md:44` (the plan tier).
- `harv/skills/image-prompt/SKILL.md:14, 34` ("their car"), `harv/dev-rules.md:19` ("a car on a dashboard").
- Outside the audited files but reached from them: `harv/dev-rules.md:17` sends Harv to `docs/fable-playbook.md`, which uses the user's first name throughout (e.g. `:210`, `:318`) [seen]; `apps/server/src/agent/chatTools.ts:69` names one of the user's projects in a comment; tool descriptions name the phone and light brands (`chatTools.ts:434, 465`) [code].

**What's wrong:** None of these identifies a person alone. Together (language, country, hardware, plan, a car project) they narrow it. The rule is "write it as if it were public" [plan].

**Change:** Persona line 9 can stay (the language rule needs the two languages). Replace the country example in prompt-writer with any other ("senior tax adviser in your country"). In the playbook, write "the user" for the first name, as the brief does (`docs/brief/brief.md:3`). The rest: accept, or make generic when the files are next edited.

**Saves:** 0.

---

## If only five things get done

1. P11 + P12 + P19: one safety text per chat instead of three (~375 words per chat).
2. P1: fix `image-prompt` (Harv is refusing something he can do).
3. P13 + P14 + P15 + P23 + P24: slim `dev-rules.md` (~345 words per project chat).
4. P5 + P7: settle "ask first vs call first" and "which memory".
5. P4: move yt-dlp or allow its folder.

Every place that quotes the old wording, to update with a rewrite [code]: `options.ts:152` ("persona rules 16–21"), `gate.ts:414` ("persona rule 19"), `manager.ts:148-150` ("persona rules 13 and 14"), `dev-rules.md:8, 42, 43` ("persona rule 3 / 17 / 4"), `skill-finder/SKILL.md:8`, `CLAUDE.md` ("Persona rules 16–21"), `docs/fable-playbook.md` part 5 (rules 6, 7, 11, 13, 14, 17, 18, 19, 20; dev-rules rule 11).
