import { describe, expect, it } from 'vitest';
import { dayNote } from './options.ts';

// The full review, K19: a session's "Today is …" was set once and went stale past midnight.
describe('the new day in a long chat', () => {
  it('says the new date once when the day moved on, and nothing on the same day or with no session', () => {
    const session = { promptDay: 'Monday, 16 November 2026' };
    expect(dayNote(undefined, false, 'Tuesday, 17 November 2026')).toBe('');
    expect(dayNote({ promptDay: 'Tuesday, 17 November 2026' }, false, 'Tuesday, 17 November 2026')).toBe('');
    expect(dayNote(session, false, 'Tuesday, 17 November 2026')).toContain('It is now Tuesday, 17 November 2026');
    expect(dayNote(session, false, 'Tuesday, 17 November 2026')).toBe('');
  });

  it('stays quiet on a spoken turn (it has the clock), but still moves the day on', () => {
    const session = { promptDay: 'Monday, 16 November 2026' };
    expect(dayNote(session, true, 'Tuesday, 17 November 2026')).toBe('');
    expect(session.promptDay).toBe('Tuesday, 17 November 2026');
  });
});
