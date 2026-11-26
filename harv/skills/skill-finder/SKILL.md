---
name: skill-finder
description: Find, review and suggest agent skills (or MCP servers, tools) for something the user wants to do, and review ones they send (a GitHub link, a skills.sh page, an Instagram or YouTube video about a skill). Use when the user asks "is there a skill for X", wants new abilities, shares a skill or tool to check, or a task would clearly gain from a skill Harv doesn't have.
---

# Skill finder

Skills extend what Harv can do, but each one is code and instructions from a stranger that will run with the user's rights. So: **find well, review hard, install only with the user's OK** (persona rule 12). Never install by yourself, never with a tool's "yes to everything" switch (`npx skills add … -y`). (The search method is adapted from Vercel's find-skills; the review is Harv's own.)

## 1. Check what Harv already has

List `~/.claude/skills` and Harv's own skills (`harv/skills` in the Harv repo). Many "new" skills repeat one Harv has (`deslop`, `clone`, `image-prompt`, `prompt-writer`, `diagnose`, `video`…): then the answer is "you have this: <name>", plus anything the new one does better, worth borrowing.

## 2. Find candidates

- **The leaderboard first:** https://skills.sh ranks skills by installs; the well-used ones are there.
- **Search:** the web and GitHub (`gh search repos "<topic> claude skill" --sort stars`), and skills.sh's own search page. Use specific words ("react testing", not "testing") and try other words when nothing comes up.
- **From a video or post:** get the name and the link from its caption, cover or transcript (`video`). If the creator hands it out only by DM ("comment SKILL"), say so: there's nothing to review, and a guessed repo with a similar name is not it.

## 3. Quality bar

Drop or flag a candidate that fails these:

- **Source:** a known maker (anthropics, vercel-labs, microsoft, a well-known developer) beats an unknown account. Be wary of a repo days old with a huge star count.
- **Use:** skills.sh installs (1K+ is good, under 100 is a risk), GitHub stars, recent commits, open issues answered.
- **License:** an open license (MIT, Apache…). No license means no right to copy it.

## 4. Review before suggesting (read, never run)

Clone it to a fresh temp folder (`git clone --depth 1`) and **read**; run nothing from it. Check:

- **What it really is:** plain instructions (a SKILL.md and Markdown), or does it come with scripts, a CLI, an MCP server, a proxy?
- **Hooks and setup:** does it add hooks (on every tool call, at session start), edit `~/.claude/CLAUDE.md` or settings, install other packages? Each one is a reason to say no or to take only its SKILL.md.
- **Network:** calls home, telemetry, analytics (`grep -ri "telemetry\|posthog\|analytics\|fetch(\|https://"`), downloads at install time (and whether they're checked).
- **Logins and costs:** needs an account, an API key or a paid plan → not for Harv (subscription only).
- **Safety:** anything that runs commands without asking, turns off checks, or installs other skills by itself.
- **Fit:** what it would add to Harv that Harv can't already do, and what it costs in context (a 30 KB skill loads every time it's used).

## 5. Tell the user

For each candidate, a few lines: **what it does**, where it's from (link, stars or installs, license), **what the review found**, and a verdict:

- **Add**: worth installing as is.
- **Take ideas**: install nothing; copy the good parts into Harv's own skills or rules (say which and what).
- **Skip**: and why (overlap, hooks, paid, unsafe, DM-only).

A request that came from a list (the user's Instagram reels) gets one note each in `harv_skills.md` with `report_note` and `skill_review: true` (the user's own `harv_report.md` stays for bugs and wishes).

## 6. Installing (only after the user's yes)

- Plain skill folders only: copy the reviewed folder (the exact commit you read) into `~/.claude/skills/<name>`. No plugins, no hooks, no `npx … -y`.
- A skill shows in normal Harv chats only once it's on Harv's list of chat skills (`CHAT_SKILLS` in `apps/server/src/agent/options.ts`); project chats see every skill. Say that a Harv dev session needs to add it, or add it yourself when you're working on Harv.
- Note the review in Harv's docs (`docs/PLAN.md` §6ab) so the next look starts from it.
