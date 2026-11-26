import { describe, expect, it } from 'vitest';
import { terminalTabOf } from './tools.ts';

describe("a chat's own terminal tab (report note, 2026-11-19)", () => {
  it('is a fixed tab next to the chat, and a terminal tab is its own', () => {
    expect(terminalTabOf('abc')).toBe('abc-terminal');
    expect(terminalTabOf('abc-terminal')).toBe('abc-terminal');
  });
});
