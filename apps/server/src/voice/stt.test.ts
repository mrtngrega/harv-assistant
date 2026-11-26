import { describe, expect, it } from 'vitest';
import { keepLoaded, placement } from './stt.ts';

describe('where Whisper runs (voice plan V1a: the 8 GB rule)', () => {
  it('uses the graphics card only in memory that is really free', () => {
    expect(placement(6000, false, true)).toEqual({ device: 'cuda', compute: 'float16' });
    expect(placement(3000, false, true)).toEqual({ device: 'cuda', compute: 'int8_float16' });
    expect(placement(1500, false, true)).toEqual({ device: 'cpu', compute: 'int8' });
  });

  it('stays on the CPU beside a game or Resolve, without an NVIDIA card, and on Linux', () => {
    expect(placement(7000, true, true)).toEqual({ device: 'cpu', compute: 'int8' });
    expect(placement(null, false, true)).toEqual({ device: 'cpu', compute: 'int8' });
    expect(placement(7000, false, false)).toEqual({ device: 'cpu', compute: 'int8' });
  });

  // The full review, K1: with ~5–6 GB free before loading, each clip flipped float16 ↔ int8 and reloaded.
  it('keeps Whisper as loaded on the GPU, whatever the free memory says now, unless the GPU got busy', () => {
    const fp16 = { device: 'cuda', compute: 'float16' } as const;
    const int8 = { device: 'cuda', compute: 'int8_float16' } as const;
    const cpu = { device: 'cpu', compute: 'int8' } as const;
    expect(keepLoaded(fp16, int8, false)).toEqual(fp16);
    expect(keepLoaded(fp16, cpu, false)).toEqual(fp16);
    expect(keepLoaded(fp16, cpu, true)).toEqual(cpu);
    expect(keepLoaded(null, int8, false)).toEqual(int8);
    expect(keepLoaded(cpu, fp16, false)).toEqual(fp16);
  });
});
