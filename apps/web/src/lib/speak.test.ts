import { describe, expect, it } from 'vitest';
import { isSlovak, NO_PIECES, pieces, sentencesOf, SK_PIECE_CHARS } from './speak.ts';

describe('Harv’s voice: what is spoken when (voice plan V2)', () => {
  it('splits a reply into sentences', () => {
    expect(sentencesOf('Hotovo. Poslal som to! A ďalej?')).toEqual(['Hotovo.', 'Poslal som to!', 'A ďalej?']);
    expect(sentencesOf('No full stop at the end')).toEqual(['No full stop at the end']);
    expect(sentencesOf('')).toEqual([]);
  });

  it('knows Slovak from English like the server does', () => {
    expect(isSlovak('Dobrý večer.')).toBe(true);
    expect(isSlovak('Je to tak.')).toBe(true);
    expect(isSlovak('It is done.')).toBe(false);
  });

  it('speaks each English sentence at once', () => {
    expect(pieces(['I sent it to you.', 'It is in Downloads.'], NO_PIECES, false).out).toEqual([
      'I sent it to you.',
      'It is in Downloads.',
    ]);
    // An unclear first sentence goes with the one after it; after English it goes at once.
    expect(pieces(['Done.', 'I sent it to you.'], NO_PIECES, false).out).toEqual(['Done. I sent it to you.']);
    expect(pieces(['I sent it to you.', 'Done.'], NO_PIECES, false).out).toEqual(['I sent it to you.', 'Done.']);
  });

  it('gathers Slovak until there is enough for the voice conversion, and says the rest at the end', () => {
    // "Hotovo." alone is neither: it waits, then goes with the Slovak sentence after it.
    const first = pieces(['Hotovo.', 'Poslal som to.'], NO_PIECES, false);
    expect(first.out).toEqual([]);
    expect(pieces([], first.state, true).out).toEqual(['Hotovo. Poslal som to.']);
    const long = 'Grafická karta je chladná a na diskoch je dosť miesta, nič nezvyčajné sa pri štarte nespúšťa.';
    const out = pieces([long, long], NO_PIECES, false).out;
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBeGreaterThanOrEqual(SK_PIECE_CHARS);
  });

  it('keeps the order when English comes after gathered Slovak', () => {
    expect(pieces(['Už je to hotové.', 'See the chat for the details.'], NO_PIECES, false).out).toEqual([
      'Už je to hotové.',
      'See the chat for the details.',
    ]);
  });

  it('an unclear sentence at the end follows the language before it', () => {
    const sk = pieces(['Poslal som to.', 'OK.'], NO_PIECES, true).out;
    expect(sk).toEqual(['Poslal som to. OK.']);
    const en = pieces(['I sent it to you.', 'Hotovo.'], NO_PIECES, true).out;
    expect(en).toEqual(['I sent it to you.', 'Hotovo.']);
  });
});
