// PreToolUse hook for Bash in this repo (.claude/settings.json): refuses a heredoc whose body has a
// backslash. Git Bash heredocs (even quoted <<'EOF') silently lose or mangle backslashes, so a regex,
// "\n" in a string or a Windows path changes on the way into the file. It happened 15+ times
// (2026-11-09 … 11-13) although CLAUDE.md and memory warned. The fix that always works: write the
// script with the Write tool (scratchpad), then run it.
let text = '';
for await (const chunk of process.stdin) text += chunk;
let command = '';
try {
  command = JSON.parse(text).tool_input?.command ?? '';
} catch {
  process.exit(0);
}
// Each heredoc: from the line after `<<WORD` / `<<'WORD'` / `<<-"WORD"` to the line that is WORD.
const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
let bad = false;
for (const m of command.matchAll(opener)) {
  const start = command.indexOf('\n', m.index);
  if (start < 0) continue;
  const end = command.slice(start + 1).search(new RegExp(`^\\s*${m[2]}\\s*$`, 'm'));
  const body = end < 0 ? command.slice(start + 1) : command.slice(start + 1, start + 1 + end);
  if (body.includes('\\')) bad = true;
}
if (bad) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'This heredoc has a backslash, and Git Bash heredocs mangle backslashes (regexes, \\n in strings, Windows paths). Write the script or text with the Write tool (into the scratchpad), then run it.',
      },
    }),
  );
}
