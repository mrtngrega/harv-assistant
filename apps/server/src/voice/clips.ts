import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARV_HOME } from '../paths.ts';
import type { Transcript, TranscriptFormat, Voice } from './stt.ts';

// Push-to-talk (docs/review/voice-plan.md V1b): a recording from the app's mic button, the hold key
// or the phone goes in, its words come out. The clip is written only for Whisper to read and is
// deleted right after: nothing of the audio is kept.

/** Two minutes of phone audio is well under this; anything bigger isn't a spoken message. */
export const MAX_CLIP_BYTES = 8 * 1024 * 1024;

/** Every recording Harv writes for Whisper, here or for the other computer (one folder: the full review, K8). */
export const CLIPS = join(HARV_HOME, 'voice', 'clips');

/** At server start: a clip left by a stop mid-hearing is a voice recording the code promised to delete (K8). */
export function sweepClips(): void {
  rmSync(CLIPS, { recursive: true, force: true });
  // The old second folder, from before the two were one.
  rmSync(join(HARV_HOME, 'voice-clips'), { recursive: true, force: true });
}

/** The file ending Whisper's decoder expects for a recording's type ("audio/webm;codecs=opus" → webm). */
export function clipExtension(mime: string): string | null {
  const type = mime.split(';')[0]!.trim().toLowerCase();
  const known: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
  };
  return known[type] ?? null;
}

/**
 * Whisper writes words into near-silence (a thank-you, a subtitle credit). On a short clip those
 * alone mean nothing was said; a real one-word answer ("áno", "yes") stays.
 */
const HALLUCINATIONS = [
  /^(ďakujem|dakujem|děkuji|ďakujem za pozornosť|thank you|thanks for watching|thank you for watching)[.!]?$/i,
  /titulky|subtitles by|amara\.org/i,
];

export function heardText(text: string, durationSec: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (HALLUCINATIONS[1]!.test(t)) return '';
  if (durationSec < 2.5 && HALLUCINATIONS[0]!.test(t)) return '';
  return t;
}

export interface Heard {
  text: string;
  language: string;
  seconds: number;
}

/** A recording to its words. The clip file is gone again when this returns, whatever happened. */
export async function transcribeClip(voice: Voice, audio: Buffer, mime: string): Promise<Heard> {
  const ext = clipExtension(mime);
  if (!ext) throw new Error(`Not a recording Harv can read (${mime || 'no type'}).`);
  mkdirSync(CLIPS, { recursive: true });
  const path = join(CLIPS, `${randomUUID()}.${ext}`);
  writeFileSync(path, audio);
  try {
    const t = await voice.transcribe(path, 'text', undefined, true);
    return { text: heardText(t.text, t.duration), language: t.language, seconds: t.seconds };
  } finally {
    rmSync(path, { force: true });
  }
}

/** A whole file sent by the other computer's transcribe tool: written for Whisper, deleted right after. */
export async function transcribeFile(
  voice: Voice,
  audio: Buffer,
  ext: string,
  format: TranscriptFormat,
  language?: 'sk' | 'en',
): Promise<Transcript> {
  if (!/^[a-z0-9]{1,5}$/.test(ext)) throw new Error('Not a file type Harv can read.');
  mkdirSync(CLIPS, { recursive: true });
  const path = join(CLIPS, `${randomUUID()}.${ext}`);
  writeFileSync(path, audio);
  try {
    return await voice.transcribe(path, format, language);
  } finally {
    rmSync(path, { force: true });
  }
}
