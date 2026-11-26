import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HARV_HOME } from '../paths.ts';
import { IS_WINDOWS } from '../platform.ts';
import { run } from '../run.ts';
import { freeGpuMiB } from './stt.ts';

// Harv's voice (docs/review/voice-plan.md V2): Piper on this computer, in his own venv in
// ~/.harv/voice/tts, installed once from Settings. English: Piper's northern_english_male. Slovak:
// Piper's lili, on the PC converted by Seed-VC on the graphics card into the same northern man (the
// user's pick, 2026-11-15); on the processor that takes ~20 s a sentence, so the notebook and a busy
// card speak Slovak in lili's own voice. Free, local, nothing leaves the computer. Plan usage: none.

/** Pinned (the set measured 2026-11-15 on Python 3.14). */
export const PIPER_PACKAGES = ['piper-tts==1.8.0'];
const TORCH = ['torch==2.11.0', 'torchaudio==2.11.0'];
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128';
const SEEDVC_PACKAGES = [
  'librosa==1.0.1',
  'transformers==5.23.0',
  'huggingface_hub==2.4.0',
  'munch==4.0.0',
  'einops==0.8.2',
  'soundfile==0.14.0',
  'PyYAML==6.0.3',
  'scipy==1.18.1',
  'descript-audio-codec==1.0.0',
];
/** descript-audiotools pins an old protobuf that breaks Piper's onnxruntime: the newer one after it. */
const PROTOBUF = 'protobuf==7.36.2';
const SEEDVC_REPO = 'https://github.com/Plachtaa/seed-vc.git';
/** The archived repo's last commit (2025-04-20, GPL-3.0); run as a separate program, never changed. */
const SEEDVC_COMMIT = '51383ef';
export const VOICES = ['en_GB-northern_english_male-medium', 'sk_SK-lili-medium'];

const HOME = join(HARV_HOME, 'voice', 'tts');
const VENV = join(HOME, 'venv');
const MARKER = join(HOME, 'installed.json');
const OUT = join(HOME, 'out');
const PYTHON = IS_WINDOWS ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python');
const HELPER = fileURLToPath(new URL('./tts_helper.py', import.meta.url));
/** Loaded for a conversation (the first load takes ~14 s), freed after 15 quiet minutes. */
const IDLE_MS = 15 * 60_000;
/** Seed-VC on the card takes about 1.5 GB; 1 GB stays free for everything else. */
const CONVERT_MIB = 1500 + 1024;

export type SpeechLanguage = 'en' | 'sk';

/** Spoken replies are English only for now (the user, 2026-11-15); the Slovak voice comes back later. */
export const ENGLISH_ONLY = true;

const SK_LETTERS = /[áäčďéíĺľňóôŕšťúýž]/i;
const SK_WORDS = new Set(
  'a aj ako ale alebo by bol bola bude do je ja ju k ku ma mám máš mi mne mu na nie no od po pre pri sa si som sme so ste sú ta tak to tu už v vo z za že'.split(
    ' ',
  ),
);
const EN_WORDS = new Set('a an and are be but do for have i in is it of on or so that the this to was we with you your'.split(' '));

/** Which voice reads this text: Slovak letters or more Slovak than English little words → Slovak. */
export function speechLanguage(text: string): SpeechLanguage {
  if (SK_LETTERS.test(text)) return 'sk';
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  let sk = 0;
  let en = 0;
  for (const w of words) {
    if (SK_WORDS.has(w)) sk++;
    if (EN_WORDS.has(w)) en++;
  }
  return sk > en ? 'sk' : 'en';
}

/** Convert lili into the northern man only on a free graphics card (the processor is far too slow). */
export function convertOn(windows: boolean, freeMiB: number | null, gpuBusy: boolean): 'cuda' | null {
  return windows && !gpuBusy && freeMiB != null && freeMiB >= CONVERT_MIB ? 'cuda' : null;
}

export interface SpeechStatus {
  installed: boolean;
  installing: boolean;
  /** This computer turns Slovak into the northern man (Windows with an NVIDIA card). */
  converts: boolean;
  error?: string;
}

export interface Spoken {
  wav: Buffer;
  language: SpeechLanguage;
  converted: boolean;
}

export class Speech {
  private installing = false;
  private error?: string;
  private helper: ChildProcessWithoutNullStreams | null = null;
  private waiting = new Map<number, { child: ChildProcessWithoutNullStreams; done: (answer: Record<string, unknown>) => void }>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;

  constructor(private gpuBusy: () => boolean = () => false) {}

  /** Set at start (index.ts): Resolve or a game has the graphics card (voice/gpuBusy.ts). */
  setGpuBusy(busy: () => boolean): void {
    this.gpuBusy = busy;
  }

  installed(): boolean {
    return existsSync(MARKER) && existsSync(PYTHON);
  }

  private converts(): boolean {
    if (!this.installed()) return IS_WINDOWS;
    try {
      return (JSON.parse(readFileSync(MARKER, 'utf8')) as { converts?: boolean }).converts === true;
    } catch {
      return false;
    }
  }

  status(): SpeechStatus {
    return {
      installed: this.installed(),
      installing: this.installing,
      converts: this.converts(),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Settings › Install: Piper and the voices; with Slovak on (not ENGLISH_ONLY), on Windows also torch and Seed-VC (about 4 GB). */
  async install(onChange?: () => void): Promise<void> {
    if (this.installing || this.installed()) return;
    this.installing = true;
    this.error = undefined;
    onChange?.();
    try {
      this.stop();
      rmSync(VENV, { recursive: true, force: true });
      mkdirSync(HOME, { recursive: true });
      if (IS_WINDOWS) await run('py', ['-3.14', '-m', 'venv', VENV]);
      else await run('python3', ['-m', 'venv', VENV]);
      const pip = ['-m', 'pip', 'install', '-q', '--disable-pip-version-check'];
      // English only: Piper and the English voice, none of the ~4 GB Seed-VC needs (the full review, K3).
      const converts = !ENGLISH_ONLY && IS_WINDOWS && (await freeGpuMiB()) != null;
      if (converts) {
        await run(PYTHON, [...pip, ...TORCH, '--index-url', TORCH_INDEX]);
        await run(PYTHON, [...pip, ...PIPER_PACKAGES, ...SEEDVC_PACKAGES]);
        await run(PYTHON, [...pip, PROTOBUF]);
        const repo = join(HOME, 'seed-vc');
        if (!existsSync(join(repo, '.git'))) await run('git', ['clone', '-q', SEEDVC_REPO, repo]);
        await run('git', ['-C', repo, 'checkout', '-q', SEEDVC_COMMIT]);
      } else await run(PYTHON, [...pip, ...PIPER_PACKAGES]);
      await run(PYTHON, [
        '-m',
        'piper.download_voices',
        '--download-dir',
        join(HOME, 'voices'),
        ...(ENGLISH_ONLY ? VOICES.slice(0, 1) : VOICES),
      ]);
      // The reference voice, and on the PC Seed-VC's models (downloaded once, online this one time).
      const ready = await this.ask({ cmd: 'prepare', device: converts ? 'cuda' : 'cpu', convert: converts, english: ENGLISH_ONLY }, true);
      this.stop();
      if (!ready.ok) throw new Error(String(ready.error ?? 'the voice test failed'));
      writeFileSync(MARKER, JSON.stringify({ at: Date.now(), converts, piper: PIPER_PACKAGES, seedVc: converts ? SEEDVC_COMMIT : null }));
    } catch (err) {
      this.error = (err as Error).message.slice(0, 300);
    } finally {
      this.installing = false;
      onChange?.();
    }
  }

  /** Settings › Remove: the venv, the voices and Seed-VC's models go. */
  remove(): void {
    this.stop();
    rmSync(HOME, { recursive: true, force: true });
  }

  /** Text to Harv's voice (a WAV). One at a time; the helper starts on first use and quits when idle. */
  speak(text: string, language: SpeechLanguage = speechLanguage(text)): Promise<Spoken> {
    const job = this.queue.then(() => this.runOne(text, ENGLISH_ONLY ? 'en' : language));
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** The user just spoke (push-to-talk): load the voices now, so the reply needn't wait ~14 s for them. */
  warm(): void {
    if (!this.installed() || this.installing) return;
    const job = this.queue.then(async () => {
      if (this.idle) clearTimeout(this.idle);
      const device = this.converts() ? convertOn(IS_WINDOWS, IS_WINDOWS ? await freeGpuMiB() : null, this.gpuBusy()) : null;
      // English only for now (the user, 2026-11-15): Seed-VC isn't loaded, its graphics memory stays free.
      await this.ask({
        cmd: 'warm',
        convert: ENGLISH_ONLY ? false : device != null,
        device: device ?? 'cpu',
        langs: ENGLISH_ONLY ? ['en'] : ['en', 'sk'],
      });
      this.idle = setTimeout(() => this.stop(), IDLE_MS);
    });
    this.queue = job.catch(() => undefined);
  }

  private async runOne(text: string, language: SpeechLanguage): Promise<Spoken> {
    if (!this.installed()) throw new Error('Harv’s voice is not installed: Settings › What Harv can do › Voice.');
    if (this.idle) clearTimeout(this.idle);
    const device =
      language === 'sk' && this.converts() ? convertOn(IS_WINDOWS, IS_WINDOWS ? await freeGpuMiB() : null, this.gpuBusy()) : null;
    mkdirSync(OUT, { recursive: true });
    const out = join(OUT, `${randomUUID()}.wav`);
    try {
      const answer = await this.ask({ cmd: 'speak', text, lang: language, out, convert: device != null, device: device ?? 'cpu' });
      if (!answer.ok) throw new Error(String(answer.error ?? 'speaking failed'));
      return { wav: readFileSync(out), language, converted: answer.converted === true };
    } finally {
      rmSync(out, { force: true });
      this.idle = setTimeout(() => this.stop(), IDLE_MS);
    }
  }

  private ask(req: Record<string, unknown>, online = false): Promise<Record<string, unknown>> {
    const helper = this.start(online);
    const id = this.nextId++;
    // A hung helper is stopped, so later replies still speak (the full review, K4). The install's
    // first run downloads models, so it gets far longer.
    const timeoutMs = online ? 30 * 60_000 : 3 * 60_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.waiting.delete(id)) return;
        resolve({ ok: false, error: 'Harv’s voice helper took too long and was stopped.' });
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

  private start(online: boolean): ChildProcessWithoutNullStreams {
    if (this.helper) return this.helper;
    const child = spawn(PYTHON, ['-I', HELPER], {
      windowsHide: true,
      cwd: HOME,
      env: {
        ...process.env,
        HARV_TTS_HOME: HOME,
        HF_HOME: join(HOME, 'hf'),
        HF_HUB_DISABLE_TELEMETRY: '1',
        // After the install nothing is fetched: no text Harv says leaves the computer.
        ...(online ? {} : { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }),
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
      if (this.helper === child) this.helper = null;
      // Only this child's requests: an old helper's exit mustn't fail the new one's (the full review, K5).
      for (const [id, entry] of this.waiting) {
        if (entry.child !== child) continue;
        this.waiting.delete(id);
        entry.done({ ok: false, error: 'Harv’s voice helper stopped.' });
      }
    });
    this.helper = child;
    return child;
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.helper?.kill();
    this.helper = null;
  }
}

/** The one voice of this Harv (routes use it). A game or Resolve on the card keeps it off the GPU (setGpuBusy). */
export const speech = new Speech();
