import { describe, expect, it } from 'vitest';
import { moonOf, presenceState } from './presence.ts';

describe('which moon a tool belongs to', () => {
  it('sorts the tools onto their moons', () => {
    expect(moonOf('remember')).toBe('memory');
    expect(moonOf('read_chat')).toBe('memory');
    expect(moonOf('Read', 'C:\\Users\\x\\.harv\\memory\\pc-setup.md')).toBe('memory');
    expect(moonOf('Read', 'apps/web/src/App.tsx')).toBe('files');
    expect(moonOf('Grep')).toBe('files');
    expect(moonOf('Bash')).toBe('shell');
    expect(moonOf('terminal_run')).toBe('shell');
    expect(moonOf('WebFetch')).toBe('web');
    expect(moonOf('browser_click')).toBe('web');
    expect(moonOf('mcp__claude_ai_Gmail__search')).toBe('web');
    expect(moonOf('Agent')).toBe('helpers');
    expect(moonOf('hand_off')).toBe('helpers');
    expect(moonOf('desktop')).toBe('desktop');
  });

  it('leaves tools without a moon to the core', () => {
    for (const name of ['lights_set', 'schedule_task', 'phone_notify', 'Skill', 'ToolSearch', 'set_model', 'AskUserQuestion'])
      expect(moonOf(name)).toBeNull();
  });
});

describe('Harv’s state in a chat', () => {
  const base = { busy: false, toolRan: false, waiting: false, driving: false, asleep: false };
  it('thinks, then works', () => {
    expect(presenceState(base)).toBe('idle');
    expect(presenceState({ ...base, busy: true })).toBe('thinking');
    expect(presenceState({ ...base, busy: true, toolRan: true })).toBe('working');
    expect(presenceState({ ...base, busy: true, toolRan: true, driving: true })).toBe('desktop');
  });
  it('puts a yes the user owes first, then the limit', () => {
    expect(presenceState({ ...base, busy: true, waiting: true, asleep: true })).toBe('waiting');
    expect(presenceState({ ...base, waiting: true })).toBe('waiting');
    expect(presenceState({ ...base, busy: true, asleep: true })).toBe('asleep');
  });
});
