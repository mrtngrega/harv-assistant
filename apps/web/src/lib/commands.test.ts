import { describe, expect, it } from 'vitest';
import { parseCommand } from './commands.ts';

describe('dashboard commands', () => {
  it('switches the model and effort', () => {
    expect(parseCommand('/model opus max')).toEqual({ kind: 'model', model: 'opus', effort: 'max' });
    expect(parseCommand('/model auto')).toEqual({ kind: 'model', model: 'auto', effort: undefined });
    expect(parseCommand('/model med')).toEqual({ kind: 'model', model: undefined, effort: 'medium' });
    expect(parseCommand('/model gpt')).toMatchObject({ kind: 'error' });
  });

  it('handles /attach, /new and /help', () => {
    expect(parseCommand('/attach')).toEqual({ kind: 'attach' });
    expect(parseCommand(' /new ')).toEqual({ kind: 'new' });
    expect(parseCommand('/model')).toEqual({ kind: 'help' });
  });

  it('leaves normal messages and one-message overrides to the server', () => {
    expect(parseCommand('/opus fix this')).toBeNull();
    expect(parseCommand('/new idea for the app')).toBeNull();
    expect(parseCommand('hello')).toBeNull();
  });
});

describe('/plan and /rewind', () => {
  it('toggles or sets plan mode, and leaves sentences alone', () => {
    expect(parseCommand('/plan')).toEqual({ kind: 'plan' });
    expect(parseCommand('/plan on')).toEqual({ kind: 'plan', on: true });
    expect(parseCommand('/plan OFF')).toEqual({ kind: 'plan', on: false });
    expect(parseCommand('/plan the next release')).toBeNull();
    expect(parseCommand('/rewind')).toEqual({ kind: 'rewind' });
    expect(parseCommand('/rewind to yesterday')).toBeNull();
  });
});
