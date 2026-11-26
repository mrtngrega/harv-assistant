import type { ActionEntry } from '@harv/shared';
import { describe, expect, it } from 'vitest';
import type { Line } from './chatStore.ts';
import { activityOf, groupLines, plainTool } from './turns.ts';

let n = 0;
const L = (kind: Line['kind'], text: string, extra: Partial<Line> = {}): Line => ({ id: `l${++n}`, kind, text, at: n * 1000, ...extra });
const none = () => undefined;

describe('groupLines', () => {
  it('folds a finished turn’s steps into one row and shows one header per reply', () => {
    const lines = [
      L('you', 'fix it'),
      L('thinking', '…', { tag: '6s' }),
      L('harv', 'On it.', { tag: 'sonnet·high' }),
      L('tool', 'Bash · ls'),
      L('thinking', '…', { tag: '1s' }),
      L('harv', 'Done.', { tag: 'sonnet·high' }),
    ];
    const shown = groupLines(lines, false, none);
    expect(shown.map((s) => (s.kind === 'steps' ? `steps:${s.lines.length}` : `${s.line.kind}:${s.head}`))).toEqual([
      'you:true',
      'steps:2',
      'harv:true',
      'harv:false',
    ]);
  });

  it('keeps the running turn as it is, and a new tag (a step-up) gets its header', () => {
    const lines = [L('you', 'go'), L('harv', 'a', { tag: 'sonnet·high' }), L('tool', 'Read · x'), L('harv', 'b', { tag: 'opus·medium' })];
    const shown = groupLines(lines, true, none);
    expect(shown.map((s) => (s.kind === 'line' ? `${s.line.kind}:${s.head}` : 'steps'))).toEqual([
      'you:true',
      'harv:true',
      'tool:true',
      'harv:true',
    ]);
  });

  it('leaves held, failed and undoable steps out of the fold, and hides ToolSearch', () => {
    const held = { status: 'blocked', canUndo: false } as ActionEntry;
    const lines = [L('you', 'x'), L('tool', 'ToolSearch'), L('tool', 'Bash · rm a', { ref: 'h' }), L('tool', 'Read · b'), L('harv', 'ok')];
    const shown = groupLines(lines, false, (ref) => (ref === 'h' ? held : undefined));
    expect(shown.map((s) => (s.kind === 'line' ? s.line.text : `steps:${s.lines.length}`))).toEqual(['x', 'Bash · rm a', 'steps:1', 'ok']);
  });
});

describe('plainTool', () => {
  it('uses the description of a command, else plain verbs', () => {
    expect(plainTool('Bash · curl -o a.jpg x', { summary: 'Download the cover image' } as ActionEntry)).toBe('Download the cover image');
    expect(plainTool('Bash · ls -la', { summary: 'ls -la' } as ActionEntry)).toBe('ran a command');
    expect(plainTool('Read · C:\\a\\app.py')).toBe('read app.py');
    expect(plainTool('WebSearch · weather api')).toBe('searched the web for weather api');
    expect(plainTool('desktop · open Calculator')).toBe('desktop · open Calculator');
  });
});

describe('activityOf', () => {
  it('puts tool names in plain words for the status line and the pill', () => {
    expect(activityOf('Bash')).toBe('running a command');
    expect(activityOf('Read')).toBe('reading');
    expect(activityOf('mcp__claude_ai_Gmail__search_threads')).toBe('Gmail: search threads');
    expect(activityOf('mcp__harv__lights_set')).toBe('lights set');
    expect(activityOf('mcp__desktop__Click')).toBe('desktop: Click');
    expect(activityOf('Something')).toBe('Something');
  });
});
