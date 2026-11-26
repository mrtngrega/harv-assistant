import { describe, expect, it } from 'vitest';
import { ChatStore } from '../store/chats.ts';
import { carryTranscript, chatList, findTab, formatTranscript, recentChatsContext } from './chatTools.ts';

describe('chat tools', () => {
  it('lists chats with their state and marks this one', () => {
    const at = new Date(2026, 9, 22).getTime();
    const list = chatList(
      [
        { id: 'a', title: 'Weather', updatedAt: at, open: true },
        { id: 'b', title: 'Old one', updatedAt: at, open: false, snippet: '…rain…' },
      ],
      'a',
    );
    expect(list).toBe('- a · "Weather" · 22 Oct 2026 · open tab · this chat\n- b · "Old one" · 22 Oct 2026 · closed\n  match: …rain…');
  });

  it('formats a transcript and keeps the newest lines when it is long', () => {
    expect(
      formatTranscript([
        { kind: 'you', text: 'look', files: ['shot.png'] },
        { kind: 'tool', text: 'Read · a.txt' },
        { kind: 'harv', text: 'Done.' },
      ]),
    ).toBe('user: look [attached: shot.png]\n  tool: Read · a.txt\nharv: Done.');

    const long = Array.from({ length: 40 }, (_, i) => ({ kind: 'harv' as const, text: `${i} ${'x'.repeat(1990)}` }));
    const out = formatTranscript(long);
    expect(out.startsWith('(…earlier lines left out)')).toBe(true);
    expect(out.endsWith(`39 ${'x'.repeat(1990)}`)).toBe(true);
    expect(out.length).toBeLessThan(17_000);
  });

  it('leaves the current chat out of the recent list', () => {
    const store = new ChatStore(':memory:');
    store.ensureChat('a', 'This one');
    store.addLine('a', { kind: 'you', text: 'hi' });
    store.ensureChat('b', 'Other one');
    store.addLine('b', { kind: 'you', text: 'hi' });
    const context = recentChatsContext(store, 'a');
    expect(context).toContain('"Other one"');
    expect(context).not.toContain('"This one"');
    store.close();
  });

  it('shows each chat’s summary under it, and finds a chat by its summary (§6c)', () => {
    const store = new ChatStore(':memory:');
    store.ensureChat('a', 'This one');
    store.addLine('a', { kind: 'you', text: 'hi' });
    store.ensureChat('b', 'Corolla');
    store.addLine('b', { kind: 'you', text: 'hi' });
    store.setSummary('b', 'Picked winter tyres for the Corolla; ordering them is left.');
    expect(recentChatsContext(store, 'a')).toContain('"Corolla" · ');
    expect(recentChatsContext(store, 'a')).toContain('\n  about: Picked winter tyres for the Corolla; ordering them is left.');
    expect(store.history('tyres').map((c) => c.id)).toEqual(['b']);
    store.close();
  });
});

describe("another chat's terminal (the user's wish: a terminal tab every chat can work in)", () => {
  const tabs = [
    { id: 'aaaaaaaa-1111', title: 'School Java', terminal: false },
    { id: 'bbbbbbbb-2222', title: 'Server', terminal: true },
    { id: 'cccccccc-3333', title: 'New chat', terminal: false },
  ];
  const id = (r: ReturnType<typeof findTab>) => (typeof r === 'string' ? r : r.id);

  it('finds it by title, part of the title or id', () => {
    expect(id(findTab('server', tabs, 'aaaaaaaa-1111'))).toBe('bbbbbbbb-2222');
    expect(id(findTab('School', tabs, 'bbbbbbbb-2222'))).toBe('aaaaaaaa-1111');
    expect(id(findTab('cccccccc', tabs, 'aaaaaaaa-1111'))).toBe('cccccccc-3333');
  });

  it('"the terminal tab" is the only other chat showing its terminal', () => {
    expect(id(findTab('the terminal tab', tabs, 'aaaaaaaa-1111'))).toBe('bbbbbbbb-2222');
    // From the chat that shows it, there's no other one.
    expect(findTab('terminal', tabs, 'bbbbbbbb-2222')).toMatch(/No single open chat/);
  });

  it('never picks the asking chat by name (it may be titled "Terminal test")', () => {
    const withSelf = [...tabs, { id: 'eeeeeeee-5555', title: 'Terminal echo test', terminal: false }];
    expect(id(findTab('terminal', withSelf, 'eeeeeeee-5555'))).toBe('bbbbbbbb-2222');
  });

  it('asks instead of guessing when it is unclear', () => {
    const two = [...tabs, { id: 'dddddddd-4444', title: 'Server logs', terminal: true }];
    const r = findTab('serv', two, 'aaaaaaaa-1111');
    expect(r).toMatch(/No single open chat matches "serv"/);
    expect(r).toContain('"Server logs" (dddddddd-4444) · terminal open');
  });
});

describe('carrying a chat into a new session (the ShopNotes chat forgot its spec, 2026-11-10)', () => {
  it('keeps the first message and long specs from before the last 30 lines', () => {
    const spec = `Spec: ${'build the service history screen with filters. '.repeat(20)}`;
    const lines = [
      { kind: 'you' as const, text: 'Start the ShopNotes app', at: 1 },
      { kind: 'harv' as const, text: 'Started.', at: 2 },
      { kind: 'you' as const, text: spec, at: 3 },
      ...Array.from({ length: 40 }, (_, i) => ({ kind: (i % 2 ? 'harv' : 'you') as 'harv' | 'you', text: `line ${i}`, at: 10 + i })),
    ];
    const out = carryTranscript(lines);
    expect(out).toContain('The user (first message): Start the ShopNotes app');
    expect(out).toContain('Spec: build the service history screen');
    expect(out).toContain('line 39');
    expect(out).not.toContain('line 5\n');
    expect(out.length).toBeLessThanOrEqual(16_100);
  });

  it('is just the transcript for a short chat', () => {
    const lines = [{ kind: 'you' as const, text: 'hi', at: 1 }];
    expect(carryTranscript(lines)).toBe(formatTranscript(lines));
  });
});
