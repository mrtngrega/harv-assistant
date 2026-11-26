# Security

Harv runs on your own computer with your own Claude Code login. It is never hosted, and it never reads, stores or sends your credentials.

## What stays out of this repository

- Your Claude login (`~/.claude/.credentials.json`), GitHub token (Windows' credential store) and any other login: Harv's gate refuses to read their contents.
- Everything personal Harv keeps: memory, chats, settings, backups, logs. It all lives in `~/.harv`, outside the repo.
- `.env` files, keys and credential files are in `.gitignore`.

## What Harv guards against

- **Billing:** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from Harv's environment at start, and a chat that isn't on your subscription login refuses to run.
- **The network:** Harv's server and dashboard listen on `127.0.0.1` only, and refuse foreign `Origin`, `Host` and cross-site requests (DNS rebinding included).
- **Its own actions:** every tool call goes through the permission gate (`apps/server/src/safety/`): three hard stops, held steps that wait for your yes, backups and Undo for the rest.

## Pull requests

Read every change line by line before you merge it: code here runs on your PC with your login. Never merge one blind, and be most careful with anything that touches `safety/`, `env.ts`, the server's request checks, install steps or scripts.

## Reporting a problem

Found a security issue? Please report it privately through this repository's **Security › Report a vulnerability** page instead of opening a public issue.
