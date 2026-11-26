import { createStore } from './createStore.ts';
import { onServerMessage } from './socket.ts';
import { cancelTalk, getTalk, localVoiceReady, startTalk, stopTalk } from './talk.ts';
import { isSpeaking, localSpeechReady, sentencesOf, speakSentences, stopSpeaking, subscribeSpeaking, unlockAudio } from './speak.ts';

// Voice mode (docs/PLAN.md §6q): listen with the browser's speech recognition, send it
// as a spoken turn, read Harv's reply aloud sentence by sentence as it streams, then listen again.
// Free: Safari's own speech recognition and voices; no audio leaves for any paid service. When this
// computer's Harv has Whisper (Settings › What Harv can do › Voice), the phone records and Whisper hears it instead, in
// Slovak too (voice plan V1b): no more wrong English from the keyboard's dictation.

export type VoiceStage = 'off' | 'listening' | 'waiting' | 'speaking';

interface VoiceState {
  stage: VoiceStage;
  /** The chat voice mode talks in. */
  tabId: string | null;
  /** What's been heard so far (shown while listening). */
  heard: string;
  /** No speech recognition here: the keyboard's dictation mic is the way. */
  noRecognition: boolean;
  error: string;
}

const store = createStore<VoiceState>({ stage: 'off', tabId: null, heard: '', noRecognition: false, error: '' });
export const useVoice = store.use;

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionClass(): (new () => Recognition) | null {
  // On the iPhone, Safari's recognition asked for permission and then froze the Home Screen app
  // (2026-10-29): the keyboard's own dictation mic does the listening there instead.
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Markdown and code read badly aloud: plain words only. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code in the chat) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^[#>\-*+\s]+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Harv's reply to the last message in a chat (its text lines after the user's last one), to read out. */
export function lastReply(lines: readonly { kind: string; text: string }[]): string {
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i]!.kind === 'you') {
      start = i + 1;
      break;
    }
  return lines
    .slice(start)
    .filter((l) => l.kind === 'harv' && l.text.trim())
    .map((l) => l.text.trim())
    .join(' ');
}

/** Whole sentences at the start of `text` (to speak now) and the rest (still coming). */
export function splitSentences(text: string): { done: string; rest: string } {
  const m = /^[\s\S]*[.!?…:](?=\s)/.exec(text);
  if (!m) return { done: '', rest: text };
  return { done: m[0], rest: text.slice(m[0].length) };
}

let recognition: Recognition | null = null;
/** This computer's Whisper does the hearing (checked when voice mode starts and kept for its taps). */
let local = false;
/** Harv's own voice on this computer (voice plan V2) speaks instead of the phone's. */
let localTts = false;
if (typeof window !== 'undefined') {
  void localVoiceReady().then((r) => (local = r));
  void localSpeechReady().then((r) => (localTts = r));
}
let send: ((text: string) => void) | null = null;
/** What Harv said so far in the current reply (deltas), and how much of it was spoken. */
let buffer = '';
let spoken = 0;
let speaking = 0;
let turnDone = false;

const set = (patch: Partial<VoiceState>) => store.set((s) => ({ ...s, ...patch }));

function say(text: string) {
  const words = speakable(text);
  if (words && localTts) {
    set({ stage: 'speaking' });
    speakSentences(sentencesOf(words));
    return;
  }
  if (!words || typeof speechSynthesis === 'undefined') return;
  const u = new SpeechSynthesisUtterance(words);
  u.lang = navigator.language || 'en-US';
  speaking++;
  set({ stage: 'speaking' });
  u.onend = u.onerror = () => {
    speaking = Math.max(0, speaking - 1);
    afterSpeech();
  };
  speechSynthesis.speak(u);
}

/** Harv finished talking and the turn is over: listen again. */
function afterSpeech() {
  const s = store.get();
  if (s.stage === 'off' || speaking > 0 || isSpeaking()) return;
  if (turnDone) listen();
  else set({ stage: 'waiting' });
}

function listen() {
  const s = store.get();
  if (s.stage === 'off') return;
  if (local) {
    recognition?.abort();
    recognition = null;
    set({ stage: 'listening', heard: '', error: '', noRecognition: false });
    // A fresh microphone stream for every recording (V0 test 1: a kept one comes back silent on the iPhone).
    void startTalk('phone');
    return;
  }
  const Rec = recognitionClass();
  if (!Rec) {
    set({ stage: 'listening', noRecognition: true, heard: '' });
    return;
  }
  recognition?.abort();
  const rec = new Rec();
  recognition = rec;
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) finalText += r[0]!.transcript;
      else interim += r[0]!.transcript;
    }
    set({ heard: (finalText + interim).trim() });
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    set({
      error:
        e.error === 'not-allowed'
          ? 'Harv may not use the microphone: allow it in the phone’s Settings › Safari.'
          : `Listening stopped: ${e.error}`,
    });
  };
  rec.onend = () => {
    if (recognition !== rec || store.get().stage !== 'listening') return;
    const text = finalText.trim();
    if (!text) {
      // Heard nothing: stay in voice mode, but stop listening until the next tap.
      set({ heard: '' });
      recognition = null;
      return;
    }
    heard(text);
  };
  set({ stage: 'listening', heard: '', error: '', noRecognition: false });
  try {
    rec.start();
  } catch {
    set({ error: 'The microphone didn’t start. Tap the mic again.' });
  }
}

/** Sends what was heard as a spoken turn. */
function heard(text: string) {
  recognition = null;
  buffer = '';
  spoken = 0;
  turnDone = false;
  set({ stage: 'waiting', heard: text });
  send?.(text);
}

/**
 * Starts voice mode in a chat (from a tap, which iOS needs for the mic and for speech). `sendFn`
 * sends a spoken turn there. `greeting` is said first ("Harv wants to talk" from a notification).
 */
export function startVoice(tabId: string, sendFn: (text: string) => void, greeting?: string) {
  send = sendFn;
  void localVoiceReady().then((r) => (local = r));
  void localSpeechReady().then((r) => (localTts = r));
  // iOS plays page audio only after it played inside a tap once: this is the tap.
  unlockAudio();
  turnDone = true;
  set({ stage: 'waiting', tabId, heard: '', error: '' });
  // iOS lets a page speak only after it spoke inside a tap once.
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  if (greeting) say(greeting);
  else listen();
}

/** Tap while listening: done talking; tap while Harv speaks: stop it and listen. */
export function tapVoice() {
  const s = store.get();
  if (s.stage === 'listening') {
    if (local && getTalk().stage === 'recording') {
      void stopTalk().then((text) => {
        // Heard nothing: stay in voice mode, the next tap records again.
        if (text) heard(text);
        else set({ heard: '', error: 'Didn’t catch that: tap to talk again.' });
      });
    } else if (local && getTalk().stage === 'hearing') return;
    else if (recognition) recognition.stop();
    else listen();
  } else if (s.stage === 'speaking') {
    stopSpeaking();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    speaking = 0;
    turnDone = true;
    listen();
  } else if (s.stage === 'waiting' && turnDone) listen();
}

/** Typed (keyboard dictation, where there's no recognition) instead of heard. */
export function sendHeard(text: string) {
  if (text.trim()) heard(text.trim());
}

export function stopVoice() {
  if (getTalk().by === 'phone') cancelTalk();
  stopSpeaking();
  recognition?.abort();
  recognition = null;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  speaking = 0;
  set({ stage: 'off', tabId: null, heard: '', error: '' });
}

onServerMessage((msg) => {
  const s = store.get();
  if (s.stage === 'off' || !('tabId' in msg) || msg.tabId !== s.tabId) return;
  if (msg.type === 'chat.delta') {
    buffer += msg.text;
    const { done } = splitSentences(buffer.slice(spoken));
    if (done) {
      spoken += done.length;
      say(done);
    }
  } else if (msg.type === 'chat.assistant') {
    // The message is complete: say what's left of it.
    const rest = msg.text.length > spoken ? msg.text.slice(spoken) : buffer.slice(spoken);
    buffer = '';
    spoken = 0;
    if (rest.trim()) say(rest);
  } else if (msg.type === 'chat.done') {
    turnDone = true;
    if (msg.error) say(`Something went wrong: ${msg.error}`);
    if (localTts) speakSentences([], true);
    afterSpeech();
  }
});

// Harv's own voice finished: voice mode listens again (the phone's voice did it per utterance).
subscribeSpeaking(() => {
  if (!isSpeaking()) afterSpeech();
});

/**
 * The desk's talk key (voice plan V2): Harv's reply to what was just said is read aloud in his own
 * voice, sentence by sentence as it streams. Voice mode has its own reading above.
 */
let follow: {
  tabId: string;
  buffer: string;
  spoken: number;
  waitFor?: string;
  /** The words went into the running reply (the server folded them in): only Harv's "got it" and his last line are read. */
  addition?: { acked: boolean; last: string };
} | null = null;

/** At most this many sentences of the "got it" and of the last line (the reply goes on in text). */
const ADDITION_SENTENCES = 2;

/** The last paragraph of a reply: the one short spoken line on the result Harv was asked to end with. */
export function lastLine(text: string): string {
  return (
    text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  );
}
/** Each chat's queue as the server last published it (the texts only), for a spoken message sent mid-reply. */
const queues = new Map<string, string[]>();

/**
 * A spoken message sent while the chat was busy goes into the running reply at its next tool step
 * (then only the "got it" and the last line are read: `addition` below), or, when the reply ends
 * before taking it, waits in the server's queue for a turn of its own. That turn is the first one that starts
 * once the message is no longer queued (the server takes it off the queue just before starting it).
 */
export function spokenTurnStarts(waitFor: string, queued: readonly string[]): boolean {
  return !queued.includes(waitFor);
}

/**
 * `busy`: the chat was mid-reply when the words were sent. The running reply isn't read aloud from
 * the middle of a sentence; the answer to the spoken question is (the full review, K13).
 */
export function speakReplyIn(tabId: string, text = '', busy = false) {
  stopSpeaking();
  // Asked again every time (installed or removed since the page loaded); the answer is back long
  // before the reply's first words.
  follow = { tabId, buffer: '', spoken: 0, ...(busy && text ? { waitFor: text } : {}) };
  void localSpeechReady().then((r) => {
    localTts = r;
    if (!r && follow?.tabId === tabId) follow = null;
  });
}

export function stopReplySpeech() {
  follow = null;
  stopSpeaking();
}

onServerMessage((msg) => {
  if (msg.type === 'chat.queued')
    queues.set(
      msg.tabId,
      msg.items.map((i) => i.text),
    );
  const f = follow;
  if (!f || store.get().stage !== 'off') return;
  // "Start a new chat and …" was said: the answer comes in the new chat, read from its start.
  if (msg.type === 'chat.opened' && msg.movedFrom === f.tabId) {
    follow = { tabId: msg.chat.id, buffer: '', spoken: 0 };
    return;
  }
  if (!('tabId' in msg) || msg.tabId !== f.tabId) return;
  if (f.waitFor !== undefined) {
    // Its own turn started (it waited in the queue, or the reply ended before taking it): read all of it.
    if (msg.type === 'chat.started' && (f.addition || spokenTurnStarts(f.waitFor, queues.get(f.tabId) ?? []))) {
      delete f.waitFor;
      delete f.addition;
      return;
    }
    // The words went into the running reply: its "got it" and its last line are read, not the work between.
    if (msg.type === 'chat.line' && msg.line.kind === 'you' && msg.line.text === f.waitFor) f.addition ??= { acked: false, last: '' };
    const a = f.addition;
    if (!a) return;
    if (msg.type === 'chat.assistant' && msg.text.trim()) {
      if (a.acked) a.last = msg.text;
      else {
        a.acked = true;
        speakSentences(sentencesOf(speakable(msg.text)).slice(0, ADDITION_SENTENCES));
      }
    } else if (msg.type === 'chat.done') {
      const end = sentencesOf(speakable(lastLine(a.last)));
      speakSentences(end.slice(-ADDITION_SENTENCES), true);
      follow = null;
    }
    return;
  }
  if (msg.type === 'chat.delta') {
    f.buffer += msg.text;
    const { done } = splitSentences(f.buffer.slice(f.spoken));
    if (done) {
      f.spoken += done.length;
      speakSentences(sentencesOf(speakable(done)));
    }
  } else if (msg.type === 'chat.assistant') {
    const rest = msg.text.length > f.spoken ? msg.text.slice(f.spoken) : f.buffer.slice(f.spoken);
    f.buffer = '';
    f.spoken = 0;
    if (rest.trim()) speakSentences(sentencesOf(speakable(rest)));
  } else if (msg.type === 'chat.done') {
    speakSentences([], true);
    follow = null;
  }
});
