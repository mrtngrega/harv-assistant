import type { FastifyInstance } from 'fastify';
import { HARV_VERSION, HISTORY_QUERY_MAX, terminalId, type ClientMessage, type ServerMessage, type UiState } from '@harv/shared';
import type { ChatManager } from './agent/manager.ts';
import { backgroundVersion } from './background.ts';
import type { MetricsCollector } from './metrics/collector.ts';
import { PLATFORM } from './platform.ts';
import type { SafetyGate } from './safety/gate.ts';
import type { Scheduler } from './schedule/scheduler.ts';
import { loadSettings, updateSettings } from './settings.ts';
import type { ActionStore } from './store/actions.ts';
import type { ChatStore } from './store/chats.ts';
import type { BrowserHost } from './tools/browserHost.ts';
import { cleanPath } from './tools/files.ts';
import type { TerminalManager } from './tools/terminal.ts';
import { loadUi, saveUi } from './ui.ts';
import type { UsageMeter } from './usage/meter.ts';
import { malformed } from './wsInput.ts';

export interface WsDeps {
  /** Every connected window's sender (several windows stay in sync). */
  clients: Set<(msg: ServerMessage) => void>;
  broadcast: (msg: ServerMessage) => void;
  onBattery: () => boolean;
  startedAt: number;
  chats: ChatManager;
  store: ChatStore;
  gate: SafetyGate;
  actions: ActionStore;
  metrics: MetricsCollector;
  meter: UsageMeter;
  scheduler: Scheduler;
  terminals: TerminalManager;
  browserHost: BrowserHost;
}

/** `/ws`: the dashboard's one connection: hello, live updates, and every message it sends. */
export function wsRoute(app: FastifyInstance, d: WsDeps) {
  const {
    clients,
    broadcast,
    chats,
    store,
    gate,
    actions,
    metrics,
    meter,
    scheduler,
    terminals,
    browserHost,
  } = d;
  app.get('/ws', { websocket: true }, (socket) => {
    const send = (msg: ServerMessage) => socket.send(JSON.stringify(msg));
    clients.add(send);
    send({
      type: 'hello',
      version: HARV_VERSION,
      status: chats.status,
      metrics: metrics.latest,
      catalog: chats.catalog,
      chats: chats.openChats(),
      history: chats.history(),
      approvals: gate.approvals(),
      actions: actions.recent(30),
      usage: meter.snapshot(),
      settings: loadSettings(),
      background: backgroundVersion(),
      ui: loadUi(),
      projects: store.projects(),
      platform: PLATFORM,
      battery: d.onBattery(),
      startedAt: d.startedAt,
      schedules: scheduler.list(),
    });
    // A chat using the desktop right now: the new window shows it too (the app's pill, the chat's marker).
    const controlling = gate.desktopControl();
    if (controlling) send({ type: 'desktop.control', ...controlling });

    const unsubscribe = metrics.onSnapshot((snapshot) => send({ type: 'metrics.tick', metrics: snapshot }));
    socket.on('close', () => {
      unsubscribe();
      clients.delete(send);
      browserHost.detach(send);
    });

    socket.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      const bad = malformed(msg);
      if (bad) {
        app.log.warn({ type: (msg as { type?: unknown } | null)?.type, why: bad }, 'A malformed dashboard message was dropped');
        return;
      }
      // One bad message must never take Harv down (it doesn't restart by itself): log it and go on.
      try {
        handle(msg);
      } catch (err) {
        app.log.error({ err: (err as Error).message, type: msg.type }, 'A dashboard message failed');
      }
    });

    function handle(msg: ClientMessage) {
      switch (msg.type) {
        case 'browser.hello':
          browserHost.attach(send);
          break;
        case 'browser.result':
          browserHost.result(msg.reqId, msg.ok, msg.value, msg.error);
          break;
        case 'chat.send':
          if (msg.answer === 'yes' || msg.answer === 'no') gate.answerNext(msg.tabId, msg.answer);
          void chats.send(msg.tabId, msg.text, msg.model, msg.effort, msg.attachments, msg.spoken === true);
          break;
        case 'chat.stop':
          void chats.stop(msg.tabId);
          break;
        case 'chat.stopTask':
          void chats.stopTask(msg.tabId, msg.taskId).catch(() => {});
          break;
        case 'chat.unqueue':
          chats.unqueue(msg.tabId, msg.id);
          break;
        case 'chat.sendNow':
          void chats.sendNow(msg.tabId, msg.id);
          break;
        case 'chat.harder':
          void chats.harder(msg.tabId);
          break;
        case 'chat.close':
          chats.close(msg.tabId);
          terminals.close(terminalId(msg.tabId));
          break;
        case 'chat.open':
          chats.open(msg.tabId);
          break;
        case 'chat.load': {
          const chat = chats.openChats().find((c) => c.id === msg.tabId);
          if (chat) send({ type: 'chat.opened', chat, focus: false });
          break;
        }
        case 'chat.delete':
          chats.delete(msg.tabId);
          terminals.close(terminalId(msg.tabId));
          break;
        case 'chat.rename':
          if (typeof msg.title === 'string') chats.rename(msg.tabId, msg.title);
          break;
        case 'schedule.cancel':
          scheduler.cancel(String(msg.id));
          break;
        case 'chat.plan':
          chats.setPlanning(msg.tabId, msg.on === true);
          break;
        case 'chat.rewind':
          void chats.rewind(msg.tabId, Number(msg.fromEnd) || 0);
          break;
        case 'approval.answer':
          gate.answer(msg.id, msg.approve, {
            ...(msg.answers && typeof msg.answers === 'object' ? { answers: msg.answers } : {}),
            ...(typeof msg.why === 'string' ? { why: msg.why.slice(0, 4000) } : {}),
          });
          break;
        case 'action.undo':
          gate.undo(msg.id);
          break;
        case 'project.add': {
          const error = typeof msg.path === 'string' ? chats.addProject(msg.path, msg.name) : 'No folder given.';
          if (error) send({ type: 'project.error', message: error });
          break;
        }
        case 'project.remove':
          chats.removeProject(msg.id);
          break;
        case 'chat.setProject': {
          const error = chats.setProject(msg.tabId, msg.projectId);
          if (error) send({ type: 'project.error', message: error });
          break;
        }
        case 'ui.save': {
          const shared = ({ order, blanks, drafts, attachments, tools, views }: UiState) =>
            JSON.stringify({ order, blanks, drafts, attachments, tools, views });
          const before = shared(loadUi());
          const state = msg.state;
          // Every open chat is a tab: one this window hasn't heard of yet (another window just made it)
          // stays in the order, and this window gets it.
          const unknown = chats.openChats().filter((c) => !state.order.includes(c.id));
          for (const chat of unknown) send({ type: 'chat.opened', chat, focus: false });
          saveUi(unknown.length ? { ...state, order: [...state.order, ...unknown.map((c) => c.id)] } : state);
          const after = loadUi();
          // The other windows of this Harv (the app, a browser) show the same tabs: one Harv, not one per window.
          if (shared(after) !== before) {
            const { order, blanks, drafts, attachments, tools, views } = after;
            for (const other of clients)
              if (other !== send) other({ type: 'ui.synced', ui: { order, blanks, drafts, attachments }, windows: { tools, views } });
          }
          break;
        }
        case 'term.attach': {
          try {
            const replay = terminals.attach(msg.id, cleanPath(msg.cwd) ?? undefined);
            if (replay) send({ type: 'term.data', id: msg.id, data: replay.data, reset: true, restored: replay.restored });
          } catch (err) {
            app.log.error({ err: (err as Error).message }, 'Could not start a terminal');
          }
          break;
        }
        case 'term.close':
          terminals.close(msg.id);
          break;
        case 'term.input':
          if (typeof msg.data === 'string') terminals.input(msg.id, msg.data);
          break;
        case 'term.resize':
          terminals.resize(msg.id, msg.cols, msg.rows);
          break;
        case 'settings.update':
          if (!msg.patch || typeof msg.patch !== 'object') break;
          broadcast({ type: 'settings', settings: updateSettings(msg.patch) });
          break;
        case 'usage.refresh':
          void meter.refreshIfStale();
          break;
        case 'history.search': {
          const query = typeof msg.query === 'string' ? msg.query.slice(0, HISTORY_QUERY_MAX) : '';
          send({ type: 'history', items: chats.history(query), query });
          break;
        }
      }
    }
  });
}
