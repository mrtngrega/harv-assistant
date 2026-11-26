import { afterAll, describe, expect, it, vi } from 'vitest';

// The full review, K9: a Stop while a piece was still being fetched left "speaking" wrong for every
// later reply. Here fetch and Audio are fakes: each piece's sound arrives when the test says so, and
// "plays" until the test ends it.
const fetches: ((ok: boolean) => void)[] = [];
const revoked: string[] = [];
let blobs = 0;
Object.assign(URL, { createObjectURL: () => `blob:${++blobs}`, revokeObjectURL: (u: string) => void revoked.push(u) });
vi.stubGlobal(
  'fetch',
  () => new Promise((resolve) => fetches.push((ok) => resolve({ ok, blob: async () => new Blob(['x']) } as unknown as Response))),
);
const players: { end: () => void }[] = [];
class FakeAudio {
  src = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play() {
    players.push({ end: () => this.onended?.() });
    return Promise.resolve();
  }
  pause() {}
}
vi.stubGlobal('Audio', FakeAudio);
afterAll(() => vi.unstubAllGlobals());

const { isSpeaking, speakSentences, stopSpeaking } = await import('./speak.ts');
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('a Stop while a piece is still on its way', () => {
  it('leaves "speaking" right for the next reply', async () => {
    speakSentences(['First reply, cut short.'], true);
    expect(isSpeaking()).toBe(true);
    stopSpeaking();
    expect(isSpeaking()).toBe(false);
    // The old piece arrives after the Stop: it must not touch the new count.
    fetches.shift()!(true);
    await tick();
    await tick();

    speakSentences(['Second reply, one piece.'], true);
    expect(isSpeaking()).toBe(true);
    fetches.shift()!(true);
    await tick();
    await tick();
    players.at(-1)!.end();
    await tick();
    await tick();
    expect(isSpeaking()).toBe(false);
  });

  it('lets go of the paused piece at a Stop (K10)', async () => {
    revoked.length = 0;
    speakSentences(['Playing now.'], true);
    fetches.shift()!(true);
    await tick();
    await tick();
    const playing = `blob:${blobs}`;
    stopSpeaking();
    expect(revoked).toContain(playing);
  });

  it('speaks an English sentence at once, even with a Slovak letter or no marker words (K11)', () => {
    const before = fetches.length;
    speakSentences(['Done.']);
    speakSentences(['I met Ján in Žilina.']);
    expect(fetches.length - before).toBe(2);
    stopSpeaking();
  });
});
