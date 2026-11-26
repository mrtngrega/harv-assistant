import { describe, expect, it } from 'vitest';
import { clipExtension, heardText } from './clips.ts';

describe('push-to-talk clips (voice plan V1b)', () => {
  it('knows the recording types of the app, Chrome and the iPhone', () => {
    expect(clipExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(clipExtension('audio/mp4')).toBe('m4a');
    expect(clipExtension('audio/ogg; codecs=opus')).toBe('ogg');
    expect(clipExtension('video/mp4')).toBeNull();
    expect(clipExtension('')).toBeNull();
  });

  it('drops what Whisper writes into silence, keeps a real short answer', () => {
    expect(heardText('  Ďakujem. ', 0.8)).toBe('');
    expect(heardText('Thank you.', 1.2)).toBe('');
    expect(heardText('Titulky vytvoril JohnyX', 6)).toBe('');
    expect(heardText('áno', 0.7)).toBe('áno');
    expect(heardText('Yes', 0.6)).toBe('Yes');
    // A longer clip that really says thank you is a real thank-you.
    expect(heardText('Ďakujem.', 3)).toBe('Ďakujem.');
    expect(heardText('Skontroluj  mi\n poštu', 2)).toBe('Skontroluj mi poštu');
  });
});
