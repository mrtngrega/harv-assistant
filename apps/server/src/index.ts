import { removedAtStart } from './envFirst.ts';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { SERVER_PORT, terminalId, terminalTabOf, type ServerMessage } from '@harv/shared';
import { loadCatalog } from './agent/catalog.ts';
import { findTab, type OpenTab } from './agent/chatTools.ts';
import { ChatManager } from './agent/manager.ts';
import { MetricsCollector } from './metrics/collector.ts';
import { hasBattery } from './metrics/system.ts';
import { ensureLhmRunning } from './metrics/lhmLauncher.ts';
import { stripBilledCredentials } from './env.ts';
import { ensureHarvHome, HARV_HOME } from './paths.ts';
import { SafetyGate } from './safety/gate.ts';
import { Router } from './router/router.ts';
import { ActionStore } from './store/actions.ts';
import { ChatStore } from './store/chats.ts';
import { RouteStore } from './store/routes.ts';
import { UsageMeter } from './usage/meter.ts';
import { loadSettings, onSettingsBroken, onSettingsChange, workDir } from './settings.ts';
import { pruneBackups } from './safety/backup.ts';
import { loadUi, resetUi } from './ui.ts';
import { BrowserHost } from './tools/browserHost.ts';
import { GeminiImages, GeminiProblem } from './tools/gemini.ts';
import { grantDesktop, pinWindows, WindowsMcp } from './tools/windowsMcp.ts';
import { HarvBrowser } from './tools/harvBrowser.ts';
import { cleanPath } from './tools/files.ts';
import { TerminalManager } from './tools/terminal.ts';
import { startWatchdog } from './watchdog/monitor.ts';
import { sweepClips } from './voice/clips.ts';
import { GpuBusy } from './voice/gpuBusy.ts';
import { setVoiceHooks } from './voice/stt.ts';
import { speech } from './voice/tts.ts';
import { Scheduler } from './schedule/scheduler.ts';
import { installOwnSkills } from './agent/ownSkills.ts';
import { deviceRoutes } from './routes/devices.ts';
import { fileRoutes } from './routes/files.ts';
import { systemRoutes } from './routes/system.ts';
import { wsRoute } from './ws.ts';

// Stripped by envFirst.ts before every other import; strip again in case a module set one since.
const removed = [...new Set([...removedAtStart, ...stripBilledCredentials()])];
ensureHarvHome();

/** Sent in hello: the dashboard asks "continue or new session?" once per server start. */
const STARTED_AT = Date.now();
// Two lines per request buried the real messages (8 in 10,600) and grew harv.log ~10 MB a day
// (the full review, D7): only failed requests are logged (the onResponse hook below).
const app = Fastify({ logger: { level: 'info' }, disableRequestLogging: true });
app.addHook('onResponse', async (req, reply) => {
  if (reply.statusCode >= 400) app.log.warn({ method: req.method, url: req.url, status: reply.statusCode }, 'request failed');
});

// Harv runs without auto-restart, so a stray error must be logged, never the end of the server.
process.on('uncaughtException', (err) => app.log.error({ err: err.message, stack: err.stack }, 'Uncaught error'));
process.on('unhandledRejection', (reason) =>
  app.log.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'Unhandled rejection'),
);
await app.register(websocket);

if (removed.length > 0) {
  app.log.warn({ removed }, 'Removed API credentials from the environment: Harv is subscription-only');
}

// Only the dashboard itself may talk to Harv. A web page in any browser tab can
// reach 127.0.0.1, so requests (and WebSocket upgrades) from other origins are refused.
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${SERVER_PORT}`,
  `http://localhost:${SERVER_PORT}`,
  'http://127.0.0.1:4316',
  'http://localhost:4316',
]);
// DNS rebinding: a page on evil.example can point its name at 127.0.0.1 and then make "same-origin"
// requests here. Its requests still carry its own name in Host, so only Harv's own names get in.
const ALLOWED_HOSTS = new Set([...ALLOWED_ORIGINS].map((o) => new URL(o).host));
app.addHook('onRequest', async (req, reply) => {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return reply.code(403).send({ error: 'Forbidden host' });
  // Came through a proxy (`tailscale serve`, a forwarder) that rewrote Host to a local name: never treat it as this computer's own dashboard.
  if (req.headers['tailscale-user-login'] || req.headers['x-forwarded-for']) return reply.code(403).send({ error: 'Forbidden' });
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return reply.code(403).send({ error: 'Forbidden origin' });
  // A plain <img> or link from another site sends no Origin, but browsers mark it. Only the dashboard itself may read files.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return reply.code(403).send({ error: 'Forbidden' });
});

// Every connected dashboard window gets every update, so several windows stay in sync.
const clients = new Set<(msg: ServerMessage) => void>();
const broadcast = (msg: ServerMessage) => {
  clients.forEach((send) => send(msg));
};

const metrics = new MetricsCollector(() => loadSettings().metricsMs);
/** A laptop (asked once at start; false until known). */
let onBattery = false;
void hasBattery().then((b) => (onBattery = b));
// The PC watchdog (Settings › Watchdog): overheating, background hogs, dangerous software.
const watchdog = startWatchdog(metrics, (alert) => {
  app.log.info({ kind: alert.kind, title: alert.title }, 'Watchdog');
  broadcast({ type: 'watchdog.alert', alert });
});
// A settings.json that can't be read (the full review, D17): said once, on the last good settings.
onSettingsBroken((problem) => {
  app.log.warn({ problem }, 'settings.json is broken; running on the last good settings');
  broadcast({
    type: 'watchdog.alert',
    alert: {
      id: `settings-${Date.now()}`,
      kind: 'settings',
      severity: 'critical',
      title: 'Your settings file is broken',
      detail: `~/.harv/settings.json couldn't be read (${problem}). Harv keeps running on your last good settings, and the broken file is kept as settings.broken.json. Changing any setting saves the good ones back.`,
      at: Date.now(),
    },
  });
});
const store = new ChatStore(join(HARV_HOME, 'harv.db'));
const actions = new ActionStore(join(HARV_HOME, 'harv.db'));
actions.markInterrupted();

// Backups for Undo don't pile up: older than Settings › Safety's days, or over its size cap, they go (oldest first).
function cleanBackups() {
  try {
    const { backupDays, backupMaxGb } = loadSettings();
    const done = pruneBackups(backupDays, backupMaxGb * 1024 ** 3);
    if (!done.removed.length) return;
    actions.forgetBackups(done.removed);
    app.log.info(
      { removed: done.removed.length, freedMb: Math.round(done.freedBytes / 1024 ** 2), keptMb: Math.round(done.keptBytes / 1024 ** 2) },
      'Old backups cleaned up',
    );
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, 'Backup cleanup failed');
  }
}
setTimeout(cleanBackups, 60_000).unref();
setInterval(cleanBackups, 6 * 60 * 60 * 1000).unref();
const gate = new SafetyGate(actions, {
  broadcast,
  notice: (tabId, message) => chats.notice(tabId, message),
  onChange: () => chats.refreshStatus(),
  // Project chats: the project folder is trusted (docs/PLAN.md §6f).
  projectOf: (tabId) => store.projectOf(tabId)?.path,
  projects: () => store.projects().map((p) => p.path),
  // Files and folders the user attached in a chat: trusted there (the user's wish, 2026-10-26).
  attachedOf: (tabId) => store.attachedPaths(tabId),
  onPlanMode: (tabId, on) => chats.planningChanged(tabId, on),
  // Desktop control keeps to one monitor (docs/PLAN.md §6t item 1 "Monitors"); windowsMcp is set up below.
  desktopArea: () => (loadSettings().desktopControl ? windowsMcp.area() : null),
  desktopGrant: grantDesktop,
  desktopPin: pinWindows,
});
// Harv says what he'll do before his first tool call (the user's report note, 2026-11-17).
gate.sayFirst = true;
const routes = new RouteStore(join(HARV_HOME, 'harv.db'));
const meter = new UsageMeter(
  {
    onChange: (usage) => {
      broadcast({ type: 'usage.update', usage });
      chats.refreshStatus();
    },
    onResume: () => void chats.flushQueue(),
    onWarning: (warning) => {
      broadcast({ type: 'usage.warning', warning });
    },
    onReading: (meters) => routes.logMeter(meters),
  },
  () => routes.summary(),
  undefined,
  () => {
    const s = loadSettings();
    return { session: s.warnSession, weekly: s.warnWeekly };
  },
);
// Each chat's terminal (its view menu); saved in ~/.harv/terminals across restarts.
const terminals = new TerminalManager(
  {
    data: (id, data) => broadcast({ type: 'term.data', id, data }),
    exit: (id, code) => broadcast({ type: 'term.exit', id, code }),
  },
  join(HARV_HOME, 'terminals'),
  // A project chat's terminal opens in the project.
  (id) => {
    const project = store.projectOf(id.slice('terminal-'.length));
    return project && existsSync(project.path) ? project.path : workDir();
  },
);

const router = new Router(
  routes,
  undefined,
  () => meter.weeklyPercent(),
  () => loadSettings().allowFable,
);
const chats = new ChatManager(
  store,
  gate,
  router,
  meter,
  (msg) => broadcast(msg),
  (status) => broadcast({ type: 'harv.status', status, detail: chats.statusDetail }),
);
// Scheduled tasks (docs/PLAN.md §6s C4): run by this server, on this device.
const scheduler = new Scheduler(
  join(HARV_HOME, 'harv.db'),
  { run: (task, late) => chats.runScheduled(task, late), broadcast },
  loadSettings().deviceName || hostname(),
);
chats.schedules = scheduler;
chats.onDeleted = (tabId) => actions.forgetChat(tabId);
// Harv's terminal_run / terminal_read: the chat's own terminal, shown in the dashboard while Harv uses it.
// Harv's generate_image: pictures from the Gemini website on Harv's own Chrome profile (docs/PLAN.md §6w).
const gemini = new GeminiImages();
// Desktop control (docs/PLAN.md §6t item 1): Windows-MCP on Windows, when
// the user turned it on here. Switching it (or a finished install) restarts each chat's session after its reply.
const onDesktopStatus = (status: { installing: boolean; installed: boolean }) => {
  if (!status.installing && status.installed && loadSettings().desktopControl) chats.reloadSessions();
};
const windowsMcp = new WindowsMcp(onDesktopStatus);
chats.desktop = () => windowsMcp.server();
chats.desktopArea = () => windowsMcp.area();
onSettingsChange((before, after) => {
  if (before.desktopControl !== after.desktopControl || before.desktopScreen !== after.desktopScreen) chats.reloadSessions();
});
// Harv's own skills: harv/skills → ~/.claude/skills, only what changed (docs/PLAN.md §6ab).
try {
  const written = installOwnSkills();
  if (written.length) app.log.info(`Own skills updated: ${written.join(', ')}`);
} catch (err) {
  app.log.warn(`Own skills not installed: ${(err as Error).message}`);
}
chats.images = {
  async generate(prompt, images) {
    try {
      const { paths, text } = await gemini.generate(prompt, images);
      const said = text ? `\n\nGemini said: ${text.slice(0, 800)}` : '';
      const saved = paths.length === 1 ? 'the picture' : `${paths.length} pictures`;
      return `Saved ${saved}:\n${paths.join('\n')}${said}\n\nName the full path in your reply so it shows in the chat.`;
    } catch (err) {
      if (err instanceof GeminiProblem && err.message === 'signed-out') {
        await gemini.openSignIn().catch(() => undefined);
        return "Gemini isn't signed in yet. I opened a Chrome window with Gemini: the user signs in there once with the Google account they keep for pictures, then closes the window and asks again. (Settings › What Harv can do › Pictures opens it too.)";
      }
      if (err instanceof GeminiProblem) return err.message;
      return `Gemini didn't work: ${(err as Error).message}`;
    }
  },
};
// Harv's browser (docs/PLAN.md §6x): in the app, driven through its dashboard's connection.
const browserHost = new BrowserHost();
/** How long the browser tab says "Harv is using the browser" after Harv's last action. */
const BROWSER_BUSY_MS = 6000;
chats.browser = new HarvBrowser(
  browserHost,
  () => broadcast({ type: 'browser.busy', until: Date.now() + BROWSER_BUSY_MS }),
  (tabId) => broadcast({ type: 'browser.show', tabId }),
);
/** The open chats (saved ones and blank tabs), for using another chat's terminal. */
const openTabs = (): OpenTab[] => {
  const ui = loadUi();
  const tab = (id: string, title: string) => ({ id, title, terminal: ui.views[id] === 'terminal' });
  return [...store.openChats().map((c) => tab(c.id, c.title)), ...ui.blanks.map((id) => tab(id, 'New chat'))];
};
/** The chat whose terminal a call means: this one, or the one `chat` names (an error text if unclear). */
const terminalTab = (tabId: string, chat?: string): { id: string; note: string } | string => {
  // Without `chat`: the chat's own terminal tab next to it (terminalTabOf), so its log stays on screen;
  // a chat the user has on its Terminal view already is that terminal.
  if (!chat) return { id: loadUi().views[tabId] === 'terminal' ? tabId : terminalTabOf(tabId), note: '' };
  const found = findTab(chat, openTabs(), tabId);
  return typeof found === 'string' ? found : { id: found.id, note: found.id === tabId ? '' : ` (in "${found.title}")` };
};
chats.terminal = {
  async run(tabId, command, opts) {
    const target = terminalTab(tabId, opts.chat);
    if (typeof target === 'string') return target;
    // Its own tab is made next to the asking chat by the dashboard (from), if it isn't open yet.
    broadcast({ type: 'term.show', tabId: target.id, ...(target.id !== tabId && !opts.chat ? { from: tabId } : {}) });
    const cwd = opts.cwd ? (cleanPath(opts.cwd) ?? undefined) : undefined;
    const r = await terminals.run(terminalId(target.id), command, { ...opts, cwd });
    const state = r.exited
      ? 'The shell has exited (a new one starts on the next terminal_run).'
      : r.running
        ? 'Still printing when the wait ended: it keeps running in the terminal; terminal_read shows more later.'
        : 'The output went quiet (finished, or waiting for input).';
    return `${r.output || '(no output)'}\n\n[${state}${target.note}]`;
  },
  read(tabId, lines, chat) {
    const target = terminalTab(tabId, chat);
    if (typeof target === 'string') return target;
    // Nothing run in its own terminal tab yet: the chat's own Terminal view (something the user ran there).
    const own = !chat && target.id !== tabId ? terminals.read(terminalId(tabId), lines) : undefined;
    return terminals.read(terminalId(target.id), lines) ?? own ?? "That chat's terminal isn't open; terminal_run starts it.";
  },
};
// "Reopen tabs" off: Harv starts with no tabs (the chats stay in history).
if (!loadSettings().restoreTabs) {
  for (const c of store.openChats()) store.setOpen(c.id, false);
  resetUi();
}
// Terminals of chats closed while Harv was off aren't coming back.
{
  const live = new Set([...store.openChats().map((c) => c.id), ...loadUi().blanks].map(terminalId));
  terminals.prune((id) => live.has(id));
}

// The HTTP routes and the dashboard's WebSocket (moved out of this file, 2026-11-15; audit part 3, item 5).
systemRoutes(app, { broadcast, chats, actions });
fileRoutes(app, broadcast);
deviceRoutes(app, { broadcast, windowsMcp, gemini });
wsRoute(app, {
  clients,
  broadcast,
  onBattery: () => onBattery,
  startedAt: STARTED_AT,
  chats,
  store,
  gate,
  actions,
  metrics,
  meter,
  scheduler,
  terminals,
  browserHost,
});

app.addHook('onClose', async () => {
  watchdog.stop();
  metrics.stop();
  meter.stop();
  scheduler.stop();
  terminals.closeAll();
  gemini.close();
  chats.closeAll();
  store.close();
  actions.close();
  routes.close();
});

// Claude Code subprocesses would otherwise keep the process alive on restart (tsx watch hangs).
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'Shutting down');
    void app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// Localhost only: Harv controls this PC, so it must never be reachable from the network.
await app.listen({ host: '127.0.0.1', port: SERVER_PORT });
await metrics.start();
// Whisper and Harv's voice stay off the graphics card beside Resolve or a game (the full review, K2).
const gpu = new GpuBusy();
metrics.onSnapshot((s) => gpu.tick(s.gpu?.load));
metrics.onProcesses((list) => gpu.processes(list));
setVoiceHooks({ gpuBusy: () => gpu.busy() });
sweepClips();
speech.setGpuBusy(() => gpu.busy());
// After the catalog had a moment: a run missed while Harv was off happens now, once.
setTimeout(() => scheduler.start(), 5000).unref();

// LibreHardwareMonitor starts with Harv (Settings › Startup, or HARV_START_LHM=0, turns that off).
if (process.env.HARV_START_LHM !== '0' && loadSettings().startSensors) {
  void ensureLhmRunning().then((result) => app.log.info({ result }, 'LibreHardwareMonitor'));
}

// The plan and model names. Harv may start before Claude Code is logged in (a new machine), so
// without a plan it asks again: after 1 minute, then 2, 4… up to every 15 (no tokens, a short-lived process).
let catalogTries = 0;
const refreshCatalog = () => {
  const retry = () => setTimeout(refreshCatalog, Math.min(60_000 * 2 ** catalogTries++, 15 * 60_000)).unref();
  loadCatalog()
    .then((catalog) => {
      chats.catalog = catalog;
      broadcast({ type: 'catalog', catalog });
      app.log.info({ plan: catalog.plan, models: catalog.models.map((m) => m.id) }, 'Claude models');
      if (!catalog.plan) retry();
    })
    .catch((err: Error) => {
      app.log.error({ err: err.message }, 'Could not load Claude models');
      retry();
    });
};
refreshCatalog();

// Plan usage: /usage now and every 10 minutes (no tokens), plus live rate-limit events.
meter.start();
