# Gotchas

Traps that already cost hours while building Harv. Read the matching part before debugging; add one when a new trap costs you time. The `diagnose` skill keeps a longer, tool-by-tool list in `harv/skills/diagnose/references/gotchas.md`.

## Shells on Windows

- **Git Bash heredocs and `node -e` eat backslashes** (even `<<'EOF'`): Windows paths and `\n` in strings change silently. Write scripts to a file with the Write tool, or use forward slashes. The repo's PreToolUse hook refuses such a heredoc.
- **Python text-mode writes turn LF into CRLF** on Windows. Write in binary mode, or edit with the Edit tool.
- **`sed` on regexes or TypeScript strings** goes wrong with escaping more often than not: use the Edit tool.
- **A piped command hides its exit code** (`npm test | grep …`): check the real exit code before calling a run green.
- **Stopping a background `npm run dev`** can leave orphaned `tsx`/`vite`/`node` processes on ports 4317/4316, and a new server then hangs silently: find them with `netstat -ano` and kill by tree.
- **`MSYS_NO_PATHCONV=1`** for scripts that take arguments starting with `/` in Git Bash (`/model` becomes a path otherwise).

## Node and the Agent SDK

- **Timers stop while a laptop sleeps** (Node's monotonic clock): never aim one long `setTimeout` at a wall-clock time; check the clock in short steps (`usage/meter.ts` `armResume`).
- **`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in the environment makes Claude Code bill per token.** `env.ts` strips them first thing; sessions refuse to run unless `apiKeySource` is `none`/`oauth`.
- **`total_cost_usd` is cumulative per Claude process**: a turn's own cost is the difference from the previous result.
- **Deferred tools are listed by name only**: a model may think it has no web search when it just hasn't loaded it (ToolSearch). Harv's persona says so.
- **Ask a cheap model for a yes/no with an unambiguous field name**: Haiku read `{"asked": true}` as "Harv should ask" and inverted most answers; `{"covered": …}` fixed it. Test such a prompt live on real cases before trusting it.
- **Tests must never make real model calls**: mock `safety/judge.ts` and the classifier; a real call costs plan usage and makes the test flaky.

## The dashboard and the app

- **Editing a non-component web module** (`apps/web/src/lib/*.ts`) reloads the whole page: it looks like a restart, but the server keeps running.
- **Vite's watcher on Windows misses changes** now and then: check what it serves, `touch` the file, else restart.
- **Saving `vite.config.ts` restarts Vite at once** with the new config: change ports and proxies only together with the server and the app.
- **Tauri: a window with several webviews isn't a `WebviewWindow`**: look up the window (`get_window`) and the dashboard (`get_webview("main")`) apart.
- **Tauri commands that build a window must be async** (a sync one deadlocks on Windows), and they run side by side: never rely on their order.
- **`dragDropEnabled` must stay false**, or HTML5 drag and drop inside the page breaks on Windows.
- **CDP screenshots leave out child webviews and the pill** (by design they're out of captures): capture the screen, or check windows with `EnumWindows`.
- **Use `var(--app-h)` instead of `100vh`**, set `scrollLeft` instead of `scrollIntoView` for horizontal scrolling: the root is `overflow-clip` and the window is frameless.

## Hardware sensors

- **LibreHardwareMonitor must run as admin** to read most sensors, and its values are locale-formatted ("45,3 °C"): always parse with `parseLhmValue`.
- **systeminformation is slow on Windows** (seconds per call): processes and volumes only, never on the 1-second tick.

## The safety gate

- **Judge what runs, not what's written**: commit messages, `echo` text and heredoc data mention `rm` and `pkill` without running them (`runningText`, `isTextArgument`).
- **Follow `cd`**: a path after a `cd` is relative to where the `cd` went (`walkCommand`); judging it from the project folder once read `../..` as the home folder.
- **A fix covers the whole kind of problem**: when one command is misjudged, test made-up variants of it too before calling it fixed.

## DaVinci Resolve

- **Never update Resolve past 21.1.0**: the free Console lost `dofile`/`io`/`ffi` in 21.1.1, and Harv's bridge stops answering.
- **Studio-only calls open a blocking dialog** in the free version: test in a throwaway project.
