import type { Attachment, UiState } from '@harv/shared';
import { getChatState, layoutRestored, onLayoutRestore, subscribeChat } from './chatStore.ts';
import { getDrafts, getDraftTexts, restoreDrafts, subscribeDrafts } from './drafts.ts';
import { sendMessage } from './socket.ts';

// The dashboard's layout is saved on the server (~/.harv/ui.json) so it comes back
// after a restart, like Chrome's tabs: tabs and their order, which one was showing,
// each chat's tools and explorer folder, and unsent drafts.

/** Where each chat's file explorer is. */
export const explorerPaths = new Map<string, string>();

function snapshot(): UiState {
  const s = getChatState();
  const ids = new Set(s.tabs.map((t) => t.id));
  const keep = <T>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).filter(([id]) => ids.has(id)));
  const files: Record<string, Attachment[]> = {};
  for (const [id, list] of Object.entries(getDrafts())) {
    const ready = list.flatMap((p) => (p.file ? [p.file] : []));
    if (ready.length) files[id] = ready;
  }
  return {
    activeId: s.activeId,
    settingsOpen: s.settingsOpen,
    order: s.tabs.map((t) => t.id),
    // Chats with no messages exist only here until the first send.
    blanks: s.tabs.filter((t) => !t.stored).map((t) => t.id),
    tools: keep(s.tools),
    views: keep(s.views),
    explorer: keep(Object.fromEntries(explorerPaths)),
    drafts: keep(getDraftTexts()),
    attachments: keep(files),
  };
}

let timer: number | undefined;
let lastSaved = '';
/** When the oldest unsaved change came (the 2 s ceiling in saveLayoutSoon). */
let waitingSince: number | null = null;

function flush() {
  window.clearTimeout(timer);
  waitingSince = null;
  // Before the saved layout is back, saving would overwrite it with the empty start.
  if (!layoutRestored()) return;
  const state = snapshot();
  const json = JSON.stringify(state);
  if (json !== lastSaved && sendMessage({ type: 'ui.save', state })) lastSaved = json;
}

/** Saves the layout shortly (changes come in bursts, e.g. while Harv streams). */
export function saveLayoutSoon(): void {
  window.clearTimeout(timer);
  // At most 2 s after the first unsaved change: while a reply streams, changes come faster than the
  // 400 ms pause, and tab order, views and drafts waited for the stream to stop (the full review, U30).
  waitingSince ??= Date.now();
  timer = window.setTimeout(flush, Math.max(0, Math.min(400, waitingSince + 2000 - Date.now())));
}

subscribeChat(saveLayoutSoon);
subscribeDrafts(saveLayoutSoon);
window.addEventListener('pagehide', flush);

onLayoutRestore((ui) => {
  for (const [id, path] of Object.entries(ui.explorer)) if (!explorerPaths.has(id)) explorerPaths.set(id, path);
  restoreDrafts(ui.drafts, ui.attachments);
});

// Coming back to the dashboard: plan usage spent elsewhere (a Claude Code session) shows now, not at the next poll.
let lastReturn = 0;
function refreshOnReturn() {
  if (document.visibilityState !== 'visible' || Date.now() - lastReturn < 30_000) return;
  lastReturn = Date.now();
  sendMessage({ type: 'usage.refresh' });
}
window.addEventListener('focus', refreshOnReturn);
document.addEventListener('visibilitychange', refreshOnReturn);
