// Sleeping browser tabs in the app (browser.rs AWAKE): opens pages, lists which sleep, wakes one,
// counts the engine's page processes. Usage: node scripts/ui-check/app-browser-tabs.mjs [port] [pages]
// Leaves the pages it opened closed again.
import { execSync } from 'node:child_process';
import { attach } from './cdp.mjs';

const app = await attach({ port: Number(process.argv[2] ?? 9444) });
const count = Number(process.argv[3] ?? 5);
const invoke = (action, args = {}) =>
  app.eval(`window.__TAURI_INTERNALS__.invoke('browser', ${JSON.stringify({ action, ...args })}).then((v) => JSON.stringify(v))`, true);
const list = async () => JSON.parse(await invoke('list'));
const show = (s) =>
  s.pages.map((p) => `${p.id}${p.id === s.active ? '*' : ''}${p.asleep ? ' asleep' : ' live'} ${p.url.slice(0, 40)}`).join('\n  ');
/** Renderer processes of the page engine (WebView2 on Windows, WebKitGTK on Linux). */
const renderers = () => {
  try {
    return process.platform === 'win32'
      ? Number(
          execSync(
            `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='msedgewebview2.exe'\\" | Where-Object { $_.CommandLine -match 'type=renderer' -and $_.CommandLine -match 'browser-data' }).Count"`,
          )
            .toString()
            .trim(),
        )
      : Number(execSync('pgrep -c WebKitWebProcess').toString().trim());
  } catch {
    return -1;
  }
};

const before = await list();
console.log(`before: ${before.pages.length} tabs, ${renderers()} page renderers`);
const opened = [];
for (let i = 0; i < count; i++) {
  const { id } = JSON.parse(await invoke('open', { url: `https://example.com/?harv-tab=${i}` }));
  opened.push(id);
  await app.sleep(1200);
}
await app.sleep(2000);
let s = await list();
console.log(`after opening ${count}:\n  ${show(s)}\n  renderers: ${renderers()}`);
const live = s.pages.filter((p) => !p.asleep).length;
const sleeping = s.pages.filter((p) => p.asleep);
console.log(`live ${live} (want <= 3), asleep ${sleeping.length}`);
if (sleeping.length) {
  const target = sleeping[0];
  await invoke('select', { id: target.id });
  await app.sleep(3000);
  s = await list();
  const woke = s.pages.find((p) => p.id === target.id);
  console.log(`woke ${target.id}: asleep=${woke?.asleep} url=${woke?.url} active=${s.active === target.id}`);
  const href = await invoke('eval', { id: target.id, script: 'return location.href' });
  console.log(`  page answers: ${href}`);
  console.log(`  live now ${s.pages.filter((p) => !p.asleep).length}`);
}
for (const id of opened) await invoke('close', { id }).catch((e) => console.log('close failed', id, e.message));
await app.sleep(1500);
console.log(`cleaned: ${(await list()).pages.length} tabs, ${renderers()} renderers`);
await app.close();
