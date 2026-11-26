---
about: how Harv reviews a new skill, tool or MCP server before anything is installed
keys: new skill, skill review, mcp server, install a skill, plugin
updated: <setup date>
---
Before a new outside skill, tool or MCP server goes in: review it with the `skill-finder` skill (what it does, its code and scripts, hooks, network calls, telemetry, costs, whether it touches logins), give a verdict in a few lines, and install only with the user's OK. Prefer plain skill folders in `~/.claude/skills` over plugins with hooks. Never anything that needs a paid key or bills per use. Save each verdict with report_note (skill_review true) so it isn't reviewed twice.
