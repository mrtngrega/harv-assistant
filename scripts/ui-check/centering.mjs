// Finds small layout faults in the app by measuring, not by eye (the 2026-11-10 request: "find everything"):
//  - icons not centred in their buttons: each small button is screenshotted, the icon's ink is found
//    (pixels brighter than the button's own background), and its centre compared with the button's;
//  - boxes crowding a divider: a bordered box (chip, card, input) closer than 3 px to a horizontal
//    divider line it doesn't belong to.
// Usage: node scripts/ui-check/centering.mjs [port] [label]   (the app with --remote-debugging-port)
import { attach } from './cdp.mjs';

const app = await attach({ port: Number(process.argv[2] ?? 9444) });
const label = process.argv[3] ?? 'screen';
// A real size even when the window is minimized (the user's app window, 1326x718 by default).
const [w, h] = (process.argv[4] ?? '1326x718').split('x').map(Number);
await app.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
await app.sleep(500);

async function check(state) {
  // Small controls with an icon or one or two characters (×, ‹, ⟳, svg).
  const controls = JSON.parse(
    await app.eval(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, [role=button], a, [role=radio], [role=tab] > button')) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.width > 48 || r.height > 48 || r.width < 10 || r.height < 10) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || +cs.opacity < 0.2) continue;
      const text = el.textContent.trim();
      if (!el.querySelector('svg') && (text.length === 0 || text.length > 2)) continue;
      el.dataset.uicheck = String(out.length);
      out.push({ name: (el.getAttribute('aria-label') || el.title || text).slice(0, 30), x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return JSON.stringify(out);
  })()`),
  );

  const off = [];
  for (const c of controls) {
    // Only the icon counts: the button's own border, fill and shadow are hidden while it's captured.
    const i = controls.indexOf(c);
    await app.eval(
      `(() => { const el = document.querySelector('[data-uicheck="${i}"]'); el.dataset.style = el.getAttribute('style') ?? ''; el.style.cssText += ';border-color:transparent!important;background:transparent!important;box-shadow:none!important;outline:none!important;transition:none!important'; return 1 })()`,
    );
    await app.sleep(60);
    const { data } = await app.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 2 },
    });
    await app.eval(
      `(() => { const el = document.querySelector('[data-uicheck="${i}"]'); el.setAttribute('style', el.dataset.style); delete el.dataset.style; delete el.dataset.uicheck; return 1 })()`,
    );
    // The ink's box, read in the page: pixels clearly brighter than the button's own background
    // (2 px inset skips its border; the background is the darkest common tone).
    const ink = JSON.parse(
      await app.eval(`new Promise((done) => { const img = new Image(); img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
      const g = cv.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, cv.width, cv.height).data;
      const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const inset = 0, vals = [];
      for (let y = inset; y < cv.height - inset; y++) for (let x = inset; x < cv.width - inset; x++) vals.push(lum((y * cv.width + x) * 4));
      vals.sort((a, b) => a - b); const bg = vals[Math.floor(vals.length * 0.3)] ?? 0;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = inset; y < cv.height - inset; y++) for (let x = inset; x < cv.width - inset; x++) if (lum((y * cv.width + x) * 4) > bg + 45) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      done(JSON.stringify(x1 < 0 ? null : { dx: ((x0 + x1) / 2 - cv.width / 2) / 2, dy: ((y0 + y1) / 2 - cv.height / 2) / 2 }));
    }; img.src = 'data:image/png;base64,${data}'; })`),
    );
    if (process.env.VERBOSE) console.log(c.name, Math.round(c.w) + 'x' + Math.round(c.h), JSON.stringify(ink));
    if (ink && (Math.abs(ink.dx) >= 0.75 || Math.abs(ink.dy) >= 0.75))
      off.push(
        `${c.name} (${Math.round(c.w)}x${Math.round(c.h)} at ${Math.round(c.x)},${Math.round(c.y)}): ink ${ink.dx > 0 ? '+' : ''}${ink.dx}px x, ${ink.dy > 0 ? '+' : ''}${ink.dy}px y`,
      );
  }

  // Bordered boxes closer than 3 px to a horizontal divider (a full-width border line) above or below them.
  const crowded = JSON.parse(
    await app.eval(`(() => {
    const lines = [];
    for (const el of document.querySelectorAll('div, section, header, form, nav')) {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (r.width < 200 || !r.height) continue;
      if (parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none') lines.push({ y: r.top, x0: r.left, x1: r.right, el });
      if (parseFloat(cs.borderBottomWidth) >= 1 && cs.borderBottomStyle !== 'none') lines.push({ y: r.bottom, x0: r.left, x1: r.right, el });
    }
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (!r.width || r.width > 600 || r.height > 120 || r.height < 12) continue;
      const boxed = parseFloat(cs.borderTopWidth) >= 1 && parseFloat(cs.borderBottomWidth) >= 1;
      if (!boxed || r.bottom < 0 || r.top > innerHeight) continue;
      for (const l of lines) {
        if (l.el.contains(el) && (Math.abs(l.y - r.top) < 0.5 || Math.abs(l.y - r.bottom) < 0.5)) continue;
        if (l.el === el || el.contains(l.el) || l.x1 < r.left || l.x0 > r.right) continue;
        const gap = l.y >= r.bottom ? l.y - r.bottom : r.top - l.y;
        if (gap >= 0 && gap < 3) { out.push((el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 30) + ' @' + Math.round(r.left) + ',' + Math.round(r.top) + ' gap ' + gap.toFixed(1)); break; }
      }
    }
    return JSON.stringify([...new Set(out)].slice(0, 20));
  })()`),
  );

  console.log(`[${state}] ${controls.length} small controls checked`);
  console.log(off.length ? `off-centre:\n  ${off.join('\n  ')}` : 'off-centre: none');
  console.log(crowded.length ? `crowding a divider:\n  ${crowded.join('\n  ')}` : 'crowding a divider: none');
}

const click = (sel, text) =>
  app.eval(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => (x.getAttribute('aria-label') || '') === ${JSON.stringify(text)} || x.textContent.trim().startsWith(${JSON.stringify(text)})); e?.click(); return !!e })()`,
  );
const states = [
  ['main', async () => {}],
  ['history', () => click('button', 'Expand history')],
  [
    'stats',
    async () => {
      await click('button', 'Collapse history');
      await click('button', 'Expand system panel');
    },
  ],
  [
    'settings',
    async () => {
      await click('button', 'Collapse system panel');
      await click('button', 'Settings');
    },
  ],
  [
    'explorer',
    async () => {
      await click('button', 'Close Settings');
      await click('[role=radio]', 'File Explorer');
    },
  ],
  [
    'project menu',
    async () => {
      await click('[role=radio]', 'Chat');
      await click('button[aria-haspopup="menu"]', '');
    },
  ],
];
const only = label === 'screen' ? null : label;
for (const [state, go] of states) {
  await go();
  await app.sleep(900);
  if (!only || only === state) await check(state);
}
await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await app.send('Emulation.clearDeviceMetricsOverride');
await app.close();
