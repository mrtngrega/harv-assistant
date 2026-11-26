// Deletes test chats from this device's Harv (what the History's delete does), e.g. after send.mjs.
//   node scripts/ui-check/delete-chat.mjs <tabId> [<tabId>...]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('usage: node scripts/ui-check/delete-chat.mjs <tabId> [<tabId>...]');
  process.exit(1);
}
const ws = new WebSocket('ws://127.0.0.1:4317/ws', { headers: { Origin: 'http://127.0.0.1:4316' } });
ws.on('open', () => {
  for (const tabId of ids) ws.send(JSON.stringify({ type: 'chat.delete', tabId }));
  setTimeout(() => {
    console.log(`deleted: ${ids.join(', ')}`);
    ws.close();
  }, 800);
});
ws.on('error', (e) => {
  console.error(`Harv isn't answering: ${e.message}`);
  process.exit(1);
});
