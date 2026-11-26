import { createStore } from './createStore.ts';
import { stopSpeaking } from './speak.ts';

// Push-to-talk (docs/review/voice-plan.md V1b): record in the page, Whisper on this computer turns it
// into words (POST /api/voice/transcribe), the words go in as typed text. Used by the mic button in
// harv> (the words wait in the line to be read first), the app's hold key (Ctrl+Alt+Space:
// sent at once) and the phone's voice mode. The microphone is open only while recording.

export type TalkStage = 'off' | 'recording' | 'hearing';

interface TalkState {
  stage: TalkStage;
  /** Who started it: the hold key sends at once, the button fills the line. */
  by: 'button' | 'key' | 'phone' | null;
  error: string;
}

const store = createStore<TalkState>({ stage: 'off', by: null, error: '' });
export const useTalk = store.use;
export const getTalk = store.get;
export const subscribeTalk = store.subscribe;

/** A clip never runs longer than this (the server caps the size too). */
export const MAX_TALK_MS = 2 * 60_000;
/** Shorter than this is a slip of the key, not speech. */
export const MIN_TALK_MS = 300;

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let startedAt = 0;
let cap: ReturnType<typeof setTimeout> | null = null;
let starting: Promise<boolean> | null = null;
/** Released before the microphone was even open: stop as soon as it is. */
let releasedEarly = false;

const set = (patch: Partial<TalkState>) => store.set((s) => ({ ...s, ...patch }));

/** The type the browser records in: WebView2 and Chrome do WebM/Opus, the iPhone MP4/AAC. */
function recordingType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
}

function micError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Harv may not use the microphone: allow it for Harv, then try again.';
  if (name === 'NotFoundError') return 'No microphone found.';
  return 'The microphone didn’t start.';
}

/** Opens the microphone and records. A fresh stream every time: on the iPhone a kept one comes back silent (V0 test 1). */
export function startTalk(by: TalkState['by']): Promise<boolean> {
  if (store.get().stage !== 'off' || starting) return starting ?? Promise.resolve(false);
  releasedEarly = false;
  // Talking over Harv: he stops (the microphone would hear him otherwise).
  stopSpeaking();
  // He'll answer aloud: his voice loads while the user talks (nothing happens if it isn't installed).
  if (by !== 'button') void fetch('/api/voice/warm', { method: 'POST' }).catch(() => {});
  set({ stage: 'recording', by, error: '' });
  starting = (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no getUserMedia');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = recordingType();
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.start();
      startedAt = Date.now();
      cap = setTimeout(() => void stopTalk(), MAX_TALK_MS);
      return true;
    } catch (err) {
      closeMic();
      set({ stage: 'off', by: null, error: micError(err) });
      return false;
    } finally {
      starting = null;
    }
  })();
  return starting.then((ok) => {
    if (ok && releasedEarly) void stopTalk();
    return ok;
  });
}

function closeMic() {
  if (cap) clearTimeout(cap);
  cap = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  recorder = null;
}

/** Stops recording; resolves with the recording (null: too short, nothing recorded, or not recording). */
function stopRecording(): Promise<Blob | null> {
  const rec = recorder;
  if (!rec || rec.state === 'inactive') {
    closeMic();
    return Promise.resolve(null);
  }
  const long = Date.now() - startedAt >= MIN_TALK_MS;
  return new Promise((resolve) => {
    rec.onstop = () => {
      const blob = chunks.length ? new Blob(chunks, { type: rec.mimeType || chunks[0]!.type }) : null;
      chunks = [];
      closeMic();
      resolve(long ? blob : null);
    };
    rec.stop();
  });
}

/** Whisper on this computer: the words of a recording ('' when nothing was said). */
export async function transcribe(blob: Blob): Promise<string> {
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Harv couldn’t hear it (${res.status}).`);
  return body.text ?? '';
}

/**
 * Stops and hears: resolves with the words ('' for nothing, null when it failed: the error is in
 * the store). Called on release of the key, the second click, or the 2-minute cap.
 */
export async function stopTalk(): Promise<string | null> {
  if (starting) {
    releasedEarly = true;
    return null;
  }
  if (store.get().stage !== 'recording') return null;
  const by = store.get().by;
  const blob = await stopRecording();
  if (!blob) {
    set({ stage: 'off', by: null });
    return '';
  }
  set({ stage: 'hearing' });
  try {
    const text = await transcribe(blob);
    set({ stage: 'off', by: null });
    finished?.(text, by);
    return text;
  } catch (err) {
    set({ stage: 'off', by: null, error: (err as Error).message });
    return null;
  }
}

/** Throws the recording away (Esc, leaving voice mode). */
export function cancelTalk() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null;
    recorder.stop();
  }
  chunks = [];
  closeMic();
  set({ stage: 'off', by: null });
}

export function clearTalkError() {
  if (store.get().error) set({ error: '' });
}

/** What happens with the words once heard (set by the chat panel: fill the line or send). */
let finished: ((text: string, by: TalkState['by']) => void) | null = null;
export function onHeard(fn: typeof finished) {
  finished = fn;
}

/**
 * Whether Harv can hear here: `ready` (this computer's Whisper, or the other computer's it goes
 * through), `away` (voice goes through that computer and it can't be reached now: the mic is greyed),
 * or `none` (no voice).
 */
export type VoiceReach = { state: 'ready' } | { state: 'away'; name: string } | { state: 'none' };

export async function voiceReach(): Promise<VoiceReach> {
  try {
    const res = await fetch('/api/voice');
    if (!res.ok) return { state: 'none' };
    const v = (await res.json()) as { installed?: boolean; via?: { name: string; reachable: boolean; hear: boolean } };
    if (v.installed) return { state: 'ready' };
    if (v.via) return v.via.reachable && v.via.hear ? { state: 'ready' } : { state: 'away', name: v.via.name };
    return { state: 'none' };
  } catch {
    return { state: 'none' };
  }
}

/** Whether Harv can hear right now (here or through the other computer). */
export async function localVoiceReady(): Promise<boolean> {
  return (await voiceReach()).state === 'ready';
}

// The app's hold key (src-tauri/src/talk.rs): Ctrl+Alt+Space down records, letting go sends.
if (typeof window !== 'undefined')
  window.addEventListener('harv-talk', (e) => {
    const down = (e as CustomEvent<{ down?: boolean }>).detail?.down;
    // Held again while the last clip is still being heard (seconds on the notebook): said, not lost
    // without a sign (the full review, K12).
    if (down && store.get().stage === 'hearing') set({ error: 'Still hearing your last words: hold the key again in a moment.' });
    else if (down) void startTalk('key');
    else if (store.get().by === 'key') void stopTalk();
  });
