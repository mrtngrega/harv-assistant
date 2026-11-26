import { describe, expect, it } from 'vitest';
import { GpuBusy } from './gpuBusy.ts';

// The full review, K2: "never beside a game or Resolve" was written as built, but nothing set it.
describe('when the graphics card counts as busy (Whisper stays on the CPU)', () => {
  it('while Resolve runs', () => {
    const g = new GpuBusy();
    g.processes([{ name: 'explorer.exe' }, { name: 'Resolve.exe' }]);
    expect(g.busy()).toBe(true);
    g.processes([{ name: 'explorer.exe' }]);
    expect(g.busy()).toBe(false);
  });

  it('after five hard seconds in a row, not after a short spike (a clip of its own)', () => {
    const g = new GpuBusy();
    for (const load of [90, 95, 10, 80, 85]) g.tick(load);
    expect(g.busy()).toBe(false);
    for (const load of [70, 90, 99, 88, 75]) g.tick(load);
    expect(g.busy()).toBe(true);
    g.tick(undefined);
    expect(g.busy()).toBe(false);
  });
});
