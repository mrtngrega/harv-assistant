// Draws every Harv icon from one shape (the logo in apps/web/src/components/HarvLogo.tsx: an H whose
// crossbar is Harv's eyes, in a small dark planet): the app and installer icons, the tray's states,
// the phone's Home Screen icons, and prints the favicon for apps/web/index.html.
// Renders through headless Chrome (scripts/ui-check/cdp.mjs). Run: node scripts/make-app-icons.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './ui-check/cdp.mjs';

const ICE = '#A8C8E8';
const AMBER = '#F2B880';
const GREY = '#93a0ad';
const TAURI = fileURLToPath(new URL('../apps/desktop/src-tauri/icons/', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../apps/web/public/', import.meta.url));

/** The logo as SVG. `eyes`: open, look (right), closed or dots; `ground`: an opaque square behind it (Home Screen icons). */
function svg({ rim = ICE, eyes = 'open', eyeFill = '#eef5fb', ground = null, scale = 1, glow = false } = {}) {
  const e =
    eyes === 'closed'
      ? '<rect x="26.6" y="31" width="4.8" height="2" rx="1"/><rect x="32.6" y="31" width="4.8" height="2" rx="1"/>'
      : eyes === 'dots'
        ? '<rect x="27" y="30" width="4" height="4" rx="1"/><rect x="33" y="30" width="4" height="4" rx="1"/>'
        : `<g transform="translate(${eyes === 'look' ? 1.6 : 0} 0)"><rect x="26.1" y="26.5" width="4.4" height="11" rx="2.2"/><rect x="33.5" y="26.5" width="4.4" height="11" rx="2.2"/></g>`;
  const t = scale === 1 ? '' : ` transform="translate(32 32) scale(${scale}) translate(-32 -32)"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><radialGradient id="b" cx="36%" cy="30%" r="78%"><stop offset="0" stop-color="#2c3e51"/><stop offset=".6" stop-color="#16212c"/><stop offset="1" stop-color="#0b1118"/></radialGradient></defs>
${ground ? `<rect width="64" height="64" fill="${ground}"/>` : ''}<g${t}>
${glow ? `<circle cx="32" cy="32" r="30.5" fill="none" stroke="${rim}" stroke-opacity=".35" stroke-width="3"/>` : ''}<circle cx="32" cy="32" r="29" fill="url(#b)" stroke="${rim}" stroke-opacity=".85" stroke-width="2.6"/>
<path d="M8.6 23.4 A25 25 0 0 1 21.4 9.4" fill="none" stroke="#eef5fb" stroke-opacity=".35" stroke-width="2" stroke-linecap="round"/>
<rect x="18.5" y="19" width="5.6" height="26" rx="1.6" fill="${rim}"/><rect x="39.9" y="19" width="5.6" height="26" rx="1.6" fill="${rim}"/>
<g fill="${eyeFill}">${e}</g></g></svg>`;
}

const app = await launch({ width: 600, height: 600 });
await app.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
await app.eval(`document.documentElement.style.background = 'transparent'; document.body.style.margin = '0'`);

async function render(markup, size) {
  await app.eval(
    `document.body.innerHTML = '<img id="i" width="${size}" height="${size}" style="display:block" src="data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}">'; new Promise((r) => { const i = document.getElementById('i'); i.complete ? r() : (i.onload = r); })`,
  );
  const shot = await app.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
  return Buffer.from(shot.data, 'base64');
}

/** An .ico holding PNG images (Windows Vista and later read them). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.png)]);
}

const logo = svg();
for (const [name, size] of [
  ['source.png', 512],
  ['icon.png', 512],
  ['128x128@2x.png', 256],
  ['128x128.png', 128],
  ['32x32.png', 32],
])
  writeFileSync(TAURI + name, await render(logo, size));
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
writeFileSync(
  TAURI + 'icon.ico',
  ico(
    await Promise.all([]).then(async () => {
      const out = [];
      for (const size of icoSizes) out.push({ size, png: await render(logo, size) });
      return out;
    }),
  ),
);

// The tray's states (apps/desktop/src-tauri/src/tray.rs).
const tray = {
  'tray-idle.png': svg(),
  'tray-busy.png': svg({ eyes: 'look', glow: true }),
  'tray-waiting.png': svg({ rim: AMBER, eyeFill: '#fde9d6' }),
  'tray-off.png': svg({ rim: GREY, eyes: 'closed', eyeFill: GREY }),
  'tray-desktop.png': svg({ eyes: 'dots', glow: true }),
};
for (const [name, markup] of Object.entries(tray)) writeFileSync(TAURI + name, await render(markup, 32));

// The phone's Home Screen icons: opaque (iOS fills transparency with black and rounds the corners itself).
const home = svg({ ground: '#0a1018', scale: 0.8 });
for (const size of [180, 192, 512]) writeFileSync(`${PUBLIC}icon-${size}.png`, await render(home, size));

await app.close();
console.log('favicon for apps/web/index.html:');
console.log(`data:image/svg+xml,${encodeURIComponent(svg().replace(/\n/g, ''))}`);
