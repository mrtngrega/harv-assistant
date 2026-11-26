import type { NoticeLevel } from './notices.ts';

/**
 * Harv's two notice sounds, made in code (no files, docs/PLAN.md §6ad): a soft tick for normal
 * notices and a two-note chime for warnings and urgent ones. Settings › Appearance turns them off
 * and sets the volume, per computer. Browsers start audio only after the page has had a click or a
 * key, so the first sound of a fresh window can stay silent.
 */

/** A sine that falls from C6 to G5 in 50 ms and is gone in 90 ms. */
function playTick(ctx: AudioContext, out: AudioNode, at: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1046.5, at);
  osc.frequency.exponentialRampToValueAtTime(784, at + 0.05);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(0.5, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + 0.11);
}

/** D5 then A5 (a rising fifth), 160 ms apart: a sine body plus a quiet triangle an octave up. */
function playChime(ctx: AudioContext, out: AudioNode, at: number) {
  for (const [freq, delay] of [
    [587.33, 0],
    [880, 0.16],
  ] as const) {
    const t = at + delay;
    for (const [type, f, peak] of [
      ['sine', freq, 0.4],
      ['triangle', freq * 2, 0.06],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      osc.connect(gain).connect(out);
      osc.start(t);
      osc.stop(t + 0.75);
    }
  }
}

/** 100% is still quiet: the master gain is volume × this. */
const MASTER = 0.5;
let ctx: AudioContext | null = null;
let out: GainNode | null = null;

export type SoundKind = 'tick' | 'chime';
export const soundFor = (level: NoticeLevel): SoundKind => (level === 'normal' ? 'tick' : 'chime');

/** Plays one sound at `volume` (0–100). False when audio isn't available. */
export function playSound(kind: SoundKind, volume: number): boolean {
  if (volume <= 0 || typeof window === 'undefined') return false;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      out = ctx.createGain();
      out.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    out!.gain.value = MASTER * (Math.min(100, volume) / 100);
    (kind === 'tick' ? playTick : playChime)(ctx, out!, ctx.currentTime + 0.02);
    return true;
  } catch {
    return false;
  }
}
