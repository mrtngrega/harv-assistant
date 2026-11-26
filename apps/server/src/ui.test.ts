import { describe, expect, it } from 'vitest';
import { cleanUi } from './ui.ts';

describe('dashboard layout (ui.json)', () => {
  it('keeps only well-formed parts', () => {
    const ui = cleanUi({
      activeId: 'abc',
      settingsOpen: 'yes',
      order: ['a', 'a', 'b', 5, '../x'],
      tools: { a: ['files', 'paint'], '../x': ['terminal'] },
      views: { a: 'files', b: 'nope' },
      explorer: { a: 'C:\\Users' },
      drafts: { a: 'half a thought', b: '' },
      attachments: { a: [{ id: 'f1', name: 'x.png', size: 3, mime: 'image/png' }, { id: 1 }] },
    });
    expect(ui).toEqual({
      activeId: 'abc',
      settingsOpen: false,
      order: ['a', 'b'],
      blanks: [],
      tools: { a: ['files'] },
      views: { a: 'files' },
      explorer: { a: 'C:\\Users' },
      drafts: { a: 'half a thought' },
      attachments: { a: [{ id: 'f1', name: 'x.png', size: 3, mime: 'image/png' }] },
    });
    expect(cleanUi(null).order).toEqual([]);
  });
});
