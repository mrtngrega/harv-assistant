// Harv presence (docs/review/pass-c.md C1) in a headless dashboard, driven through the dev-only
// `window.harvPresence` handle: no Claude turn, no plan usage. Screenshots each state, and counts
// frames drawn at rest and while working (the battery check), and catches the slide half-way.
// Usage: node scripts/ui-check/presence.mjs [width] [--battery] [--still]
import { launch } from './cdp.mjs';

const width = Number(process.argv[2]) || 1280;
const page = await launch({ width, height: 860, port: 9343, profile: 'presence-profile' });
await page.goto('http://127.0.0.1:4316/');
await page.sleep(3000);
// A chat on screen (this window may have kept Settings open).
await page.eval('[...document.querySelectorAll("[role=tab]")].find((t) => !/Settings/.test(t.textContent))?.click()');
await page.sleep(1000);
const has = await page.eval('!!window.harvPresence');
console.log('presence on this chat:', has, `(chat width ${width} window)`);
if (!has) {
  await page.close();
  process.exit(0);
}
console.log('fits inside the hammock:', await page.eval('JSON.stringify(window.harvPresence.fits())'));
const tier = process.argv.includes('--battery') ? 'light' : 'full';
const still = process.argv.includes('--still');
await page.eval(`window.harvPresence.setLook('${tier}', ${still})`);
// Count canvas draws: wrap clearRect, which every drawn frame calls once.
await page.eval(`(() => {
  const c = document.querySelector('canvas'); const ctx = c.getContext('2d');
  window.frames_ = 0; const clear = ctx.clearRect.bind(ctx);
  ctx.clearRect = (...a) => { window.frames_++; return clear(...a); };
})()`);
const frames = async (ms) => {
  await page.eval('window.frames_ = 0');
  await page.sleep(ms);
  return page.eval('window.frames_');
};
console.log('frames in 2 s at rest:', await frames(2000));
const P = 'window.harvPresence';
// The slide: it must come out from under the tab bar and go back behind it, never over the tabs.
// The box round it clips at the chat's top edge; the screenshots catch it half-way.
console.log(
  'clipped at the top edge of the chat:',
  await page.eval(`(() => {
    const box = document.querySelector('canvas').parentElement.parentElement;
    const top = Math.round(box.getBoundingClientRect().top - box.parentElement.getBoundingClientRect().top);
    return getComputedStyle(box).overflow === 'hidden' && top === 0;
  })()`),
);
if (!still) {
  await page.eval(`${P}.setState('working', 0)`);
  await page.sleep(120);
  console.log('half-way down:', await page.shot(`presence-slide-down-${tier}`));
  await page.sleep(1500);
  await page.eval(`${P}.setState('idle', 0)`);
  await page.sleep(60);
  console.log('half-way up:', await page.shot(`presence-slide-up-${tier}`));
  await page.sleep(1200);
}
await page.eval(`${P}.setState('thinking', 0)`);
await page.sleep(1200);
console.log('thinking:', await page.shot(`presence-thinking-${tier}`));
await page.eval(`${P}.setState('working', 2); ${P}.tool('files')`);
await page.sleep(700);
console.log('working (files):', await page.shot(`presence-files-${tier}`));
await page.eval(`${P}.tool('shell')`);
console.log('frames in 2 s working:', await frames(2000));
await page.eval(`${P}.tool('web')`);
await page.sleep(600);
console.log('working (web):', await page.shot(`presence-web-${tier}`));
// Between tools (the focus lets go after 2.4 s) he mulls: eyes drift, the glow breathes.
await page.sleep(3500);
console.log('mulling:', await page.shot(`presence-mull-a-${tier}`));
await page.sleep(1300);
console.log('mulling, 1.3 s later:', await page.shot(`presence-mull-b-${tier}`));
await page.eval(`${P}.setState('desktop', 0)`);
await page.sleep(800);
console.log('desktop:', await page.shot(`presence-desktop-${tier}`));
await page.eval(`${P}.setState('waiting', 0)`);
await page.sleep(1200);
console.log('waiting:', await page.shot(`presence-waiting-${tier}`));
await page.eval(`${P}.setState('asleep', 0)`);
await page.sleep(1500);
console.log('asleep:', await page.shot(`presence-asleep-${tier}`));
await page.eval(`${P}.setState('working', 0); ${P}.done(false)`);
await page.sleep(250);
console.log('error:', await page.shot(`presence-error-${tier}`));
await page.eval(`${P}.setState('idle', 0)`);
await page.sleep(3500);
console.log('frames in 2 s after it went up:', await frames(2000));
await page.close();
process.exit(0);
