// Shows everything Harv's desktop pill does (pass C, C2), in ~50 s, and explains each step here.
// The Harv app must be open (Windows; Linux has no pill: KDE Wayland can't pin a window on top).
//   node scripts/pill-demo.mjs
// Nothing real happens: no model call, no chat, no action. The demo runs even with Harv's window in front.

const STEPS = [
  [0, 'Working, thinking', 'His face with two eyes of light. While he thinks, the eyes scan left and right.'],
  [
    5,
    'Working, a tool',
    'The text says what he is doing. The six dots on the right are his moons (memory, files, shell, web, helpers, desktop): the lit one is the kind of tool in use.',
  ],
  [9.5, 'Several chats', '"+2" after the chat name: two more chats are working too. The pill shows the newest one.'],
  [14, 'Another moon', 'A web search lights the web moon.'],
  [
    18.5,
    'Waiting for your yes',
    'Amber, eyes looking down: something waits for your yes (or an answer) in that chat. Click the pill to open it.',
  ],
  [25, 'Still waiting: the dot', 'After 8 s the wait shrinks to a small amber dot, so it stays out of the way. Still clickable.'],
  [31, 'Asleep at a plan limit', 'Eyes closed and a drifting z: the plan limit is reached; work waits until it resets.'],
  [37, 'Replied', 'Happy closed eyes for ~6 s: a reply just ended while you were somewhere else. Then the pill goes away.'],
  [
    42,
    'Desktop control',
    "The same window becomes desktop control's pill: crosshair eyes, what he does with mouse and keyboard, and STOP (a real button). Harv's own window steps aside while he acts on its monitor and comes back after.",
  ],
  [50, 'Done', 'Back to normal: nothing at rest.'],
];

const res = await fetch('http://127.0.0.1:4317/api/pill/demo', {
  method: 'POST',
  headers: { Origin: 'http://127.0.0.1:4316', 'Content-Type': 'application/json' },
  body: '{}',
}).catch((e) => ({ ok: false, statusText: e.message }));
if (!res.ok) {
  console.log(`Harv isn't reachable (${res.statusText}). Start Harv and open the app, then run this again.`);
  process.exit(1);
}

console.log(`Harv's desktop pill: watch the top centre of the screen Harv's window is on.

How it works:
- It shows only while Harv's window is NOT in front (minimized, in the tray, or another app on top).
  With Harv in front, the hammock in the chat and the status line say it instead.
- Nothing at rest. It's always on top of other windows while shown, never takes the focus,
  and stays out of screenshots (Harv's own and yours).
- A full-screen app in front (a game, a video) hides it; it comes back when that app goes.
- Click it to open the chat it's about. During desktop control only STOP reacts.
- ︿ at its right end slides it up out of the way: a small arrow tab stays at the top edge of the
  screen (amber when something waits for you). Click the arrow to bring the pill back. It stays
  up until you do; desktop control's pill can't be hidden (STOP is always there).
`);
const start = Date.now();
for (const [at, title, text] of STEPS) {
  const wait = at * 1000 - (Date.now() - start);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  console.log(`${String(at).padStart(4)} s  ${title}\n        ${text}\n`);
}
