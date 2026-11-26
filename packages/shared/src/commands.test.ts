import { describe, expect, it } from 'vitest';
import { nearestCommand, slashWord, unknownCommand, unknownCommandText } from './commands.ts';

const known = ['compact', 'context', 'init', 'code-review', 'deslop', 'ui-check', 'impeccable', 'superpowers:brainstorm', 'resolve'];

describe('a mistyped /word (the user’s rule, 2026-11-09)', () => {
  it('catches a slash word that nothing knows, and offers the nearest command', () => {
    expect(unknownCommand('/reprot the explorer is slow', known)).toEqual({ name: 'reprot', suggestion: 'report' });
    expect(unknownCommand('/deslpo', known)).toEqual({ name: 'deslpo', suggestion: 'deslop' });
    expect(unknownCommand('/rep', known)).toEqual({ name: 'rep', suggestion: 'report' });
    expect(unknownCommand('/brainstorm', known)?.suggestion).toBe('superpowers:brainstorm');
    // Nothing close: no guess.
    expect(unknownCommand('/maybe lets use some skills', known)).toEqual({ name: 'maybe' });
  });

  it('lets real commands, skills, models, efforts and plain messages through', () => {
    for (const text of [
      '/report the explorer is slow',
      '/compact',
      '/Code-Review',
      '/superpowers:brainstorm',
      '/opus fix it',
      '/max',
      '/med go on',
      '/btw what is that',
      '/model sonnet',
      'hello /maybe',
      '/c/Users/me/file.txt',
      '/tmp/x is full',
      '',
    ])
      expect(unknownCommand(text, known)).toBeNull();
  });

  it('judges nothing before the command list is known', () => {
    expect(unknownCommand('/whatever', [])).toBeNull();
  });

  it('says what happened and what to do, in one line', () => {
    expect(unknownCommandText({ name: 'reprot', suggestion: 'report' })).toBe(
      'There’s no /reprot command, so nothing was sent. Did you mean /report? To send it as a plain message, take the slash off.',
    );
    expect(unknownCommandText({ name: 'maybe' })).toContain('Type / to see the commands.');
    expect(slashWord('/a:b-c.d rest')).toBe('a:b-c.d');
    expect(nearestCommand('x', known)).toBeUndefined();
  });
});
