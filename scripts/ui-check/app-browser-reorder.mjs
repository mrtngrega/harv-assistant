// Dragging browser tabs to a new place in the app (BrowserView + browser.rs "move"): opens three pages,
// shows a chat's Browser view, drags the first tab past the last and the last to the front with real
// HTML5 drag events, and checks the order the app keeps. Usage: node scripts/ui-check/app-browser-reorder.mjs [port]
// Closes the pages it opened and puts the chat's view back.
import { attach } from './cdp.mjs';

const app = await attach({ port: Number(process.argv[2] ?? 9444) });
const invoke = (action, args = {}) =>
  app.eval(`window.__TAURI_INTERNALS__.invoke('browser', ${JSON.stringify({ action, ...args })}).then((v) => JSON.stringify(v))`, true);
const list = async () => JSON.parse(await invoke('list'));

const opened = [];
for (let i = 0; i < 3; i++) {
  const { id } = JSON.parse(await invoke('open', { url: `https://example.com/?harv-reorder=${i}` }));
  opened.push(id);
  await app.sleep(800);
}
// Show the Browser view in the active chat.
const tabId = JSON.parse(
  await app.eval(
    `import('/src/lib/chatStore.ts').then((m) => { const id = m.chat.ensureTab(); m.chat.setView(id, 'browser'); return JSON.stringify(id); })`,
    true,
  ),
);
await app.sleep(1500);

const stripIds = async () =>
  JSON.parse(
    await app.eval(
      `JSON.stringify([...document.querySelectorAll('[data-tab]')].map((t) => t.dataset.tab).filter((id) => /^\\d+$/.test(id)).map(Number))`,
    ),
  );
/** Drags tab `id` to just past (after) or before tab `target` with HTML5 events, as a mouse would. */
const drag = (id, target, after) =>
  app.eval(
    `(() => {
    const el = document.querySelector('[data-tab="${id}"]');
    const to = document.querySelector('[data-tab="${target}"]');
    const r = to.getBoundingClientRect();
    const x = ${after} ? r.right - 4 : r.left + 4, y = r.top + r.height / 2;
    const dt = new DataTransfer();
    const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    fire(el, 'dragstart');
    return new Promise((done) => setTimeout(() => { fire(to, 'dragover'); setTimeout(() => { fire(to, 'drop'); fire(el, 'dragend'); done('ok'); }, 50); }, 50));
  })()`,
    true,
  );

const ours = (ids) => ids.filter((id) => opened.includes(id));
const [a, b, c] = opened;
let ok = true;
const check = async (label, want) => {
  await app.sleep(600);
  const strip = ours(await stripIds());
  const kept = ours((await list()).pages.map((p) => p.id));
  const good = JSON.stringify(strip) === JSON.stringify(want) && JSON.stringify(kept) === JSON.stringify(want);
  ok &&= good;
  console.log(`${good ? 'OK ' : 'BAD'} ${label}: strip ${strip} app ${kept} (want ${want})`);
};
await check('start', [a, b, c]);
await drag(a, c, true);
await check('first tab dragged past the last', [b, c, a]);
await drag(a, b, false);
await check('last tab dragged to the front', [a, b, c]);
await drag(b, b, false);
await check('dropped on itself: no change', [a, b, c]);

for (const id of opened) await invoke('close', { id }).catch(() => {});
await app.eval(`import('/src/lib/chatStore.ts').then((m) => { m.chat.setView(${JSON.stringify(tabId)}, 'chat'); return 'ok'; })`, true);
console.log(ok ? 'all good' : 'FAILED');
await app.close();
process.exit(ok ? 0 : 1);
