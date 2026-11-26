import { describe, expect, it } from 'vitest';
import { convertOn, speechLanguage } from './tts.ts';

describe('Harv’s voice (voice plan V2)', () => {
  it('reads Slovak in the Slovak voice and English in the English one', () => {
    expect(speechLanguage('Dobrý večer, všetko beží, ako má.')).toBe('sk');
    expect(speechLanguage('Hotovo, poslal som to.')).toBe('sk');
    // No Slovak letters at all, still Slovak by its little words.
    expect(speechLanguage('Je to tak, ako si chcel.')).toBe('sk');
    expect(speechLanguage('Good evening. Everything is running as it should.')).toBe('en');
    expect(speechLanguage('Done, I sent it to you.')).toBe('en');
    expect(speechLanguage('OK.')).toBe('en');
  });

  it('turns Slovak into the northern man only on a free graphics card', () => {
    expect(convertOn(true, 6000, false)).toBe('cuda');
    expect(convertOn(true, 1800, false)).toBeNull();
    expect(convertOn(true, 6000, true)).toBeNull();
    expect(convertOn(true, null, false)).toBeNull();
    // The notebook: lili as she is (the processor takes ~20 s a sentence).
    expect(convertOn(false, 6000, false)).toBeNull();
  });
});
