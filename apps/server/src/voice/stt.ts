import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HARV_HOME } from '../paths.ts';
import { IS_WINDOWS } from '../platform.ts';
import { run } from '../run.ts';

// Speech to text on this computer (docs/review/voice-plan.md V1a): faster-whisper in its own venv in
// ~/.harv/voice, installed once from Settings (free, about 1.6 GB of model plus the libraries). One
// warm helper (helper.py, JSON lines, no port) that starts on first use and quits after 5 minutes
// idle, so nothing sits in the graphics card's memory at rest. Plan usage: none.

/** Pinned versions (reviewed 2026-11-15): PyAV 17+ breaks faster-whisper 1.2.1. */
export const VOICE_PACKAGES = ['faster-whisper==1.2.1', 'av==16.1.0'];
/** The CUDA libraries from pip (Windows wheels exist); Linux runs on the CPU (the notebook has no NVIDIA card). */
const GPU_PACKAGES = ['nvidia-cublas-cu12==12.9.2.10', 'nvidia-cudnn-cu12==9.28.1.4'];
export const VOICE_MODEL = 'large-v3-turbo';

const HOME = join(HARV_HOME, 'voice');
const VENV = join(HOME, 'venv');
const MODELS = join(HOME, 'models');
const MARKER = join(HOME, 'installed.json');
const PYTHON = IS_WINDOWS ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python');
const HELPER = fileURLToPath(new URL('./helper.py', import.meta.url));
const IDLE_MS = 5 * 60_000;
/** The longest one request may take (a long video on the CPU) before the helper counts as hung. */
const ASK_TIMEOUT_MS = 15 * 60_000;

/** Turbo in half precision needs about 2.5 GB, in 8-bit about 1.5 GB; 1 GB stays free for everything else. */
const FP16_MIB = 2500 + 1024;
const INT8_MIB = 1500 + 1024;

export interface Placement {
  device: 'cuda' | 'cpu';
  compute: 'float16' | 'int8_float16' | 'int8';
}

/**
 * Where Whisper runs (the plan's GPU rule): never beside a game or Resolve (`gpuBusy`), only in the
 * memory that is really free, else on the CPU. The user never gets a message about it: it's just slower.
 */
export function placement(freeMiB: number | null, gpuBusy: boolean, windows = IS_WINDOWS): Placement {
  if (!windows || gpuBusy || freeMiB == null) return { device: 'cpu', compute: 'int8' };
  if (freeMiB >= FP16_MIB) return { device: 'cuda', compute: 'float16' };
  if (freeMiB >= INT8_MIB) return { device: 'cuda', compute: 'int8_float16' };
  return { device: 'cpu', compute: 'int8' };
}

/** Whisper already on the GPU stays as loaded, unless the GPU is wanted elsewhere now. */
export function keepLoaded(running: Placement | null, wanted: Placement, gpuBusy: boolean): Placement {
  return running?.device === 'cuda' && !gpuBusy ? running : wanted;
}

/** Free graphics memory in MiB, or null without an NVIDIA card. */
export function freeGpuMiB(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 5000 },
      (err, out) => {
        const n = Number.parseInt(String(out).trim().split('\n')[0] ?? '', 10);
        resolve(err || Number.isNaN(n) ? null : n);
      },
    );
  });
}

export interface Transcript {
  text: string;
  language: string;
  duration: number;
  seconds: number;
  device: string;
  fellBack?: string;
  /** format "words": [start, end, word] in seconds. */
  words?: [number, number, string][];
}

/** text, SRT subtitles, or "words": phrases broken on pauses with their times, plus each word's times (for cutting video). */
export type TranscriptFormat = 'text' | 'srt' | 'words';

export interface VoiceStatus {
  installed: boolean;
  installing: boolean;
  /** Where the model sits right now (null: not loaded). */
  running: 'cuda' | 'cpu' | null;
  error?: string;
}

export interface VoiceHooks {
  onChange?: (s: VoiceStatus) => void;
  /** A game or Resolve has the graphics card: Whisper stays on the CPU. */
  gpuBusy?: () => boolean;
}

export class Voice {
  private installing = false;
  private error?: string;
  private helper: ChildProcessWithoutNullStreams | null = null;
  private running: Placement | null = null;
  private waiting = new Map<number, { child: ChildProcessWithoutNullStreams; done: (answer: Record<string, unknown>) => void }>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;

  constructor(private hooks: VoiceHooks = {}) {}

  installed(): boolean {
    return existsSync(MARKER) && existsSync(PYTHON);
  }

  status(): VoiceStatus {
    return {
      installed: this.installed(),
      installing: this.installing,
      running: this.running?.device ?? null,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Settings › Install: the venv with the pinned versions and the model, once per computer. */
  async install(): Promise<void> {
    if (this.installing || this.installed()) return;
    this.installing = true;
    this.error = undefined;
    this.hooks.onChange?.(this.status());
    try {
      rmSync(VENV, { recursive: true, force: true });
      mkdirSync(MODELS, { recursive: true });
      if (IS_WINDOWS) await run('py', ['-3.14', '-m', 'venv', VENV]);
      else await run('python3', ['-m', 'venv', VENV]);
      const pip = ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '--only-binary=:all:'];
      await run(PYTHON, [...pip, ...VOICE_PACKAGES, ...(IS_WINDOWS ? GPU_PACKAGES : [])]);
      // The model, once, into ~/.harv/voice/models; after this the helper runs offline.
      await run(PYTHON, [
        '-c',
        `from faster_whisper.utils import download_model; download_model(${JSON.stringify(VOICE_MODEL)}, cache_dir=${JSON.stringify(MODELS)})`,
      ]);
      writeFileSync(MARKER, JSON.stringify({ at: Date.now(), packages: VOICE_PACKAGES, model: VOICE_MODEL }));
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.installing = false;
      this.hooks.onChange?.(this.status());
    }
  }

  /** Settings › Remove: the venv and the model go; nothing else of the user's is touched. */
  remove(): void {
    this.stop();
    rmSync(HOME, { recursive: true, force: true });
    this.hooks.onChange?.(this.status());
  }

  /** A recording or a video file to text (or SRT subtitles). One at a time; the helper starts on first use. */
  /**
   * `clip`: a spoken message (push-to-talk, the phone), heard as Slovak or English only, so a short
   * Slovak phrase never comes back as Czech. A file keeps the language Whisper clearly hears (a German
   * reel came out as Slovak nonsense: the full review, K7).
   */
  transcribe(path: string, format: TranscriptFormat = 'text', language?: 'sk' | 'en', clip = false): Promise<Transcript> {
    const job = this.queue.then(() => this.runOne(path, format, language, clip));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async runOne(path: string, format: TranscriptFormat, language: 'sk' | 'en' | undefined, clip: boolean): Promise<Transcript> {
    if (!this.installed()) throw new Error('Speech to text is not installed: Settings › What Harv can do › Voice › Install.');
    if (this.idle) clearTimeout(this.idle);
    const place = placement(IS_WINDOWS ? await freeGpuMiB() : null, this.hooks.gpuBusy?.() ?? false);
    // Already loaded on the GPU: keep it as it is (its memory is ours, not free any more). Comparing the
    // free memory again flipped float16 ↔ int8 and reloaded the model on every clip (the full review, K1).
    const where = keepLoaded(this.running, place, this.hooks.gpuBusy?.() ?? false);
    const answer = await this.ask({ cmd: 'transcribe', path, format, language: language ?? null, clip, ...where });
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    if (!answer.ok) throw new Error(String(answer.error ?? 'transcription failed'));
    this.running = { device: answer.device === 'cuda' ? 'cuda' : 'cpu', compute: where.compute };
    this.hooks.onChange?.(this.status());
    return answer as unknown as Transcript;
  }

  /**
   * One request to the helper. A helper that hangs (a broken file, a driver hiccup) is stopped after
   * `timeoutMs`, so the queue goes on (the full review, K4: every later clip waited for ever).
   */
  private ask(req: Record<string, unknown>, timeoutMs = ASK_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const helper = this.start();
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.waiting.delete(id)) return;
        resolve({ ok: false, error: 'The speech helper took too long and was stopped.' });
        if (this.helper === helper) this.stop();
      }, timeoutMs);
      this.waiting.set(id, {
        child: helper,
        done: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
      });
      helper.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.helper) return this.helper;
    const child = spawn(PYTHON, ['-I', HELPER], {
      windowsHide: true,
      env: {
        ...process.env,
        HARV_VOICE_MODEL: VOICE_MODEL,
        HARV_VOICE_MODELS: MODELS,
        // After the install no audio and no request leaves the computer.
        HF_HUB_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
      },
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const entry = this.waiting.get(Number(msg.id));
      this.waiting.delete(Number(msg.id));
      entry?.done(msg);
    });
    child.stderr.on('data', () => undefined);
    child.on('exit', () => {
      // Only this child's requests fail: an old helper stopped by the idle timer mustn't fail a clip
      // already sent to the new one (the full review, K5).
      if (this.helper === child) {
        this.helper = null;
        this.running = null;
      }
      for (const [id, entry] of this.waiting) {
        if (entry.child !== child) continue;
        this.waiting.delete(id);
        entry.done({ ok: false, error: 'The speech helper stopped.' });
      }
      this.hooks.onChange?.(this.status());
    });
    this.helper = child;
    return child;
  }

  /** Quits the helper: the graphics card's memory is free again. */
  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.helper?.kill();
    this.helper = null;
    this.running = null;
  }
}

/** The one speech helper of this Harv (index.ts sets its hooks; chat tools and routes use it). */
export const voice = new Voice();

/** index.ts: report status changes and say when the graphics card is taken. */
export function setVoiceHooks(hooks: VoiceHooks): void {
  (voice as unknown as { hooks: VoiceHooks }).hooks = hooks;
}
