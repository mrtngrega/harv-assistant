import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@harv/shared';
import type { WindowsMcp } from '../tools/windowsMcp.ts';
import type { GeminiImages } from '../tools/gemini.ts';
import { voice } from '../voice/stt.ts';
import { MAX_CLIP_BYTES, transcribeClip } from '../voice/clips.ts';
import { speech } from '../voice/tts.ts';

/** What one speak request may say: a spoken reply's piece, never a whole document. */
const MAX_SPEAK_CHARS = 1500;

export interface DeviceRouteDeps {
  broadcast: (msg: ServerMessage) => void;
  windowsMcp: WindowsMcp;
  gemini: GeminiImages;
}

/** Settings › What Harv can do: desktop control, voice, pictures. */
export function deviceRoutes(app: FastifyInstance, { windowsMcp, gemini }: DeviceRouteDeps) {
  app.get('/api/desktop', async () => {
    // Monitors come and go: Settings sees the current ones next time.
    windowsMcp.refreshMonitors();
    return windowsMcp.status();
  });
  app.post('/api/desktop/install', async () => {
    void windowsMcp.install();
    return windowsMcp.status();
  });
  // Speech to text (voice/stt.ts): Whisper's venv and model, once per computer.
  app.get('/api/voice', async () => ({ ...voice.status(), speech: speech.status() }));
  // Harv's voice (voice plan V2): Piper, and on the PC Seed-VC for the Slovak man's voice.
  app.post('/api/voice/speech/install', async () => {
    void speech.install();
    return speech.status();
  });
  app.post('/api/voice/speech/remove', async () => {
    speech.remove();
    return speech.status();
  });
  // The talk key went down: Harv's voice loads while the user talks (about 14 s the first time).
  app.post('/api/voice/warm', async () => {
    if (speech.installed()) speech.warm();
    return { ok: true };
  });
  app.post('/api/voice/speak', async (req, reply) => {
    const { text, language } = (req.body ?? {}) as { text?: unknown; language?: unknown };
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_SPEAK_CHARS)
      return reply.code(400).send({ error: `Expected { text } up to ${MAX_SPEAK_CHARS} characters` });
    const lang = language === 'sk' || language === 'en' ? language : undefined;
    if (!speech.installed()) return reply.code(409).send({ error: "Harv's voice isn't installed (Settings › What Harv can do › Voice)." });
    try {
      const said = await speech.speak(text.trim(), lang);
      return reply
        .header('Content-Type', 'audio/wav')
        .header('X-Harv-Language', said.language)
        .header('Cache-Control', 'no-store')
        .send(said.wav);
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  });
  app.post('/api/voice/install', async () => {
    void voice.install();
    return voice.status();
  });
  app.post('/api/voice/remove', async () => {
    voice.remove();
    return voice.status();
  });
  // Push-to-talk (voice plan V1b): a recording in, its words out. The owner checks of every route
  // apply (localhost rules); the clip is deleted right after.
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_CLIP_BYTES }, (_req, body, done) => done(null, body));
  app.post('/api/voice/transcribe', async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return reply.code(400).send({ error: 'Expected a recording' });
    if (!voice.installed()) return reply.code(409).send({ error: "Speech to text isn't installed (Settings › What Harv can do › Voice)." });
    try {
      // Harv will answer aloud: his voice loads while Whisper hears this and the model thinks.
      speech.warm();
      return await transcribeClip(voice, req.body, String(req.headers['content-type'] ?? ''));
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  });
  // Pictures: Gemini in a window on Harv's profile, to sign in once.
  app.post('/api/gemini/signin', async (_req, reply) => {
    try {
      await gemini.openSignIn();
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
