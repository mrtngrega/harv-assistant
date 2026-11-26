import { describe, expect, it } from 'vitest';
import { osPath } from '../platform.ts';
import { syncedTwin } from './files.ts';

describe('syncedTwin', () => {
  const ws = osPath.join(osPath.sep === '\\' ? 'C:\\h' : '/h', 'workspace');

  it("maps the PC's workspace path to this computer's synced copy", () => {
    expect(syncedTwin('C:\\Users\\m\\.harv\\workspace\\photo-grade\\a.jpg', ws)).toBe(osPath.join(ws, 'photo-grade', 'a.jpg'));
  });

  it("maps the notebook's workspace path too", () => {
    expect(syncedTwin('/home/u/.harv/workspace/images/b.png', ws)).toBe(osPath.join(ws, 'images', 'b.png'));
  });

  it('refuses paths outside a Harv workspace or climbing out of it', () => {
    expect(syncedTwin('C:\\Users\\m\\Pictures\\a.jpg', ws)).toBeNull();
    expect(syncedTwin('/home/u/.harv/workspace/../sync.key', ws)).toBeNull();
    expect(syncedTwin('/home/u/.harv/workspace/', ws)).toBeNull();
    expect(syncedTwin(42, ws)).toBeNull();
  });
});
