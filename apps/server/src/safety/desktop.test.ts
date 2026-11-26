import { describe, expect, it } from 'vitest';
import {
  actsOnDesktop,
  askedForRisk,
  classifyDesktop,
  contains,
  DESKTOP_TOOLS,
  desktopRisk,
  elementAt,
  monitorLabel,
  namesAMonitor,
  parseSnapshot,
  pointsOf,
  responseText,
  workArea,
} from './desktop.ts';
import { COMMITS, SENDS } from './browser.ts';

// Audit S1 (2026-11-10): `\b` is ASCII-only, so Slovak buttons never counted as committing.
describe('buttons that commit, in English and Slovak', () => {
  it.each([
    'Kúpiť',
    'Kúpiť teraz',
    'Zaplatiť',
    'Objednať',
    'Zmazať',
    'Potvrdiť',
    'Poslať',
    'Odoslať',
    'Zdieľať',
    'zmazat',
    'Send',
    'Buy now',
    'Delete message',
  ])('commits: %s', (label) => expect(COMMITS.test(label)).toBe(true));
  it.each(['Poslať', 'Odoslať', 'Zdieľať', 'odosli', 'Send', 'Reply'])('sends: %s', (label) => expect(SENDS.test(label)).toBe(true));
  it.each(['Sendvič', 'Prepay info', 'Zmazaťko', 'Reorder list', 'Apple', 'Booking.com'])('not a commit: %s', (label) =>
    expect(COMMITS.test(label)).toBe(false),
  );
  it('sees a Slovak Buy button in a snapshot as buying', () => {
    const els = parseSnapshot(['window "Obchod"', '└── (10,10) button "Kúpiť teraz"  [action: click]'].join('\n'));
    expect(desktopRisk('mcp__desktop__Click', { label: 0 }, els)?.kind).toBe('buy');
  });
});
import { classify, isSending } from './classify.ts';

const d = (name: string) => `mcp__desktop__${name}`;
const tier = (name: string, input: Record<string, unknown> = {}) => classifyDesktop(d(name), input).tier;

describe('desktop control (Windows-MCP)', () => {
  it('lets looking at the screen through without asking', () => {
    for (const name of ['Snapshot', 'Screenshot', 'DisplayInventory', 'Wait', 'WaitFor', 'ControlStatus']) expect(tier(name)).toBe('green');
    expect(tier('Clipboard', { mode: 'get' })).toBe('green');
    // Plan mode lets connector reads through by this reason.
    expect(classifyDesktop(d('Snapshot'), {}).reason.startsWith('Only reads')).toBe(true);
  });

  it('treats the mouse, the keyboard and switching windows as acting', () => {
    for (const name of ['Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'MultiSelect', 'MultiEdit']) {
      expect(tier(name, { text: 'x', shortcut: 'ctrl+c' })).toBe('red');
      expect(actsOnDesktop(d(name), {})).toBe(true);
    }
    expect(tier('Clipboard', { mode: 'set', text: 'hi' })).toBe('red');
    expect(tier('App', { mode: 'switch', name: 'Discord' })).toBe('red');
    expect(tier('App', { name: 'Notepad' })).toBe('red');
    expect(actsOnDesktop(d('Snapshot'), {})).toBe(false);
  });

  it('blocks running a program by path and any tool Harv never enabled', () => {
    expect(tier('App', { mode: 'launch_executable', executable: 'C:\\x\\evil.exe' })).toBe('blocked');
    for (const name of ['PowerShell', 'FileSystem', 'Registry', 'Process', 'Scrape', 'SomethingNew']) expect(tier(name)).toBe('blocked');
    expect(actsOnDesktop(d('PowerShell'), {})).toBe(false);
  });

  it('only starts tools it knows how to judge', () => {
    for (const name of DESKTOP_TOOLS) expect(tier(name, { mode: 'get' })).not.toBe('blocked');
  });

  it('says what it will do in plain words', () => {
    expect(classifyDesktop(d('Click'), { label: 12 }).summary).toBe('click element #12 from the last snapshot');
    expect(classifyDesktop(d('Click'), { loc: [10, 20], button: 'right', clicks: 2 }).summary).toBe('right-click (10, 20) ×2');
    expect(classifyDesktop(d('Type'), { text: 'hello', label: 3, press_enter: true }).summary).toBe(
      'type “hello” into element #3 from the last snapshot and press Enter',
    );
    expect(classifyDesktop(d('Shortcut'), { shortcut: 'ctrl+v' }).summary).toBe('press ctrl+v');
    expect(classifyDesktop(d('App'), { mode: 'switch', name: 'Discord' }).summary).toBe('switch to Discord');
  });

  it('goes through classify, and never counts as sending (it has its own card)', () => {
    expect(classify(d('Click'), { label: 1 }).tier).toBe('red');
    expect(classify(d('Snapshot'), {}).tier).toBe('green');
    expect(isSending(d('Notification'), {})).toBe(false);
    expect(isSending(d('Type'), { text: 'send it' })).toBe(false);
  });

  // The Bluetooth chat (2026-11-10): opening the Sound window by its path was a dead end.
  it('runs a program by path when the same command would, and points the rest to PowerShell', () => {
    const launch = (executable: string, args?: string[]) => classify(d('App'), { mode: 'launch_executable', executable, args });
    expect(launch('control.exe', ['mmsys.cpl']).tier).toBe('green');
    expect(launch('notepad.exe').tier).toBe('green');
    const other = launch('C:\\x\\tool.exe');
    expect(other).toMatchObject({ tier: 'blocked', route: true });
    expect(other.reason).toMatch(/PowerShell tool/);
    const wipe = launch('format.com', ['D:']);
    expect(wipe.tier).toBe('blocked');
    expect(wipe.route).toBeUndefined();
    expect(actsOnDesktop(d('App'), { mode: 'launch_executable', executable: 'control.exe' })).toBe(false);
  });
});

describe('monitors', () => {
  // The user's PC: a big main monitor on the left, a smaller one on the right, a bit lower.
  const left = { device: 'D1', primary: true, left: 0, top: 0, right: 2560, bottom: 1440 };
  const right = { device: 'D2', primary: false, left: 2560, top: 147, right: 4480, bottom: 1227 };
  const both = [left, right];

  it('names monitors the way the user would', () => {
    expect(monitorLabel(left, both)).toBe('left · main');
    expect(monitorLabel(right, both)).toBe('right');
    expect(monitorLabel(left, [left])).toBe('your monitor');
  });

  it('works on the smallest monitor unless the user picked one', () => {
    expect(workArea(both)).toMatchObject({ device: 'D2', label: 'right', region: [2560, 147, 4480, 1227], count: 2 });
    expect(workArea(both, 'D1')?.device).toBe('D1');
    expect(workArea(both, 'gone')?.device).toBe('D2');
    expect(workArea([])).toBeNull();
  });

  it('finds every point an action lands on', () => {
    expect(pointsOf({ loc: [10, 20] })).toEqual([[10, 20]]);
    expect(pointsOf({ loc: '[3000, 400]', from_loc: '5,6' })).toEqual([
      [3000, 400],
      [5, 6],
    ]);
    expect(pointsOf({ locs: '[[1,2],[3,4]]' })).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(pointsOf({ mode: 'resize', window_loc: [100, 100] })).toEqual([[100, 100]]);
    expect(pointsOf({ label: 7 })).toEqual([]);
    expect(contains(right, [3000, 400])).toBe(true);
    expect(contains(right, [100, 100])).toBe(false);
  });

  it('notices when the user names a monitor (English and Slovak), not a left click', () => {
    for (const said of [
      'do it on the left monitor',
      'use the main screen',
      'both displays',
      'on monitor 1',
      'na ľavom monitore',
      'na hlavnej obrazovke',
    ])
      expect(namesAMonitor(said)).toBe(true);
    for (const said of ['left click the button', 'what is on my screen?', 'open Discord', 'take a screenshot'])
      expect(namesAMonitor(said)).toBe(false);
  });
});

describe('what a desktop action hits (risky only, the user’s rule 2026-11-09)', () => {
  const snapshot = [
    'Interactive elements:',
    'window "Discord"',
    '├── (812,940) button "Send"  [action: click]',
    '├── (600,940) edit "Message #general"  [action: type]',
    '└── (950,300) button "Delete "old" message"  [action: click]  [state:on]',
    '',
    'window "Steam"',
    '├── (100,100) button "Purchase"  [action: click]',
    '├── (200,100) edit "Search the store"  [action: type]',
    '└── (300,100) edit "Card number"  [action: type]',
  ].join('\n');
  const els = parseSnapshot(snapshot);
  const risk = (name: string, input: Record<string, unknown>) => desktopRisk(d(name), input, els);

  it('reads Windows-MCP 0.8.8 snapshots in label order, from any result shape', () => {
    expect(els.map((e) => [e.name, e.window])).toEqual([
      ['Send', 'Discord'],
      ['Message #general', 'Discord'],
      ['Delete "old" message', 'Discord'],
      ['Purchase', 'Steam'],
      ['Search the store', 'Steam'],
      ['Card number', 'Steam'],
    ]);
    expect(responseText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\n\nb');
    expect(responseText({ content: [{ type: 'text', text: 'x' }] })).toBe('x');
    expect(elementAt({ loc: [814, 938] }, els)?.name).toBe('Send');
    expect(elementAt({ loc: '812,960' }, els)).toBeUndefined();
  });

  it('reads the real shape: a JSON list of strings, an indented tree, scrollables last', () => {
    const real = JSON.stringify([
      '\n    Cursor Position: None\n    UI Tree:\n    desktop\n    ├── window ""\n    │   ├── (3212,1203) button "Start"  [action: click]  [toggle:off]\n' +
        '    │   └── (3300,600) list "Feed"  [action: scroll]  [v:10%]\n    └── window "Discord"\n        ├── pane "Chat"\n' +
        '        │   └── (812,940) button "Send"  [action: click]\n',
    ]);
    expect(parseSnapshot(responseText([{ type: 'text', text: real }])).map((e) => [e.name, e.window, e.type])).toEqual([
      ['Start', '', 'button'],
      ['Send', 'Discord', 'button'],
      ['Feed', '', 'list'],
    ]);
    expect(parseSnapshot('not a snapshot [x')).toEqual([]);
  });

  it('flags sending, buying, deleting and secret fields, nothing else', () => {
    expect(risk('Click', { label: 0 })?.kind).toBe('send');
    expect(risk('Click', { loc: [950, 300] })?.kind).toBe('delete');
    expect(risk('Click', { label: 3 })?.kind).toBe('buy');
    expect(risk('Click', { label: 0, clicks: 0 })).toBeNull(); // hover
    expect(risk('Click', { label: 1 })).toBeNull();
    expect(risk('Click', { loc: [5, 5] })).toBeNull(); // nothing known there
    expect(risk('Type', { text: 'hi', label: 1 })).toBeNull();
    expect(risk('Type', { text: 'hi', label: 1, press_enter: true })?.kind).toBe('send');
    expect(risk('Type', { text: 'hi', loc: [5, 5], press_enter: true })?.kind).toBe('send');
    expect(risk('Type', { text: 'portal', label: 4, press_enter: true })).toBeNull();
    expect(risk('Type', { text: '4111', label: 5 })?.kind).toBe('secret');
    expect(risk('MultiEdit', { locs: [[300, 100]] })?.kind).toBe('secret');
    expect(risk('Shortcut', { shortcut: 'ctrl+enter' })?.kind).toBe('send');
    expect(risk('Shortcut', { shortcut: 'Enter' })?.kind).toBe('send');
    expect(risk('Shortcut', { shortcut: 'shift+delete' })?.kind).toBe('delete');
    expect(risk('Shortcut', { shortcut: 'ctrl+c' })).toBeNull();
    expect(risk('Scroll', { loc: [812, 940] })).toBeNull();
    expect(risk('App', { mode: 'launch', name: 'Discord' })).toBeNull();
  });

  it('counts only the user asking for that kind outright', () => {
    const send = risk('Click', { label: 0 })!;
    expect(askedForRisk(send, 'send Peter a hi on Discord')).toBe(true);
    expect(askedForRisk(send, 'pošli mu ahoj')).toBe(true);
    expect(askedForRisk(send, 'napíš mu že prídem')).toBe(true);
    for (const m of ['what does Discord show?', 'tell me the last message', 'napíš mi zhrnutie', 'open Discord'])
      expect(askedForRisk(send, m)).toBe(false);
    const del = risk('Click', { label: 2 })!;
    expect(askedForRisk(del, 'send Peter a hi')).toBe(false);
    expect(askedForRisk(del, 'zmaž tú starú správu')).toBe(true);
    expect(askedForRisk(risk('Type', { text: '4111', label: 5 })!, 'buy it')).toBe(false);
  });
});
