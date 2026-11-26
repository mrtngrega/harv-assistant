// Downloads in Harv's browser (browser.rs on_download): serves a page on 127.0.0.1 with a file
// link, clicks it in the app's browser, and prints what the app remembers (where the file landed,
// done or failed). Usage: node scripts/ui-check/app-browser-download.mjs [port]
// Deletes the file it downloaded and closes the page it opened.
import { createServer } from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';
import { attach } from './cdp.mjs';

const NAME = 'harv-download-check.txt';
const server = createServer((req, res) => {
  if (req.url === '/file') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${NAME}"` });
    res.end('A test file from scripts/ui-check/app-browser-download.mjs.\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<title>Download check</title><a id="get" href="/file">Get the file</a>');
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/`;

const app = await attach({ port: Number(process.argv[2] ?? 9444) });
const invoke = (action, args = {}) =>
  app.eval(`window.__TAURI_INTERNALS__.invoke('browser', ${JSON.stringify({ action, ...args })}).then((v) => JSON.stringify(v))`, true);
const list = async () => JSON.parse(await invoke('list'));
// The chat store copy the page itself runs (Vite serves an edited one with ?t=).
const chatStore = `(await import(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/lib/chatStore.ts')).sort((a, b) => (b.includes('?t=') ? 1 : 0) - (a.includes('?t=') ? 1 : 0) || b.localeCompare(a))[0] ?? '/src/lib/chatStore.ts'))`;

const before = (await list()).downloads ?? [];
const { id } = JSON.parse(await invoke('open', { url }));
// The active chat shows its Browser view, for the toolbar's download notice.
const tabId = JSON.parse(
  await app.eval(
    `(async () => { const m = ${chatStore}; const id = m.chat.ensureTab(); m.chat.setView(id, 'browser'); return JSON.stringify(id); })()`,
    true,
  ),
);
await app.sleep(2500);
await invoke('eval', { id, script: "document.getElementById('get').click(); return true" });
let mine = [];
for (let i = 0; i < 20; i++) {
  await app.sleep(500);
  mine = ((await list()).downloads ?? []).filter((d) => !before.some((b) => b.id === d.id));
  if (mine.length && mine.every((d) => d.state !== 'downloading')) break;
}
console.log(mine.length ? mine.map((d) => `${d.state}: ${d.path}`).join('\n') : 'no download reported (old app, or the engine refused it)');
for (const d of mine) {
  const there = existsSync(d.path);
  console.log(`  file there: ${there}`);
  if (there && d.path.endsWith('.txt') && d.path.includes('harv-download-check')) unlinkSync(d.path);
}
await app.sleep(500);
const notice = await app.eval(
  `JSON.stringify([...document.querySelectorAll('button')].filter((b) => b.textContent.startsWith('↓')).map((b) => ({ text: b.textContent, title: b.title })))`,
);
console.log(`toolbar notice: ${notice}`);
console.log(`screenshot: ${await app.shot('browser-download')}`);
await invoke('close', { id });
await app.eval(`(async () => { const m = ${chatStore}; m.chat.setView(${JSON.stringify(tabId)}, 'chat'); return 'ok'; })()`, true);
await app.close();
server.close();
