import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { HARV_VERSION, type ServerMessage } from '@harv/shared';
import type { ChatManager } from '../agent/manager.ts';
import { ensureLhmRunning } from '../metrics/lhmLauncher.ts';
import { HARV_HOME } from '../paths.ts';
import { IS_WINDOWS } from '../platform.ts';
import { restartEnv } from '../restartEnv.ts';
import { keepBackup, listBackups } from '../safety/backup.ts';
import { BACKUPS_DIR } from '../safety/paths.ts';
import type { ActionStore } from '../store/actions.ts';

// Stopping and restarting Harv (scripts/harv.ps1, harv.sh on Linux, the app's tray and Settings' Restart button).
const HARV_SCRIPT = fileURLToPath(new URL('../../../../scripts/harv.ps1', import.meta.url));
const HARV_SH = fileURLToPath(new URL('../../../../scripts/harv.sh', import.meta.url));

/** Health, the sensors, backups, the pill demo, and stopping or restarting Harv. */
export function systemRoutes(
  app: FastifyInstance,
  { broadcast, chats, actions }: { broadcast: (msg: ServerMessage) => void; chats: ChatManager; actions: ActionStore },
) {
  app.get('/api/health', async () => ({ ok: true, version: HARV_VERSION, status: chats.status, home: HARV_HOME }));

  // The desktop pill's demo (scripts/pill-demo.mjs): the app plays every state of Harv's face pill once.
  app.post('/api/pill/demo', async () => {
    broadcast({ type: 'pill.demo' });
    return { ok: true };
  });
  // Lets the dashboard retry starting the sensors (e.g. after the UAC prompt was declined).
  app.post('/api/sensors/start', async () => ({ result: await ensureLhmRunning() }));
  // Settings › Safety › Backups: every backup, and "keep forever" (the cleanup skips kept ones).
  // Each backup with the action it was made for, so Settings can say what it was and offer Restore (pass B, B31).
  app.get('/api/backups', async () => ({
    backups: listBackups().map((b) => {
      const a = actions.byBackupDir(join(BACKUPS_DIR, b.name));
      return a ? { ...b, action: { id: a.id, summary: a.summary, canUndo: a.canUndo } } : b;
    }),
  }));
  app.post('/api/backups/keep', async (req, reply) => {
    const { name, keep } = (req.body ?? {}) as { name?: unknown; keep?: unknown };
    if (typeof name !== 'string' || typeof keep !== 'boolean' || !keepBackup(name, keep)) {
      return reply.code(400).send({ error: 'No such backup' });
    }
    return { ok: true };
  });

  const shutdown = (reason: string) => {
    app.log.info({ reason }, 'Shutting down');
    setTimeout(() => {
      void app.close().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    }, 200);
  };
  app.post('/api/shutdown', async () => {
    shutdown('asked to stop');
    return { ok: true };
  });
  app.post('/api/restart', async () => {
    if (!IS_WINDOWS) {
      // Its own session (setsid), so stopping Harv doesn't stop the script; it waits, then starts Harv again.
      spawn('setsid', ['bash', HARV_SH, 'restart', '--delay', '2', '--no-browser'], {
        detached: true,
        stdio: 'ignore',
        env: restartEnv(),
      }).unref();
      shutdown('restarting');
      return { ok: true };
    }
    // `start` detaches the script from Harv's process tree, so stopping Harv doesn't stop it; it waits, then starts Harv again.
    // Passed verbatim: Node would otherwise escape start's empty "" window title and break the command.
    const command = `start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${HARV_SCRIPT}" -Action restart -Delay 2 -NoBrowser`;
    spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
      // Not Harv's own npm PATH: it grew with every restart until Harv couldn't start (restartEnv.ts).
      env: restartEnv(),
    }).unref();
    shutdown('restarting');
    return { ok: true };
  });
}
