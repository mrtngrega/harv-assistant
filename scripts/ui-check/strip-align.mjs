// Measures the rows just above the command line (background tasks, the status line, plan mode): every
// piece in a row should sit on the row's centre line, each band should have the same space above and
// below its rows, and the rows should start and end at the same x.
// Prints, per row: each piece's box centre and (for glyphs/icons) ink centre, as px off the row's centre.
// Usage: node scripts/ui-check/strip-align.mjs [width]   a headless page (needs Harv running and a chat
//          open); fake server messages go to its own WebSocket: nothing reaches Harv, no plan usage.
//        node scripts/ui-check/strip-align.mjs --app     the Harv app on CDP port 9444: fake tasks go only
//          to the app's own chat store and are cleared at the end; the status line stays as it is.
import { attach, launch } from './cdp.mjs';

const inApp = process.argv.includes('--app');
const width = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 1326);
const page = inApp ? await attach({ port: 9444 }) : await launch({ width, height: 718 });

const storeUrl = `performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/lib/chatStore.ts'))`;
if (!inApp) {
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (...args) { const ws = new Real(...args); if (String(args[0]).endsWith("/ws")) window.__harvSocket = ws; return ws; };
    window.WebSocket.prototype = Real.prototype;
    Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 });
  })();`,
  });
  await page.goto('http://127.0.0.1:4316/');
  for (let i = 0; i < 40 && !(await page.eval('typeof window.__harvSocket?.onmessage === "function"')); i++) await page.sleep(250);
}
const tabId = await page.eval(`import(${storeUrl}).then((m) => m.getChatState().activeId)`);
if (!(await page.eval(`!!document.querySelector('[role=status][aria-label^="Harv is"]')`))) {
  console.log('No status line: open a chat in Harv and run this again.');
  if (!inApp) await page.close();
  process.exit(1);
}
// The app: straight into its store (its socket is real). Headless: through the page's socket, like the server.
const fake = (msg) =>
  inApp
    ? page.eval(`import(${storeUrl}).then((m) => (m.applyChatEvent(${JSON.stringify({ tabId, ...msg })}), true))`)
    : page.eval(`(window.__harvSocket.onmessage({ data: ${JSON.stringify(JSON.stringify({ tabId, ...msg }))} }), true)`);

const now = Date.now();
if (!inApp) {
  await fake({ type: 'chat.started', model: 'Sonnet 5.5', effort: 'medium', auto: true, reason: 'test' });
  await fake({ type: 'chat.progress', outputTokens: 340 });
}
await fake({
  type: 'chat.tasks',
  tasks: [
    {
      id: 't1',
      kind: 'local_agent',
      agent: 'general-purpose',
      description: 'Research Garmin Connect OS customization',
      status: 'running',
      startedAt: now - 104_000,
      lastTool: 'WebFetch',
    },
    {
      id: 't2',
      kind: 'local_bash',
      description: 'npm test',
      status: 'completed',
      startedAt: now - 30_000,
      endedAt: now - 2000,
      summary: 'all green',
    },
    {
      id: 't3',
      kind: 'local_agent',
      agent: 'Explore',
      description: 'Find the radio API',
      status: 'failed',
      startedAt: now - 50_000,
      endedAt: now - 1000,
    },
  ],
});
// Messages sent mid-reply: one still editable, one already handed to Harv.
await fake({
  type: 'chat.queued',
  items: [
    { id: 'q1', text: 'also check the fan curve', at: now },
    { id: 'q2', text: 'and skip the tests', at: now, handed: true },
  ],
});
await page.sleep(1200);

async function inkDy(r) {
  const { data } = await page.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 2 },
  });
  return JSON.parse(
    await page.eval(`new Promise((done) => { const img = new Image(); img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
      const g = cv.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, cv.width, cv.height).data;
      const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const vals = []; for (let i = 0; i < d.length; i += 4) vals.push(lum(i)); vals.sort((a, b) => a - b);
      const bg = vals[Math.floor(vals.length * 0.3)] ?? 0; let y0 = 1e9, y1 = -1;
      for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (lum((y * cv.width + x) * 4) > bg + 40) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      done(JSON.stringify(y1 < 0 ? null : ((y0 + y1) / 2 - cv.height / 2) / 2));
    }; img.src = 'data:image/png;base64,${data}'; })`),
  );
}

const { rows, bands } = JSON.parse(
  await page.eval(`(() => {
  const status = document.querySelector('[role=status][aria-label^="Harv is"]');
  const queue = document.querySelector('[aria-label="Queued messages"]');
  const list = document.querySelector('[aria-label="Background tasks"]');
  const lists = [queue, list].filter(Boolean);
  const rows = [...(queue ? queue.children : []), ...(list ? list.children : []), status];
  // A band's divider to its first row, and its last row to the next band's divider.
  const bands = [queue, list, status].filter(Boolean).map((b) => {
    const isList = lists.includes(b);
    const r = b.getBoundingClientRect(), first = (isList ? b.firstElementChild : b).getBoundingClientRect();
    const last = (isList ? b.lastElementChild : b), lr = last.getBoundingClientRect(), lcs = getComputedStyle(last);
    const contentBottom = isList ? lr.bottom : lr.bottom - parseFloat(lcs.paddingBottom);
    const contentTop = isList ? first.top : first.top + parseFloat(getComputedStyle(b).borderTopWidth) + parseFloat(getComputedStyle(b).paddingTop);
    return { name: b.getAttribute('aria-label').slice(0, 30), above: +(contentTop - r.top - 1).toFixed(1), below: +(r.bottom - contentBottom).toFixed(1) };
  });
  return JSON.stringify({ bands, rows: rows.map((row) => {
    const rr = row.getBoundingClientRect(), cs = getComputedStyle(row);
    const top = rr.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop), bottom = rr.bottom - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
    const mid = (top + bottom) / 2;
    const leaves = [...row.querySelectorAll('span, button')].filter((el) => !el.querySelector('span, button') && el.getBoundingClientRect().width > 0);
    const pieces = leaves.map((el) => { const r = el.getBoundingClientRect(); const glyph = el.textContent.trim().length <= 1 || !!el.querySelector('svg');
      return { text: (el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 24), glyph, box: +((r.top + r.bottom) / 2 - mid).toFixed(2), h: +r.height.toFixed(1), x: r.left, w: r.width,
        fs: getComputedStyle(el).fontSize, lh: getComputedStyle(el).lineHeight };
    });
    return { name: (row.getAttribute('aria-label') || row.textContent).slice(0, 40), top, bottom, left: pieces[0]?.x, right: Math.max(...pieces.map((p) => p.x + p.w)), pieces };
  }) });
})()`),
);

let worst = 0;
for (const row of rows) {
  console.log(`\n${row.name}  (content ${row.top.toFixed(1)}–${row.bottom.toFixed(1)}, x ${row.left?.toFixed(1)}–${row.right.toFixed(1)})`);
  for (const p of row.pieces) {
    const ink = p.glyph ? await inkDy({ x: p.x, y: row.top, w: Math.max(p.w, 4), h: row.bottom - row.top }) : null;
    worst = Math.max(worst, Math.abs(p.box), Math.abs(ink ?? 0));
    console.log(
      `  ${p.text.padEnd(26)} box ${p.box >= 0 ? '+' : ''}${p.box} (h ${p.h}, ${p.fs}/${p.lh})${ink === null ? '' : `  ink ${ink >= 0 ? '+' : ''}${ink}`}`,
    );
  }
}
console.log('');
for (const b of bands) console.log(`band "${b.name}": ${b.above}px above its rows, ${b.below}px below`);
console.log(`worst offset: ${worst.toFixed(2)} px`);
if (inApp) {
  await fake({ type: 'chat.tasks', tasks: [] });
  await fake({ type: 'chat.queued', items: [] });
  page.close?.();
} else await page.close();
