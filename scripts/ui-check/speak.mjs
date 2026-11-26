// Harv speaking (docs/review/voice-plan.md V2), in the app: one spoken turn the way the talk key sends
// it (a new chat, a short question, `spoken`), then follows the reply being read aloud: when the
// first piece of audio starts, when it's done. Uses one small model turn; you hear the answer.
// Start the app with a debug port first. Usage: node scripts/ui-check/speak.mjs [port] [question]
import { attach } from './cdp.mjs';

const app = await attach({ port: Number(process.argv[2] ?? 9444) });
const question = process.argv[3] ?? 'Povedz mi jednou vetou, aký je dnes deň.';
const mod = (name) =>
  `(await import(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/lib/${name}.ts')).sort((a, b) => (b.includes('?t=') ? 1 : 0) - (a.includes('?t=') ? 1 : 0) || b.localeCompare(a))[0] ?? '/src/lib/${name}.ts'))`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Watch the page's audio element: when it plays and how long.
await app.eval(`(() => {
  window.__speakLog = [];
  const t0 = performance.now();
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const at = Math.round(performance.now() - t0);
    const p = orig.call(this);
    p.then(() => window.__speakLog.push({ at, ok: true }), (e) => window.__speakLog.push({ at, ok: false, err: String(e) }));
    return p;
  };
  window.__t0 = t0;
})()`);
const tabId = await app.eval(`(async () => {
  const { chat } = ${mod('chatStore')};
  chat.newTab();
  const id = chat.ensureTab();
  ${mod('talk')}; // the hold key's module (wires the key path)
  chat.send(${JSON.stringify(question)}, [], true);
  ${mod('voice')}.speakReplyIn(id);
  return id;
})()`);
console.log('sent in', tabId);
let last = '';
for (let i = 0; i < 120; i++) {
  await wait(500);
  const s = await app.eval(`(async () => {
    const { getChatState } = ${mod('chatStore')};
    const t = getChatState().tabs.find((x) => x.id === ${JSON.stringify(tabId)});
    return JSON.stringify({ busy: t?.busy, speaking: ${mod('speak')}.isSpeaking(), plays: window.__speakLog });
  })()`);
  if (s !== last) console.log(`${(i + 1) / 2}s`, s);
  last = s;
  const v = JSON.parse(s);
  if (!v.busy && !v.speaking && v.plays.length) break;
}
console.log(
  'reply:',
  await app.eval(`(async () => {
    const { getChatState } = ${mod('chatStore')};
    const t = getChatState().tabs.find((x) => x.id === ${JSON.stringify(tabId)});
    return t?.lines.filter((l) => l.kind === 'harv').map((l) => l.text).join(' ').slice(0, 300);
  })()`),
);
process.exit(0);
