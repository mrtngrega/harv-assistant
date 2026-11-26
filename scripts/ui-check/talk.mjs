// Push-to-talk in the app (docs/review/voice-plan.md V1b), without sending anything: the mic button
// sits on the harv> line beside ATTACH, a click-talk-click fills the line (not sent), and the hold
// key's event starts a recording (then thrown away, so no turn runs). Records ~2 s from the real
// microphone. Start the app with a debug port first. Usage: node scripts/ui-check/talk.mjs [port]
import { attach } from './cdp.mjs';

const app = await attach({ port: Number(process.argv[2] ?? 9444) });
const mod = (name) =>
  `(await import(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/lib/${name}.ts')).sort((a, b) => (b.includes('?t=') ? 1 : 0) - (a.includes('?t=') ? 1 : 0) || b.localeCompare(a))[0] ?? '/src/lib/${name}.ts'))`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stage = () =>
  app.eval(`(async () => { const t = ${mod('talk')}.getTalk(); return t.stage + '/' + t.by + (t.error ? ' ' + t.error : ''); })()`);

// 1. The button and where it sits (its middle on the ATTACH button's middle).
console.log(
  'button',
  await app.eval(`(() => {
    const mic = document.querySelector('button[aria-label^="Talk"]');
    const att = document.querySelector('button[aria-label="Attach"]');
    if (!mic || !att) return { mic: !!mic, attach: !!att };
    const a = mic.getBoundingClientRect(), b = att.getBoundingClientRect();
    return { w: Math.round(a.width), h: Math.round(a.height), midDiff: Math.round((a.top + a.height / 2 - (b.top + b.height / 2)) * 10) / 10, gap: Math.round(a.left - b.right) };
  })()`),
);

// 2. Click, ~2 s of the room, click: the words (or "didn't catch") land in the line, nothing is sent.
const draftBefore = await app.eval(`document.getElementById('harv-cmd')?.value ?? null`);
await app.eval(`document.querySelector('button[aria-label^="Talk"]')?.click()`);
await wait(500);
console.log('after click', await stage());
await wait(1800);
await app.eval(`document.querySelector('button[aria-label^="Listening"]')?.click()`);
console.log('after second click', await stage());
for (let i = 0; i < 40 && (await stage()).startsWith('hearing'); i++) await wait(250);
console.log('done', await stage(), '| line:', JSON.stringify(await app.eval(`document.getElementById('harv-cmd')?.value ?? null`)));
// Put the line back as it was.
await app.eval(`(async () => {
  const { chat } = ${mod('chatStore')};
  ${mod('drafts')}.setDraftText(chat.ensureTab(), ${JSON.stringify(draftBefore ?? '')});
})()`);

// 3. The hold key's event: records, then thrown away (cancelTalk) so no message goes out.
await app.eval(`window.dispatchEvent(new CustomEvent('harv-talk', { detail: { down: true } }))`);
await wait(700);
console.log('hold key down', await stage());
await app.eval(`(async () => ${mod('talk')}.cancelTalk())()`);
console.log('cancelled', await stage());
app.close?.();
process.exit(0);
