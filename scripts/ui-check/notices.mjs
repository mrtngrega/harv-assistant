// Harv's notices in the app (docs/PLAN.md §6ad), with made-up notices handed to the app's own notice
// feed (no server change, no plan usage): a normal one under his face, three at once (urgent first,
// "+2"), the open detail, and Recent behind the logo. Sounds play if the notification sound is on.
// Start the app with a debug port first. Usage: node scripts/ui-check/notices.mjs [port] [tab title]
import { attach } from './cdp.mjs';

const app = await attach({ port: Number(process.argv[2] ?? 9444) });
const chatTitle = process.argv[3];
// The module copy the page itself runs (Vite serves an edited one with ?t=).
const mod = (name) =>
  `(await import(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/lib/${name}.ts')).sort((a, b) => (b.includes('?t=') ? 1 : 0) - (a.includes('?t=') ? 1 : 0) || b.localeCompare(a))[0] ?? '/src/lib/${name}.ts'))`;
const say = (n) => app.eval(`(async () => { ${mod('noticeFeed')}.notice(${JSON.stringify(n)}); })()`);
const bubble = () =>
  app.eval(`(() => {
    const b = document.querySelector('[role=status][class*="rounded-[14px]"], [role=alert][class*="rounded-[14px]"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { text: b.innerText.replace(/\\s+/g, ' ').slice(0, 80), top: Math.round(r.top), w: Math.round(r.width), role: b.getAttribute('role') };
  })()`);

const before = await app.eval(`(async () => ${mod('chatStore')}.getChatState().activeId)()`);
if (chatTitle)
  console.log(
    'chat',
    await app.eval(`(async () => {
      const { chat, getChatState } = ${mod('chatStore')};
      const t = getChatState().tabs.find((x) => x.title.includes(${JSON.stringify(chatTitle)}));
      if (t) chat.setActive(t.id);
      return t?.title ?? null;
    })()`),
  );
await app.sleep(600);

await say({ key: 'reply', level: 'normal', icon: '↩', line: 'replied in Car radio', chats: [{ id: 'x', title: 'Car radio' }] });
await app.sleep(1200);
console.log('normal', await bubble());
console.log(await app.shot('notice-normal'));
await app.sleep(5500);
console.log('after 6.7 s', await bubble());

await say({ key: 'reply', level: 'normal', icon: '↩', line: 'replied in Trip plan' });
await say({
  key: 'usage:session',
  level: 'warning',
  icon: '◔',
  line: 'Plan at 90% of the session',
  detail: 'Heads up: 90% of your Claude session (5-hour) limit is used.',
  actions: [{ label: 'OK' }],
});
await say({
  key: 'watchdog:threat:x',
  level: 'urgent',
  icon: '▲',
  line: 'Defender found a threat',
  detail: 'Trojan:Win32/Wacatac.B!ml in Downloads\\setup.exe. It was blocked.',
  actions: [{ label: 'OK' }],
});
await app.sleep(1200);
console.log('three', await bubble());
console.log(await app.shot('notice-three'));
await app.eval(`document.querySelector('[role=alert] button[aria-expanded]')?.click()`);
await app.sleep(400);
console.log('open', await bubble());
console.log(await app.shot('notice-open'));

// Amber ones carry a × that puts them away in one click (the urgent first, then the warning).
await app.eval(`document.querySelector('[role=alert] button[aria-label="Dismiss"]')?.click()`);
await app.sleep(400);
console.log('× urgent', await bubble());
console.log(await app.shot('notice-dismissed'));
await app.eval(`document.querySelector('[role=alert] button[aria-label="Dismiss"]')?.click()`);
await app.sleep(400);
console.log('× warning', await bubble());

// Clear the queue, then Recent behind the logo.
await app.eval(`(async () => { ${mod('notices')}.takeAll(); })()`);
await app.eval(`document.querySelector('button[title="Recent notices"]')?.click()`);
await app.sleep(400);
console.log(
  'recent',
  await app.eval(
    `document.querySelector('[role=dialog][aria-label="Recent notices"]')?.innerText.split('\\n').slice(0, 6).join(' | ') ?? null`,
  ),
);
console.log(await app.shot('notice-recent'));
await app.eval(
  `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`,
);
await app.eval(`(async () => { ${mod('chatStore')}.chat.setActive(${JSON.stringify(before)}); })()`);
console.log('logs', app.logs.filter((l) => /error/i.test(l)).slice(-5));
await app.close();
