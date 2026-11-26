import type { BackgroundTask } from '@harv/shared';
import { describe, expect, it } from 'vitest';
import { SHOWN_MS, stillShown } from './TaskStrip.tsx';

const task = (status: BackgroundTask['status'], endedAt?: number) =>
  ({ id: 'a', kind: 'local_bash', description: 'x', startedAt: 0, status, endedAt }) as BackgroundTask;

describe('the task strip', () => {
  it('lets ended tasks go by its own clock, failures later', () => {
    expect(stillShown(task('running'), 10 ** 9)).toBe(true);
    expect(stillShown(task('completed', 1000), 1000 + SHOWN_MS.completed - 1)).toBe(true);
    expect(stillShown(task('completed', 1000), 1000 + SHOWN_MS.completed)).toBe(false);
    expect(stillShown(task('stopped', 1000), 1000 + 61_000)).toBe(false);
    expect(stillShown(task('failed', 1000), 1000 + 61_000)).toBe(true);
    expect(stillShown(task('failed', 1000), 1000 + SHOWN_MS.failed)).toBe(false);
  });
});
