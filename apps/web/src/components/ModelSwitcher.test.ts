import { describe, expect, it } from 'vitest';
import { nearestEffort } from './ModelSwitcher.tsx';

// Switching to a model without the current effort left no effort lit (the full review, U18).
describe('nearestEffort', () => {
  it('keeps an effort the model has, or when it lists none', () => {
    expect(nearestEffort('high', ['low', 'medium', 'high'])).toBe('high');
    expect(nearestEffort('max', [])).toBe('max');
  });

  it('takes the highest one below, else the model’s lowest', () => {
    expect(nearestEffort('max', ['low', 'medium', 'high'])).toBe('high');
    expect(nearestEffort('xhigh', ['medium', 'low'])).toBe('medium');
    expect(nearestEffort('low', ['medium', 'high'])).toBe('medium');
  });
});
