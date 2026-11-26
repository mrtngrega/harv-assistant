// The transcribe tool's way to Whisper: this computer's own, else a remote one if a build adds it
// (none in this release). A file going over is shrunk to
// compressed speech first (16 kHz mono Opus: an hour is ~11 MB), so a long video still fits the link.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { CLIPS } from './clips.ts';
/** Another way to hear a file when this computer has no Whisper of its own (none in this build). */
interface RemoteVoice {
  transcribeFile(audio: Buffer, ext: string, format: TranscriptFormat, language?: 'sk' | 'en'): Promise<Transcript>;
}
import type { Transcript, TranscriptFormat } from './stt.ts';

const run = promisify(execFile);
/** Small audio files go as they are; anything bigger, or any video, is shrunk first. */
const SEND_AS_IS_BYTES = 8 * 1024 * 1024;
const AUDIO = new Set(['wav', 'mp3', 'm4a', 'ogg', 'opus', 'flac', 'webm', 'aac']);
/** Under the live link's 64 MB body, after base64 and the seal. */
const MAX_SEND_BYTES = 40 * 1024 * 1024;

export interface Transcriber {
  installed(): boolean;
  transcribe(path: string, format: TranscriptFormat, language?: 'sk' | 'en'): Promise<Transcript>;
}

export interface Anywhere {
  local: Transcriber;
  remote: Pick<RemoteVoice, 'transcribeFile'> | null;
  /** Shrinks `path` to speech-only Opus at `out` (replaced in tests). */
  shrink?: (path: string, out: string) => Promise<void>;
}

let remoteVoice: Pick<RemoteVoice, 'transcribeFile'> | null = null;
/** index.ts hands over the way to the other computer's voice. */
export function setRemoteTranscriber(remote: Pick<RemoteVoice, 'transcribeFile'> | null): void {
  remoteVoice = remote;
}
export const currentRemote = () => remoteVoice;

async function ffmpegShrink(path: string, out: string): Promise<void> {
  try {
    await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', out],
      {
        windowsHide: true,
        timeout: 10 * 60_000,
      },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new Error(
      e.code === 'ENOENT'
        ? 'Sending this file to the other computer needs ffmpeg here to take its sound out first (Fedora: RPM Fusion’s ffmpeg).'
        : `Couldn’t take the sound out of the file: ${String((err as { stderr?: string }).stderr ?? e.message)
            .trim()
            .split('\n')
            .pop()}`,
      { cause: err },
    );
  }
}

/** A recording or video to text, SRT or words: here when this computer has Whisper, else on the other computer. */
export async function transcribeAnywhere(
  path: string,
  format: TranscriptFormat,
  language: 'sk' | 'en' | undefined,
  { local, remote, shrink = ffmpegShrink }: Anywhere,
): Promise<Transcript> {
  if (local.installed() || !remote) return local.transcribe(path, format, language);
  if (!existsSync(path)) throw new Error(`No file at ${path}.`);
  const ext = extname(path).slice(1).toLowerCase();
  let send = path;
  let sendExt = ext;
  let temp: string | null = null;
  try {
    if (!AUDIO.has(ext) || statSync(path).size > SEND_AS_IS_BYTES) {
      mkdirSync(CLIPS, { recursive: true });
      temp = join(CLIPS, `${randomUUID()}.ogg`);
      await shrink(path, temp);
      send = temp;
      sendExt = 'ogg';
    }
    if (statSync(send).size > MAX_SEND_BYTES)
      throw new Error('The recording is too long to send to the other computer in one go (over ~4 hours of speech): cut it into parts.');
    return await remote.transcribeFile(readFileSync(send), sendExt, format, language);
  } finally {
    if (temp) rmSync(temp, { force: true });
  }
}
