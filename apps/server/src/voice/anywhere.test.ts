import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { transcribeAnywhere, type Transcriber } from './anywhere.ts';
import type { Transcript } from './stt.ts';

const dir = mkdtempSync(join(tmpdir(), 'harv-anywhere-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const said: Transcript = { text: 'ahoj', language: 'sk', duration: 2, seconds: 1, device: 'cpu' };
const localVoice = (installed: boolean): Transcriber & { transcribe: ReturnType<typeof vi.fn> } => ({
  installed: () => installed,
  transcribe: vi.fn(async () => said),
});

describe('the transcribe tool on either computer', () => {
  it('uses this computer’s Whisper when it has one', async () => {
    const local = localVoice(true);
    const remote = { transcribeFile: vi.fn() };
    expect(await transcribeAnywhere('C:/x.wav', 'srt', 'sk', { local, remote })).toBe(said);
    expect(local.transcribe).toHaveBeenCalledWith('C:/x.wav', 'srt', 'sk');
    expect(remote.transcribeFile).not.toHaveBeenCalled();
  });

  it('sends a small recording to the other computer as it is', async () => {
    const file = join(dir, 'note.m4a');
    writeFileSync(file, 'm4a-bytes');
    const remote = { transcribeFile: vi.fn(async () => said) };
    const shrink = vi.fn();
    await transcribeAnywhere(file, 'text', undefined, { local: localVoice(false), remote, shrink });
    expect(shrink).not.toHaveBeenCalled();
    expect(remote.transcribeFile).toHaveBeenCalledWith(Buffer.from('m4a-bytes'), 'm4a', 'text', undefined);
  });

  it('shrinks a video to its speech first, and cleans up after', async () => {
    const file = join(dir, 'reel.mp4');
    writeFileSync(file, 'video');
    let shrunk = '';
    const shrink = vi.fn(async (_in: string, out: string) => {
      shrunk = out;
      writeFileSync(out, 'opus');
    });
    const remote = { transcribeFile: vi.fn(async () => said) };
    await transcribeAnywhere(file, 'words', 'en', { local: localVoice(false), remote, shrink });
    expect(remote.transcribeFile).toHaveBeenCalledWith(Buffer.from('opus'), 'ogg', 'words', 'en');
    const { existsSync } = await import('node:fs');
    expect(existsSync(shrunk)).toBe(false);
  });

  it('says so when the file is missing', async () => {
    await expect(
      transcribeAnywhere(join(dir, 'nope.wav'), 'text', undefined, { local: localVoice(false), remote: { transcribeFile: vi.fn() } }),
    ).rejects.toThrow('No file at');
  });
});
