import { createStore } from './createStore.ts';

// Harv's own voice (docs/review/voice-plan.md V2): pieces of a reply go to POST /api/voice/speak
// (Piper on this computer; Slovak in the northern man's voice on the PC's graphics card) and play in
// order through one audio element. English plays sentence by sentence as the reply streams; Slovak is
// gathered into bigger pieces, because the voice conversion sounds right only with some context.

/** Slovak waits for this much text before it's spoken (about 8 s of speech, inside Seed-VC's window). */
export const SK_PIECE_CHARS = 140;

/** Harv answers spoken messages in English and speaks only in the English voice (the user, 2026-11-15). */
export const ENGLISH_ONLY = true;

const SK_LETTERS = /[áäčďéíĺľňóôŕšťúýž]/i;
const SK_WORDS = /(^|\s)(a|aj|ako|ale|je|ja|na|nie|sa|si|som|sú|tak|to|už|v|že)(?=\s|[.,!?]|$)/gi;
const EN_WORDS = /(^|\s)(a|and|are|is|it|of|the|this|to|you|your)(?=\s|[.,!?]|$)/gi;

/** Same rule as the server's speechLanguage (voice/tts.ts): the piece's language decides how it's gathered. */
/** Slovak, English, or neither ("Hotovo.", "OK."): a sentence like that follows its neighbours. */
export function languageOf(text: string): 'sk' | 'en' | null {
  if (SK_LETTERS.test(text)) return 'sk';
  const sk = text.match(SK_WORDS)?.length ?? 0;
  const en = text.match(EN_WORDS)?.length ?? 0;
  return sk > en ? 'sk' : en > sk ? 'en' : null;
}

export const isSlovak = (text: string) => languageOf(text) === 'sk';

/** What's carried between calls: Slovak not long enough yet, unclear sentences, the last language. */
export interface PieceState {
  sk: string;
  hold: string;
  last: 'sk' | 'en' | null;
}

export const NO_PIECES: PieceState = { sk: '', hold: '', last: null };

/**
 * Splits finished sentences into the pieces to speak: each English sentence alone, Slovak ones joined
 * up to SK_PIECE_CHARS (the conversion needs context). An unclear sentence waits for the next one's
 * language; `end` says everything still waiting.
 */
export function pieces(sentences: string[], state: PieceState, end: boolean): { out: string[]; state: PieceState } {
  const out: string[] = [];
  let { sk, hold, last } = state;
  const join = (a: string, b: string) => (a ? `${a} ${b}` : b);
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    const lang = languageOf(s);
    if (!lang) {
      // After Slovak that's still gathering, it simply joins it; otherwise it waits.
      if (sk) sk = join(sk, s);
      else if (last === 'en') out.push(s);
      else hold = join(hold, s);
      continue;
    }
    const text = join(hold, s);
    hold = '';
    last = lang;
    if (lang === 'sk') {
      sk = join(sk, text);
      if (sk.length >= SK_PIECE_CHARS) {
        out.push(sk);
        sk = '';
      }
    } else {
      if (sk) out.push(sk);
      sk = '';
      out.push(text);
    }
  }
  if (end) {
    if (hold && last === 'sk') sk = join(sk, hold);
    else if (hold) {
      if (sk) out.push(sk);
      sk = '';
      out.push(hold);
    }
    hold = '';
    if (sk) out.push(sk);
    sk = '';
  }
  return { out, state: { sk, hold, last } };
}

/** Sentences of a text (for pieces): ends at . ! ? … and a space or the end. */
export function sentencesOf(text: string): string[] {
  return (
    text
      .match(/[^.!?…]+(?:[.!?…]+|$)/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

const store = createStore({ speaking: false });
export const useSpeaking = store.use;
export const subscribeSpeaking = store.subscribe;
export const isSpeaking = () => store.get().speaking;

let audio: HTMLAudioElement | null = null;
/** Fetches in order (one at a time on the server anyway), plays in order. */
let chain: Promise<void> = Promise.resolve();
let generation = 0;
let pieceState: PieceState = NO_PIECES;
let inFlight = 0;
/** Ends the piece playing now: a paused element fires neither ended nor error (the full review, K10). */
let finishCurrent: (() => void) | null = null;

const setSpeaking = (speaking: boolean) => {
  if (store.get().speaking !== speaking) store.set({ speaking });
};

function element(): HTMLAudioElement {
  audio ??= new Audio();
  return audio;
}

/** iOS plays sound only after a tap: call this inside the tap that starts voice mode. */
export function unlockAudio() {
  const a = element();
  a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=';
  void a.play().catch(() => {});
}

async function fetchPiece(text: string): Promise<string | null> {
  try {
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // English only for now (the user, 2026-11-15: the Slovak voice waits for later work).
      body: JSON.stringify({ text, language: ENGLISH_ONLY ? 'en' : undefined }),
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

function play(url: string, gen: number): Promise<void> {
  return new Promise((resolve) => {
    if (gen !== generation) {
      URL.revokeObjectURL(url);
      resolve();
      return;
    }
    const a = element();
    const done = () => {
      a.onended = a.onerror = null;
      if (finishCurrent === done) finishCurrent = null;
      URL.revokeObjectURL(url);
      resolve();
    };
    finishCurrent = done;
    a.onended = done;
    a.onerror = done;
    a.src = url;
    a.play().catch(done);
  });
}

function enqueue(text: string) {
  const gen = generation;
  inFlight++;
  setSpeaking(true);
  // The audio is asked for at once (so the next piece is ready while one plays), played in turn.
  const ready = fetchPiece(text);
  chain = chain
    .then(async () => {
      const url = await ready;
      if (url) await play(url, gen);
    })
    .finally(() => {
      // A piece from before a Stop finishes on its own: it belongs to an old count (the full review, K9:
      // it took the new count to -1, and "speaking" stayed wrong for every later reply).
      if (gen !== generation) return;
      inFlight--;
      if (inFlight === 0) setSpeaking(false);
    });
}

/** Finished sentences of a reply, as they come. `end`: the reply is over, say what's still gathered. */
export function speakSentences(sentences: string[], end = false) {
  // English only: every sentence is spoken as it comes; the Slovak gathering would hold a sentence
  // with one Slovak letter (a name) or none of its marker words ("Done.") (the full review, K11).
  if (ENGLISH_ONLY) {
    sentences
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach(enqueue);
    return;
  }
  const { out, state } = pieces(sentences, pieceState, end);
  pieceState = end ? NO_PIECES : state;
  out.forEach(enqueue);
}

/** Stops talking at once (STOP, a new press of the talk key, leaving voice mode). */
export function stopSpeaking() {
  generation++;
  pieceState = NO_PIECES;
  audio?.pause();
  // The paused piece's promise and blob end now; pieces fetched behind it see the new generation and let go of theirs.
  finishCurrent?.();
  inFlight = 0;
  chain = Promise.resolve();
  setSpeaking(false);
}

/** Whether this computer's Harv has his voice installed (Settings › What Harv can do › Voice). */
export async function localSpeechReady(): Promise<boolean> {
  try {
    const res = await fetch('/api/voice');
    if (!res.ok) return false;
    // Here, or through the other computer when this one has no voice (the notebook).
    const v = (await res.json()) as { speech?: { installed?: boolean }; via?: { reachable: boolean; speak: boolean } };
    return v.speech?.installed === true || (v.via?.reachable === true && v.via.speak);
  } catch {
    return false;
  }
}
