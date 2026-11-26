import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { MAX_ATTACHMENT_BYTES, type FileOp, type ServerMessage } from '@harv/shared';
import { isValidTab, saveAttachment } from '../agent/attachments.ts';
import { backgroundVersion, findBackground, MAX_BACKGROUND_BYTES, removeBackground, saveBackground } from '../background.ts';
import { findWallpaper, wallpaperInfo } from '../wallpaper.ts';
import { isSensitivePath } from '../safety/classify.ts';
import { cleanPath, listFolder, openWithDefault, places, previewType, suggestPaths, syncedTwin } from '../tools/files.ts';
import {
  copyItems,
  deleteForever,
  drives,
  moveItems,
  newFile,
  newFolder,
  properties,
  recentFiles,
  recycle,
  renameItem,
  saveUpload,
  search,
} from '../tools/fileOps.ts';
import { IS_WINDOWS } from '../platform.ts';

/** The file API's answer for passwords, keys and logins: the same rule as Harv's own tools. */
const SENSITIVE = 'Harv never opens or sends files with passwords, keys or logins (the same rule its own tools follow).';

/** Files: the background and wallpaper, attachments, and the file explorer tab. */
/** A path from a chat: as written, or (from the other computer's chat) its synced copy in this computer's workspace. */
function localPath(raw: unknown): string | null {
  const asked = cleanPath(raw);
  if (asked && existsSync(asked)) return asked;
  const twin = syncedTwin(raw);
  return twin && existsSync(twin) ? twin : asked;
}

export function fileRoutes(app: FastifyInstance, broadcast: (msg: ServerMessage) => void) {
  app.get('/api/background', async (_req, reply) => {
    const bg = findBackground();
    if (!bg) return reply.code(404).send({ error: 'No background set' });
    return reply.type(bg.contentType).header('Cache-Control', 'no-cache').send(createReadStream(bg.path));
  });

  // The desktop's own wallpaper, for the "Wallpaper" background (read-only; Harv never sets it).
  app.get('/api/wallpaper/info', async () => wallpaperInfo());
  app.get('/api/wallpaper', async (_req, reply) => {
    const wp = await findWallpaper();
    if (!wp) return reply.code(404).send({ error: 'No desktop wallpaper found' });
    return reply.type(wp.contentType).header('Cache-Control', 'no-cache').send(createReadStream(wp.path));
  });

  // Attachments arrive as the raw file body: POST /api/attachments?tab=<tabId>&name=<file name>.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  app.post<{ Querystring: { tab?: string; name?: string } }>('/api/attachments', async (req, reply) => {
    const { tab = '', name = '' } = req.query;
    if (!isValidTab(tab) || !name || !Buffer.isBuffer(req.body))
      return reply.code(400).send({ error: 'Expected ?tab=&name= and a file body' });
    // A dropped file only comes with its name: still, a key or a .env file never goes to Claude.
    if (isSensitivePath(name)) return reply.code(403).send({ error: SENSITIVE });
    return saveAttachment(tab, name, req.body);
  });

  // The background picker: the raw image as the body. Saved to ~/.harv, never the repo.
  app.post('/api/background', async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length > MAX_BACKGROUND_BYTES) {
      return reply.code(400).send({ error: 'Expected an image up to 20 MB' });
    }
    if (!saveBackground(req.body)) return reply.code(415).send({ error: 'Use a JPEG, PNG or WebP image' });
    broadcast({ type: 'background', version: backgroundVersion() });
    return { ok: true };
  });
  app.delete('/api/background', async () => {
    removeBackground();
    broadcast({ type: 'background', version: null });
    return { ok: true };
  });

  // The file explorer tab: listings, previews, opening with the default app, and attaching to a chat.
  app.get('/api/files/places', async () => places());
  // `@` in the command line: files and folders to point Harv at.
  app.get('/api/paths', async (req) => suggestPaths(String((req.query as { q?: unknown }).q ?? '')));
  app.get<{ Querystring: { path?: string } }>('/api/files/list', async (req, reply) => {
    const path = cleanPath(req.query.path);
    if (!path) return reply.code(400).send({ error: `Expected an absolute path like ${IS_WINDOWS ? 'C:\\Users' : '/home'}` });
    try {
      return listFolder(path);
    } catch (err) {
      return reply
        .code(404)
        .send({ error: (err as NodeJS.ErrnoException).code === 'EPERM' ? 'No permission to open this folder' : 'Folder not found' });
    }
  });
  app.get<{ Querystring: { path?: string } }>('/api/files/raw', async (req, reply) => {
    const path = localPath(req.query.path);
    if (!path) return reply.code(400).send({ error: 'Bad path' });
    if (isSensitivePath(path)) return reply.code(403).send({ error: SENSITIVE });
    try {
      if (!statSync(path).isFile()) return reply.code(400).send({ error: 'Not a file' });
    } catch {
      return reply.code(404).send({ error: 'File not found' });
    }
    // Anything that isn't an image, PDF or media file is plain text: no sniffing, and a sandbox in case
    // the browser renders it anyway. (Chrome's PDF viewer won't run in a sandbox, so PDFs skip it.)
    const preview = previewType(path);
    reply.type(preview.mime).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
    if (preview.kind === 'text') reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    return reply.send(createReadStream(path));
  });
  app.post<{ Body: { path?: string; reveal?: boolean } }>('/api/files/open', async (req, reply) => {
    const path = localPath(req.body?.path);
    if (!path) return reply.code(400).send({ error: 'Bad path' });
    openWithDefault(path, req.body?.reveal === true);
    return { ok: true };
  });
  app.post<{ Body: { path?: string; tab?: string } }>('/api/files/attach', async (req, reply) => {
    const path = localPath(req.body?.path);
    const tab = req.body?.tab ?? '';
    if (!path || !isValidTab(tab)) return reply.code(400).send({ error: 'Bad path or tab' });
    if (isSensitivePath(path)) return reply.code(403).send({ error: SENSITIVE });
    try {
      const st = statSync(path);
      if (!st.isFile()) return reply.code(400).send({ error: 'Not a file' });
      if (st.size > MAX_ATTACHMENT_BYTES) return reply.code(413).send({ error: 'Bigger than 32 MB' });
      return saveAttachment(tab, basename(path), readFileSync(path));
    } catch {
      return reply.code(404).send({ error: 'File not found' });
    }
  });

  app.get('/api/files/drives', async () => drives());
  app.get('/api/files/recent', async () => recentFiles());
  app.get<{ Querystring: { path?: string; q?: string } }>('/api/files/search', async (req, reply) => {
    const path = cleanPath(req.query.path);
    if (!path || !req.query.q) return reply.code(400).send({ error: 'Expected a folder and words to search for' });
    return await search(path, req.query.q);
  });
  app.get<{ Querystring: { path?: string } }>('/api/files/props', async (req, reply) => {
    const path = localPath(req.query.path);
    if (!path) return reply.code(400).send({ error: 'Bad path' });
    if (isSensitivePath(path)) return reply.code(403).send({ error: SENSITIVE });
    try {
      return await properties(path);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });
  // Changes from the explorer: new, rename, copy, move, Recycle Bin, delete for good.
  app.post<{ Body: FileOp }>('/api/files/op', async (req, reply) => {
    const body = req.body;
    const paths = (list: unknown) => (Array.isArray(list) ? list.map(cleanPath) : []);
    try {
      switch (body?.op) {
        case 'newFolder':
        case 'newFile': {
          const dir = cleanPath(body.dir);
          if (!dir) break;
          return { paths: [body.op === 'newFolder' ? newFolder(dir) : newFile(dir)], errors: [] };
        }
        case 'rename': {
          const path = cleanPath(body.path);
          if (!path || typeof body.name !== 'string') break;
          return { paths: [renameItem(path, body.name.trim())], errors: [] };
        }
        case 'copy':
        case 'move': {
          const list = paths(body.paths);
          const dest = cleanPath(body.dest);
          if (!dest || !list.length || list.some((p) => !p)) break;
          return await (body.op === 'copy' ? copyItems : moveItems)(list as string[], dest);
        }
        case 'recycle':
        case 'deleteForever': {
          const list = paths(body.paths);
          // Never a whole drive (or the Linux root).
          if (!list.length || list.some((p) => !p || p === '/' || /^[a-z]:\\?$/i.test(p))) break;
          return body.op === 'recycle' ? await recycle(list as string[]) : await deleteForever(list as string[]);
        }
      }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return reply.code(400).send({ error: 'Bad request' });
  });
  // Files dropped into the explorer from Windows: the raw file as the body.
  app.post<{ Querystring: { dir?: string; name?: string } }>('/api/files/upload', async (req, reply) => {
    const dir = cleanPath(req.query.dir);
    if (!dir || !req.query.name || !Buffer.isBuffer(req.body))
      return reply.code(400).send({ error: 'Expected ?dir=&name= and a file body' });
    try {
      return { path: saveUpload(dir, req.query.name, req.body) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
