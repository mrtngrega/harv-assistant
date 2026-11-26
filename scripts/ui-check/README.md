# UI checks

Small scripts for looking at the running dashboard the way a person would, without touching the user's own browser. They drive a separate headless Chrome (its own profile in `out/`) over the DevTools protocol (`cdp.mjs`, using the `ws` package already in the repo). Screenshots land in `out/shots/` (gitignored); open them to look.

**In the Harv app** (start it with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9444`; these `attach()` to it):

| Script | What it does |
|---|---|
| `app-look.mjs [port] [name] [--reload]` | A screenshot and where the tab bar's context label sits; `--reload` screenshots the first two seconds after a reload. |
| `app-startup.mjs [port]` | The first second after a reload, frame by frame as text: tabs, empty state, dialogs. |
| `app-tabs.mjs [port] [--reload]` | The tabs right now: order, the active one, lines in each, a start question. |
| `app-browser-tabs.mjs [port] [pages]` | Sleeping browser tabs in the app: opens pages, lists live/asleep, wakes one, counts the engine's page processes, closes what it opened. |
| `app-browser-download.mjs [port]` | Downloads in the app's browser: serves a page with a file link on 127.0.0.1, clicks it, prints where the file landed and the Browser view's download notice (deletes the file, closes the page). |
| `app-browser-reorder.mjs [port]` | Dragging browser tabs in the app: opens three pages, shows a chat's Browser view, drags tabs with real HTML5 drag events and checks the strip and the app's own order (`browser.rs` "move"); closes what it opened. |
| `app-chat.mjs <port> <shot> "<message>"…` | Sends messages in a chat and waits for each reply (uses the plan: `/haiku /low` only; Git Bash needs `MSYS_NO_PATHCONV=1`). |
| `app-pass.mjs` | A look pass: Settings section by section, the chat at several widths with the stats panel narrow and wide, live values watched for layout shifts; puts the window back as it was. |
| `notices.mjs [port] [tab title]` | Harv's notices with made-up ones handed to the app's own feed (no plan usage): a normal one under his face and its fade, three at once (urgent first, "+2"), the open detail, Recent behind the logo. |
| `centering.mjs [port] [state] [WxH]` | Every small button's icon measured against the button's middle (0.75 px or more is listed), and boxed elements closer than 3 px to a divider. `VERBOSE=1` prints every control. |

**In a headless dashboard** (its own Chrome profile in `out/`; fake server messages, no plan usage, nothing saved):

| Script | What it does |
|---|---|
| `shots.mjs [widths…]` | Screenshots at 420/1100/1280/1500 px, stats panel collapsed and expanded; reports sideways overflow and a page that scrolled by itself. |
| `watch-shifts.mjs [width] [seconds]` | Watches the stats panel (`aside[aria-label^="System and plan"]`) while values tick and reports vertical layout shifts. |
| `status-line.mjs [width]` | The status line above the command line, idle and during a fake turn. |
| `strip-align.mjs [width] [--app]` | The rows above the command line (fake background tasks + the status line): each piece's offset from its row's centre line, space above/below each band, start and end x. `--app` measures the Harv app (CDP 9444). |
| `approval-card.mjs [width]` | A fake approval card in the log and over the Files view. |
| `watchdog-toast.mjs [width]` | Fake watchdog alerts (a CPU hog warning, a Defender threat) as toasts. |
| `presence.mjs [width] [--battery] [--still]` | Harv presence through `window.harvPresence`: each state, and frames drawn at rest and while working. |
| `tab-drag-mouse.mjs` | Real mouse drags of chat tabs; reports the order after each drop. |

**Against the server** (no browser):

| Script | What it does |
|---|---|
| `busy.mjs` | Is a chat replying? Exit 0 when Harv is idle: check before a restart (no tokens). |
| `usage.mjs` | The Claude plan meters Harv knows (no tokens). |
| `send.mjs <tabId> "<message>"` | Sends one message as the dashboard does and waits for the reply (uses the plan: `/haiku /low`). |
| `talk.mjs [port]` | Push-to-talk in the app without sending: the mic button on the `harv>` line, click-talk-click fills the line, the hold key starts a recording (~2 s of the real mic, thrown away). |
| `speak.mjs [port] [question]` | Harv speaking in the app: one spoken turn like the talk key sends, then when the audio starts and ends (one small model turn; you hear it). |
| `delete-chat.mjs <tabId> [...]` | Deletes test chats (after `send.mjs`), as the History's delete does (no tokens). |

**On Linux:**

| Script | What it does |
|---|---|
| `bash battery.sh <label>` | 10 s average CPU of the Harv app and its WebKit process, and GPU busy %. Change one setting between runs to see what costs battery (docs/PLAN.md §6p). |
| `python3 webkit-drive.py <steps.json> <outdir>` | Drives the dashboard in WebKitGTK, the Linux app's engine (no CDP there): resize, JS, wait and screenshot steps. Run with `GDK_BACKEND=x11`. |

**Everything at once:** `smoke.mjs [--app] [--rust] [--quick]` runs every check above that uses no plan usage (typecheck, lint, tests, the server, the headless dashboard; with flags the app on port 9444 and cargo fmt/clippy) and writes one report to `out/smoke-<date>.md`; exit 1 when a step shows a problem. `smoke-health.mjs` is its one-line health check (server, version, dashboard). Use it at the start of a review session (`docs/review/test-scenarios.md`) and before handing work over.

All run as `node scripts/ui-check/<script>` from the repo root.

For a custom check, import `launch` from `cdp.mjs`: `goto`, `click(selector, text?)`, `type`, `key`, `eval`, `shot(name)`, `logs`.

Notes:
- The dashboard's layout is shared with the user's open window (it's saved on the server), so a check that opens tabs or changes views should close what it opened.
- `click` calls `scrollIntoView` on its target; the app root is `overflow-clip`, so that can't shift the page any more.
- Checks that send messages to Harv use the user's plan; prefer Haiku·low and say so.
- CDP clicks give the app's page the focus back (`document.hasFocus()` turns true even with the window minimized). To test what happens while Harv's window isn't in front (the desktop pill), override `document.hasFocus = () => false` and dispatch `blur`, then reload the page afterwards. Chats sent with `send.mjs` don't become tabs at once; use a real tab (`app-chat.mjs` after clicking New chat) and delete test chats after.
- The desktop pill and the glow are out of screen captures: read the pill's page over CDP (a `pill.html` target on the app's debug port) or check visibility with `EnumWindows` (title "Harv is using your desktop"). `node scripts/pill-demo.mjs` plays every state.
- Works on Windows and Linux: it finds Chrome (or Chromium) itself; `HARV_CHROME=/path/to/chrome` picks another.
- To call the app's own stores from a check (`chat.setActive`, `openPreview`), import the module URL the page loaded (`performance.getEntriesByType('resource')`, the `?t=` one if there is one): after an edit Vite serves it with `?t=`, and a plain `import('/src/lib/x.ts')` gives a second copy with its own empty state.
