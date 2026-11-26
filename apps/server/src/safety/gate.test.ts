import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SafetyServerMessage } from '@harv/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'harv-gate-'));
vi.stubEnv('HARV_HOME', home);
// A small backup cap, so "too big to back up" (the full review, S4) needs only a few files here.
vi.stubEnv('HARV_MAX_BACKUP_FILES', '40');
// The test folders sit in the real temp folder; this one stands in for it, so they aren't scratch space.
vi.stubEnv('HARV_TEMP', mkdtempSync(join(tmpdir(), 'harv-gate-scratch-')));
// The outright-request check is a Haiku call: here a message counts as asking outright when it says "outright".
// The reply check uses its quick rules only; what would go to Haiku is "unclear" (no model calls in tests).
vi.mock('./judge.ts', async (orig) => {
  const real = await orig<typeof import('./judge.ts')>();
  return {
    ...real,
    askedOutright: vi.fn(async (message: string) => /outright/i.test(message)),
    judgeReply: vi.fn(
      async (reply: string, _held: unknown, _harvSaid?: string, fresh = true) =>
        (fresh ? real.readReply(reply) : null) ?? { kind: 'unclear' as const },
    ),
  };
});
const { SafetyGate } = await import('./gate.ts');
const { createBackup, restoreBackup } = await import('./backup.ts');
const { ActionStore } = await import('../store/actions.ts');

const userDir = mkdtempSync(join(tmpdir(), 'harv-user-'));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

function setup() {
  const store = new ActionStore(':memory:');
  const sent: SafetyServerMessage[] = [];
  const notices: string[] = [];
  const gate = new SafetyGate(store, { broadcast: (m) => sent.push(m), notice: (_t, m) => notices.push(m), onChange: () => {} });
  return { store, gate, sent, notices };
}

const signal = () => new AbortController().signal;
/** These tests are about the approval cards, so "Ask before risky actions" is on unless a test says otherwise. */
const writeSettings = (extra: Record<string, unknown> = {}) =>
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ askRisky: true, ...extra }));
const decision = (out: unknown) =>
  (
    out as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> };
    }
  ).hookSpecificOutput;

describe('backups', () => {
  it('restores a changed file and keeps the newer version aside', async () => {
    const file = join(userDir, 'a.txt');
    writeFileSync(file, 'original');
    const backup = await createBackup('tool_1', [file]);
    writeFileSync(file, 'changed');
    restoreBackup(backup);
    expect(readFileSync(file, 'utf8')).toBe('original');
  });

  it('undoes a newly created file by moving it aside', async () => {
    const file = join(userDir, 'new.txt');
    const backup = await createBackup('tool_2', [file]);
    writeFileSync(file, 'created');
    restoreBackup(backup);
    expect(existsSync(file)).toBe(false);
  });
});

describe('SafetyGate', () => {
  beforeEach(() => writeSettings());

  it('deletes inside a folder the user attached to that chat without a card, backed up first', async () => {
    const store = new ActionStore(':memory:');
    const sent: SafetyServerMessage[] = [];
    const given = mkdtempSync(join(userDir, 'given-'));
    const file = join(given, 'old.txt');
    writeFileSync(file, 'keep a copy');
    const gate = new SafetyGate(store, {
      broadcast: (m) => sent.push(m),
      notice: () => {},
      onChange: () => {},
      attachedOf: (tabId) => (tabId === 'tab' ? [given] : []),
    });
    const out = await gate.preToolUse('tab', 'PowerShell', { command: `Remove-Item "${file}"` }, 'att1', signal());
    expect(decision(out)?.permissionDecision).toBe('allow');
    expect(store.get('att1')?.tier).toBe('yellow');
    expect(store.get('att1')?.backups).toContain(file);
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
    // Another chat didn't get the folder: there it is an ordinary delete (red: backed up, logged, runs).
    await gate.preToolUse('other', 'PowerShell', { command: `Remove-Item "${file}"` }, 'att2', signal());
    expect(store.get('att2')?.tier).toBe('red');
  });

  it('lets green calls through and logs them quietly', async () => {
    const { gate, store, sent } = setup();
    const out = await gate.preToolUse('tab', 'Read', { file_path: 'C:\\x.txt' }, 't1', signal());
    expect(decision(out)?.permissionDecision).toBe('allow');
    expect(store.get('t1')?.tier).toBe('green');
    expect(sent).toEqual([]);
  });

  it('blocks with a reason', async () => {
    const { gate, store } = setup();
    const out = await gate.preToolUse('tab', 'PowerShell', { command: 'format D:' }, 't2', signal());
    expect(decision(out)?.permissionDecision).toBe('deny');
    expect(store.get('t2')?.status).toBe('blocked');
  });

  it('backs up a yellow edit, and Undo restores it', async () => {
    const { gate, store, notices } = setup();
    const file = join(userDir, 'doc.txt');
    writeFileSync(file, 'v1');
    const out = await gate.preToolUse('tab', 'Edit', { file_path: file, old_string: 'v1', new_string: 'v2' }, 't3', signal());
    expect(decision(out)?.permissionDecision).toBe('allow');
    writeFileSync(file, 'v2');
    gate.done('Edit', { file_path: file }, 't3', {});
    expect(store.get('t3')).toMatchObject({ status: 'done', canUndo: true, backups: [file] });

    gate.undo('t3');
    expect(readFileSync(file, 'utf8')).toBe('v1');
    expect(store.get('t3')?.status).toBe('undone');
    expect(notices[0]).toMatch(/^Undone/);
  });

  it('runs red commands without a card (cards are gone, 2026-11-11), backed up and logged', async () => {
    const { gate, store, sent } = setup();
    const file = join(userDir, 'gone.txt');
    writeFileSync(file, 'keep a copy');
    const out = await gate.preToolUse('tab', 'PowerShell', { command: `Remove-Item "${file}"` }, 'q1', signal());
    expect(decision(out)?.permissionDecision).toBe('allow');
    expect(store.get('q1')).toMatchObject({
      tier: 'red',
      status: 'running',
      backups: [file],
      result: 'Ran (backed up where it changes files; Undo).',
    });
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
    expect(await gate.canUseTool('PowerShell', { command: `Remove-Item "${file}"` }, 'q1', 'tab')).toMatchObject({ behavior: 'allow' });
    // Blocked stays blocked.
    expect(decision(await gate.preToolUse('tab', 'PowerShell', { command: 'format D:' }, 'q2', signal()))?.permissionDecision).toBe('deny');
  });
});

describe('questions, plans and sending (docs/PLAN.md §6s)', () => {
  beforeEach(() => writeSettings({ askRisky: false }));
  const deny = (out: unknown) =>
    (out as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? '';
  const question = {
    questions: [
      {
        question: 'Which colour?',
        header: 'Colour',
        multiSelect: false,
        options: [
          { label: 'Blue', description: 'cool' },
          { label: 'Amber', description: 'warm' },
        ],
      },
    ],
  };

  it("shows Claude's questions as a card and gives the answers back in the tool's input", async () => {
    const { gate, sent } = setup();
    const out = gate.preToolUse('tab', 'AskUserQuestion', question, 'ask1', signal());
    await Promise.resolve();
    const card = sent.find((m) => m.type === 'approval.request');
    expect(card?.type === 'approval.request' && card.approval).toMatchObject({
      kind: 'question',
      questions: [{ question: 'Which colour?' }],
    });
    gate.answer('ask1', true, { answers: { 'Which colour?': 'Amber' } });
    expect(decision(await out)).toMatchObject({
      permissionDecision: 'allow',
      updatedInput: { ...question, answers: { 'Which colour?': 'Amber' } },
    });
  });

  it('passes on what the user wrote instead of picking, and Stop is not a refusal', async () => {
    const { gate } = setup();
    const out = gate.preToolUse('tab', 'AskUserQuestion', question, 'ask2', signal());
    await Promise.resolve();
    gate.answer('ask2', false, { why: 'neither, use green' });
    expect(deny(await out)).toContain('neither, use green');
    const stopped = gate.preToolUse('tab', 'AskUserQuestion', question, 'ask3', signal());
    await Promise.resolve();
    gate.cancel('tab');
    expect(deny(await stopped)).toContain('pressed Stop');
  });

  it('keeps plan mode to reading and planning until the user approves the plan', async () => {
    const changes: [string, boolean][] = [];
    const store = new ActionStore(':memory:');
    const sent: SafetyServerMessage[] = [];
    const gate = new SafetyGate(store, {
      broadcast: (m) => sent.push(m),
      notice: () => {},
      onChange: () => {},
      onPlanMode: (tab, on) => changes.push([tab, on]),
    });
    expect(decision(await gate.preToolUse('tab', 'EnterPlanMode', {}, 'p0', signal()))?.permissionDecision).toBe('allow');
    expect(gate.isPlanning('tab')).toBe(true);
    const file = join(userDir, 'plan-target.txt');
    expect(decision(await gate.preToolUse('tab', 'Write', { file_path: file, content: 'x' }, 'p1', signal()))?.permissionDecision).toBe(
      'deny',
    );
    expect(decision(await gate.preToolUse('tab', 'Read', { file_path: file }, 'p2', signal()))?.permissionDecision).toBe('allow');
    const planFile = join(home, 'workspace', 'plans', 'plan.md');
    expect(
      decision(await gate.preToolUse('tab', 'Write', { file_path: planFile, content: '# Plan' }, 'p3', signal()))?.permissionDecision,
    ).toBe('allow');
    // Other chats aren't in plan mode.
    expect(decision(await gate.preToolUse('other', 'Write', { file_path: file, content: 'x' }, 'p4', signal()))?.permissionDecision).toBe(
      'allow',
    );

    const asked = gate.preToolUse('tab', 'ExitPlanMode', { plan: '1. Do it' }, 'p5', signal());
    await Promise.resolve();
    const card = sent.findLast((m) => m.type === 'approval.request');
    expect(card?.type === 'approval.request' && card.approval).toMatchObject({ kind: 'plan', plan: '1. Do it' });
    gate.answer('p5', false, { why: 'add tests' });
    expect(deny(await asked)).toContain('add tests');
    expect(gate.isPlanning('tab')).toBe(true);

    const again = gate.preToolUse('tab', 'ExitPlanMode', { plan: '1. Do it\n2. Test it' }, 'p6', signal());
    await Promise.resolve();
    gate.answer('p6', true);
    expect(decision(await again)?.permissionDecision).toBe('allow');
    expect(gate.isPlanning('tab')).toBe(false);
    expect(changes).toEqual([
      ['tab', true],
      ['tab', false],
    ]);
  });

  it("asks before sending something the user didn't ask to send, even with cards off", async () => {
    const { gate, notices } = setup();
    await gate.setTurn('tab', 'summarize my inbox');
    const out = await gate.preToolUse('tab', 'mcp__claude_ai_Gmail__send_message', { to: 'x@example.com' }, 's1', signal());
    expect(decision(out)?.permissionDecision).toBe('deny');
    expect(decision(out)?.permissionDecisionReason).toMatch(/Held \(#1\)/);
    expect(notices.at(-1)).toMatch(/Held, waiting for your yes: #1/);
    // A no drops it.
    expect(await gate.setTurn('tab', 'no, leave it')).toMatch(/dropped/);
    expect(gate.heldCount('tab')).toBe(0);

    // Asked to send: it just sends (logged).
    gate.setTurn('tab', 'send Peter the summary by email');
    expect(
      decision(await gate.preToolUse('tab', 'mcp__claude_ai_Gmail__send_message', { to: 'peter@example.com' }, 's2', signal()))
        ?.permissionDecision,
    ).toBe('allow');
    // The turn is over: the next one is checked on its own words.
    gate.turnEnded('tab');
    expect(
      decision(await gate.preToolUse('tab', 'mcp__claude_ai_Gmail__send_message', { to: 'p@example.com' }, 's3', signal()))
        ?.permissionDecision,
    ).toBe('deny');
    expect(gate.heldCount('tab')).toBe(1);
  });

  it('never lets a mail Harv reads make him reply: "check my email" asks to read (connectors plan K1)', async () => {
    const { gate } = setup();
    const reply = 'mcp__claude_ai_Gmail__reply';
    const run = async (id: string, tool: string, input: Record<string, unknown>) =>
      decision(await gate.preToolUse('tab', tool, input, id, signal()))?.permissionDecision;
    await gate.setTurn('tab', 'check my email');
    expect(await run('r1', reply, { messageId: 'm1', body: 'ok' })).toBe('deny');
    expect(await run('r2', 'mcp__claude_ai_Gmail__send_message', { draftId: 'd1' })).toBe('deny');
    // Reading, labels and the bin just run.
    expect(await run('r3', 'mcp__claude_ai_Gmail__get_message', { messageId: 'm1' })).toBe('allow');
    expect(await run('r4', 'mcp__claude_ai_Gmail__trash_message', { messageId: 'm1' })).toBe('allow');
    gate.turnEnded('tab');

    await gate.setTurn('tab', 'reply to that mail that Friday works');
    expect(await run('r5', reply, { messageId: 'm1', body: 'Friday works' })).toBe('allow');
    expect(await run('r6', reply, { messageId: 'm1', body: 'x', replyAll: true })).toBe('deny');
    gate.turnEnded('tab');

    // A scheduled task's prompt that says "reply" still never replies unattended.
    gate.setTurn('tab', '[Scheduled task "Mail"] reply to new mails', true, undefined, true);
    expect(await run('r7', reply, { messageId: 'm2', body: 'x' })).toBe('deny');
  });

  it('treats a calendar invite as sending, and an event of his own as a plain write', async () => {
    const { gate } = setup();
    const create = 'mcp__claude_ai_Google_Calendar__create_event';
    const run = async (id: string, input: Record<string, unknown>) =>
      decision(await gate.preToolUse('tab', create, input, id, signal()))?.permissionDecision;
    await gate.setTurn('tab', 'put the dentist in for Tuesday 3 pm');
    expect(await run('c1', { summary: 'Dentist', startTime: '2026-11-17T15:00:00', endTime: '2026-11-17T16:00:00' })).toBe('allow');
    expect(await run('c2', { summary: 'Dentist', startTime: 'x', endTime: 'y', attendees: [{ email: 'clinic@example.com' }] })).toBe(
      'deny',
    );
    gate.turnEnded('tab');
    await gate.setTurn('tab', 'invite Peter to lunch on Friday');
    expect(await run('c3', { summary: 'Lunch', startTime: 'x', endTime: 'y', attendees: [{ email: 'peter@example.com' }] })).toBe('allow');
  });
});

/** As Windows-MCP 0.8.8 sends it: a JSON list of strings around an indented UI tree. */
const SNAPSHOT = JSON.stringify([
  [
    '',
    '    Focused Window:',
    '    Discord',
    '',
    '    UI Tree:',
    '    desktop',
    '    └── window "Discord"',
    '        ├── (812,940) button "Send"  [action: click]',
    '        ├── (400,300) listitem "general"  [action: click]',
    '        ├── pane "Chat"',
    '        │   ├── (600,940) edit "Message #general"  [action: type]',
    '        │   └── (600,500) list "Messages"  [action: scroll]  [v:80%]',
    '        ├── (600,100) edit "Password"  [action: type]',
    '        ├── (900,100) edit "Search"  [action: type]',
    '        └── (950,300) button "Delete message"  [action: click]',
  ].join('\n'),
]);
/** Harv looks at the screen first (Snapshot), so the gate knows what a click would hit. */
async function look(gate: InstanceType<typeof SafetyGate>, id = `snap-${Math.random()}`) {
  await gate.preToolUse('tab', 'mcp__desktop__Snapshot', {}, id, signal());
  gate.done('mcp__desktop__Snapshot', {}, id, [{ type: 'text', text: SNAPSHOT }]);
}

describe('desktop control (docs/PLAN.md §6t item 1)', () => {
  const click = 'mcp__desktop__Click';

  it('runs ordinary actions without a card, even when the message didn’t name the desktop (the user’s rule, 2026-11-09)', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    gate.setTurn('tab', 'Discord is acting up, sort it out');
    await look(gate);
    for (const [n, tool, input] of [
      [1, click, { label: 1 }],
      [2, click, { loc: [500, 500] }],
      [3, 'mcp__desktop__Type', { text: 'hello', label: 2 }],
      [4, 'mcp__desktop__Shortcut', { shortcut: 'ctrl+l' }],
      [5, 'mcp__desktop__App', { mode: 'switch', name: 'Discord' }],
    ] as const) {
      expect(decision(await gate.preToolUse('tab', tool, input, `o${n}`, signal()))?.permissionDecision).toBe('allow');
      expect(await gate.canUseTool(tool, input, `o${n}`, 'tab')).toMatchObject({ behavior: 'allow' });
    }
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
  });

  it('asks before a risky action the user didn’t ask for, with cards off too, every time', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent, notices } = setup();
    await gate.setTurn('tab', 'Discord is acting up, sort it out');
    await look(gate);
    const first = await gate.preToolUse('tab', click, { label: 0 }, 'r1', signal());
    expect(decision(first)?.permissionDecision).toBe('deny');
    expect(notices.at(-1)).toContain('Clicks “Send” in Discord');
    // The user's yes in their next message lets that click through once, even by its point after a new Snapshot.
    expect(await gate.setTurn('tab', 'jo')).toMatch(/said yes to: #1/);
    await look(gate);
    expect(decision(await gate.preToolUse('tab', click, { loc: [813, 941] }, 'r2', signal()))?.permissionDecision).toBe('allow');
    expect(await gate.canUseTool(click, { loc: [813, 941] }, 'r2', 'tab')).toMatchObject({ behavior: 'allow' });
    // An OK covers one action: the next one is held again.
    expect(decision(await gate.preToolUse('tab', click, { label: 0 }, 'r2b', signal()))?.permissionDecision).toBe('deny');
    // Enter in a field Harv can't see may send; a search box doesn't; a password field always asks.
    for (const [id, input] of [
      ['r3', { text: 'hi', loc: [10, 10], press_enter: true }],
      ['r4', { text: 'hunter2', label: 3 }],
    ] as const) {
      expect(decision(await gate.preToolUse('tab', 'mcp__desktop__Type', input, id, signal()))?.permissionDecision).toBe('deny');
    }
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
    expect(
      decision(await gate.preToolUse('tab', 'mcp__desktop__Type', { text: 'cats', label: 4, press_enter: true }, 'r5', signal()))
        ?.permissionDecision,
    ).toBe('allow');
  });

  it('needs no card when the user asked for that kind of action outright (English and Slovak)', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    for (const message of ['send Peter a hi on Discord', 'pošli Petrovi ahoj na Discorde']) {
      gate.setTurn('tab', message);
      await look(gate);
      const id = `k-${message.length}`;
      expect(decision(await gate.preToolUse('tab', click, { label: 0 }, id, signal()))?.permissionDecision).toBe('allow');
      expect(await gate.canUseTool(click, { label: 0 }, id, 'tab')).toMatchObject({ behavior: 'allow' });
      gate.turnEnded('tab');
    }
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
    // Asking to send doesn't cover deleting.
    await gate.setTurn('tab', 'send Peter a hi');
    await look(gate);
    expect(decision(await gate.preToolUse('tab', click, { label: 5 }, 'k-del', signal()))?.permissionDecision).toBe('deny');
    expect(gate.heldCount('tab')).toBe(1);
  });

  it('lets Windows-MCP start at once: the user’s message and Approve click aren’t them taking over', async () => {
    writeSettings({ askRisky: false });
    const grants: number[] = [];
    const gate = new SafetyGate(new ActionStore(':memory:'), {
      broadcast: () => {},
      notice: () => {},
      onChange: () => {},
      desktopGrant: (at) => grants.push(at),
    });
    const before = Date.now();
    gate.setTurn('tab', 'sort it out');
    await look(gate);
    expect(grants.length).toBe(1);
    expect(grants[0]).toBeGreaterThanOrEqual(before);
    const sentAt = grants[0]!;
    await gate.preToolUse('tab', click, { label: 1 }, 'g1', signal());
    expect(grants.at(-1)).toBe(sentAt);
    // A held step run after the user's yes starts from that yes.
    await gate.preToolUse('tab', click, { label: 0 }, 'g2', signal());
    await new Promise((r) => setTimeout(r, 5));
    await gate.setTurn('tab', 'yes');
    await look(gate);
    await gate.preToolUse('tab', click, { label: 0 }, 'g3', signal());
    expect(grants.at(-1)).toBeGreaterThan(sentAt);
  });

  it('refuses scheduled and background turns, where nobody may be at the computer', async () => {
    writeSettings({ askRisky: false });
    const { gate, store, sent } = setup();
    gate.setTurn('tab', '[Scheduled task "Morning"] click the button', true, undefined, true);
    expect(decision(await gate.preToolUse('tab', click, { label: 1 }, 'g1', signal()))?.permissionDecision).toBe('deny');
    expect(store.get('g1')?.status).toBe('blocked');
    // A turn Claude started by itself has no turn text.
    gate.turnEnded('tab');
    expect(decision(await gate.preToolUse('tab', click, { label: 1 }, 'g2', signal()))?.permissionDecision).toBe('deny');
    // Reading the screen is still fine.
    expect(decision(await gate.preToolUse('tab', 'mcp__desktop__Snapshot', {}, 'g3', signal()))?.permissionDecision).toBe('allow');
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
  });

  it('needs no card when the user’s message says what to do there (the user’s rule, 2026-11-09)', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    for (const message of ['open Discord and click the general channel', 'otvor Spotify a pusti moje obľúbené']) {
      gate.setTurn('tab', message);
      expect(decision(await gate.preToolUse('tab', click, { label: 4 }, `x-${message.length}`, signal()))?.permissionDecision).toBe(
        'allow',
      );
      expect(await gate.canUseTool(click, { label: 4 }, `x-${message.length}`, 'tab')).toMatchObject({ behavior: 'allow' });
      gate.turnEnded('tab');
    }
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
  });

  it('blocks launch_executable even after the OK', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    gate.setTurn('tab', 'run it');
    const out = await gate.preToolUse('tab', 'mcp__desktop__App', { mode: 'launch_executable', executable: 'x.exe' }, 'h1', signal());
    expect(decision(out)?.permissionDecision).toBe('deny');
    // A refusal by this tool only: it names the PowerShell tool and doesn't say "don't try another way".
    expect(decision(out)?.permissionDecisionReason).toMatch(/PowerShell tool/);
    expect(decision(out)?.permissionDecisionReason).not.toMatch(/another way around/);
  });

  it('lets launch_executable open a Control Panel page', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    gate.setTurn('tab', 'open sound settings');
    const input = { mode: 'launch_executable', executable: 'C:\\Windows\\System32\\control.exe', args: ['mmsys.cpl'] };
    const out = await gate.preToolUse('tab', 'mcp__desktop__App', input, 'h2', signal());
    expect(decision(out)?.permissionDecision).toBe('allow');
  });

  // The full review, S13 (the user's pick for Q3): in an app without elements, "type, then click Send" is held.
  it('holds a click that follows typing in a field Harv cannot see, and forgets an old Snapshot', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    gate.setTurn('tab', 'Discord is acting up, sort it out');
    await look(gate);
    // A plain click where the Snapshot shows nothing: runs.
    expect(decision(await gate.preToolUse('tab', click, { loc: [20, 20] }, 'u1', signal()))?.permissionDecision).toBe('allow');
    // Typing where the Snapshot shows nothing, then a click there: held as maybe sending.
    expect(
      decision(await gate.preToolUse('tab', 'mcp__desktop__Type', { text: 'hi', loc: [30, 30] }, 'u2', signal()))?.permissionDecision,
    ).toBe('allow');
    expect(decision(await gate.preToolUse('tab', click, { loc: [40, 40] }, 'u3', signal()))?.permissionDecision).toBe('deny');
    // A new Snapshot makes it seen again.
    await look(gate);
    expect(decision(await gate.preToolUse('tab', click, { loc: [40, 40] }, 'u4', signal()))?.permissionDecision).toBe('allow');
    // After a Screenshot the old Snapshot's "Delete message" no longer judges a click at its point.
    expect(decision(await gate.preToolUse('tab', click, { loc: [950, 300] }, 'u5', signal()))?.permissionDecision).toBe('deny');
    await gate.preToolUse('tab', 'mcp__desktop__Screenshot', {}, 'u6', signal());
    gate.done('mcp__desktop__Screenshot', {}, 'u6', []);
    expect(decision(await gate.preToolUse('tab', click, { loc: [950, 300] }, 'u7', signal()))?.permissionDecision).toBe('allow');
  });
});

describe('desktop control signal (the pill)', () => {
  const controls = (sent: SafetyServerMessage[]) =>
    sent.flatMap((m) => (m.type === 'desktop.control' ? [{ tabId: m.tabId, action: m.action }] : []));

  it('says which chat uses the desktop and what it does, until the reply ends', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    gate.setTurn('tab', 'sort it out');
    // Looking makes Harv's own window step aside first (2026-11-11), so the picture shows the work.
    await gate.preToolUse('tab', 'mcp__desktop__Snapshot', {}, 'p0', signal());
    expect(controls(sent)).toEqual([{ tabId: 'tab', action: 'looking at the screen' }]);

    await gate.preToolUse('tab', 'mcp__desktop__Click', { label: 3 }, 'p1', signal());
    await gate.preToolUse('tab', 'mcp__desktop__Type', { text: 'hi' }, 'p2', signal());
    expect(controls(sent)).toEqual([
      { tabId: 'tab', action: 'looking at the screen' },
      { tabId: 'tab', action: 'click element #3 from the last snapshot' },
      { tabId: 'tab', action: 'type “hi”' },
    ]);
    const since = gate.desktopControl()!.since;
    expect(gate.desktopControl()).toMatchObject({ tabId: 'tab', action: 'type “hi”' });
    expect(sent.filter((m) => m.type === 'desktop.control').every((m) => m.type === 'desktop.control' && m.since === since)).toBe(true);

    gate.turnEnded('tab');
    expect(controls(sent).at(-1)).toEqual({ tabId: 'tab', action: null });
    expect(gate.desktopControl()).toBeNull();
  });

  it('Stop ends it, and another chat ending changes nothing', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    gate.setTurn('tab', 'sort it out');
    await gate.preToolUse('tab', 'mcp__desktop__Click', { label: 1 }, 'q1', signal());
    gate.turnEnded('other');
    expect(gate.desktopControl()?.tabId).toBe('tab');
    gate.cancel('tab');
    expect(gate.desktopControl()).toBeNull();
    expect(controls(sent).at(-1)).toEqual({ tabId: 'tab', action: null });
  });

  it('a held step never starts it', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    await gate.setTurn('tab', 'sort it out');
    await look(gate);
    await gate.preToolUse('tab', 'mcp__desktop__Click', { label: 0 }, 'r1', signal());
    expect(controls(sent).map((c) => c.action)).not.toContain('click “Send” in Discord');
    expect(gate.desktopControl()?.action).toBe('looking at the screen');
  });

  it('a shell screenshot steps Harv’s window aside first, until the reply ends', async () => {
    const { gate, sent } = setup();
    await gate.setTurn('tab', 'check how the explorer looks now');
    await gate.preToolUse('tab', 'Bash', { command: 'spectacle -b -n -f -o /tmp/shot.png' }, 'sh1', signal());
    expect(controls(sent)).toEqual([{ tabId: 'tab', action: 'looking at the screen' }]);
    await gate.preToolUse('tab', 'Bash', { command: 'ls' }, 'sh2', signal());
    expect(controls(sent)).toHaveLength(1);
    gate.turnEnded('tab');
    expect(controls(sent).at(-1)).toEqual({ tabId: 'tab', action: null });
  });
});

describe('desktop control on one monitor', () => {
  // The user's smaller right monitor, the one Harv works on by default.
  const right = { device: 'D2', primary: false, left: 2560, top: 147, right: 4480, bottom: 1227 };
  const area = { ...right, label: 'right', region: [2560, 147, 4480, 1227] as [number, number, number, number], count: 2 };
  function setupOn() {
    const store = new ActionStore(':memory:');
    const sent: SafetyServerMessage[] = [];
    const gate = new SafetyGate(store, { broadcast: (m) => sent.push(m), notice: () => {}, onChange: () => {}, desktopArea: () => area });
    return { gate, store, sent };
  }

  it('limits looking to the work monitor unless the call already says where', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setupOn();
    gate.setTurn('tab', 'what does Discord show?');
    expect(decision(await gate.preToolUse('tab', 'mcp__desktop__Snapshot', {}, 'm1', signal()))?.updatedInput).toEqual({
      region: [2560, 147, 4480, 1227],
    });
    expect(
      decision(await gate.preToolUse('tab', 'mcp__desktop__Screenshot', { display: [0] }, 'm2', signal()))?.updatedInput,
    ).toBeUndefined();
    // The user named a monitor: the whole desktop.
    gate.setTurn('tab', 'look at both monitors');
    expect(decision(await gate.preToolUse('tab', 'mcp__desktop__Snapshot', {}, 'm3', signal()))?.updatedInput).toBeUndefined();
  });

  it('refuses acting on another monitor unless the message names it, before any card', async () => {
    writeSettings({ askRisky: false });
    const { gate, store, sent } = setupOn();
    gate.setTurn('tab', 'click the start button');
    const out = await gate.preToolUse('tab', 'mcp__desktop__Click', { loc: [100, 1400] }, 'n1', signal());
    expect(decision(out)?.permissionDecision).toBe('deny');
    expect(store.get('n1')?.status).toBe('blocked');
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
    // Moving a window onto another monitor counts too.
    expect(
      decision(await gate.preToolUse('tab', 'mcp__desktop__App', { mode: 'resize', name: 'X', window_loc: [10, 10] }, 'n2', signal()))
        ?.permissionDecision,
    ).toBe('deny');

    gate.setTurn('tab', 'sort out the thing on the left monitor');
    expect(decision(await gate.preToolUse('tab', 'mcp__desktop__Click', { loc: [100, 1400] }, 'n3', signal()))?.permissionDecision).toBe(
      'allow',
    );
  });

  it("pins an App launch or switch to Harv's monitor, not when the message names another (report note, 2026-11-19)", async () => {
    writeSettings({ askRisky: false });
    const store = new ActionStore(':memory:');
    const pins: unknown[] = [];
    const gate = new SafetyGate(store, {
      broadcast: () => {},
      notice: () => {},
      onChange: () => {},
      desktopArea: () => area,
      desktopPin: (a) => pins.push(a?.region ?? null),
    });
    gate.setTurn('tab', 'open the Garmin Connect simulator');
    await gate.preToolUse('tab', 'mcp__desktop__App', { mode: 'launch', name: 'Garmin Connect' }, 'p1', signal());
    await gate.preToolUse('tab', 'mcp__desktop__Snapshot', {}, 'p2', signal());
    gate.setTurn('tab', 'open notepad on the left monitor');
    await gate.preToolUse('tab', 'mcp__desktop__App', { mode: 'launch', name: 'Notepad' }, 'p3', signal());
    expect(pins).toEqual([[2560, 147, 4480, 1227], null]);
  });

  it('tells the pill where Harv acts: the point, else the last one, else the middle of the work monitor', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setupOn();
    gate.setTurn('tab', 'sort it out');
    await gate.preToolUse('tab', 'mcp__desktop__Shortcut', { shortcut: 'ctrl+l' }, 'o1', signal());
    await gate.preToolUse('tab', 'mcp__desktop__Click', { loc: [3000, 500] }, 'o2', signal());
    await gate.preToolUse('tab', 'mcp__desktop__Type', { text: 'x', label: 4 }, 'o3', signal());
    const ats = sent.flatMap((m) => (m.type === 'desktop.control' && m.action ? [m.at] : []));
    expect(ats).toEqual([
      [3520, 687],
      [3000, 500],
      [3000, 500],
    ]);
  });
});

describe('formatting a USB drive (format_drive)', () => {
  const fmt = 'mcp__harv__format_drive';
  const input = { drive: 'G:', disk_name: 'USB SanDisk 3.2Gen1', label: 'CAR' };

  it('always asks, even with cards off, and names the drive on the card', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    gate.setTurn('tab', 'format my usb stick');
    expect(decision(await gate.preToolUse('tab', 'mcp__harv__list_drives', {}, 'u0', signal()))?.permissionDecision).toBe('allow');
    const out = gate.preToolUse('tab', fmt, input, 'u1', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    const card = sent.find((m) => m.type === 'approval.request');
    expect(card?.type === 'approval.request' && card.approval.summary).toBe('ERASE G: (USB SanDisk 3.2Gen1) and format it EXFAT "CAR"');
    gate.answer('u1', true);
    expect(decision(await out)?.permissionDecision).toBe('allow');
    expect(await gate.canUseTool(fmt, input, 'u1', 'tab')).toMatchObject({ behavior: 'allow' });
    // A second format in the same reply asks again.
    void gate.preToolUse('tab', fmt, input, 'u2', signal());
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    gate.cancel('tab');
  });

  it('is refused in scheduled and background turns', async () => {
    const { gate, store } = setup();
    gate.setTurn('tab', '[Scheduled task "Clean"] format the stick', true, undefined, true);
    expect(decision(await gate.preToolUse('tab', fmt, input, 'v1', signal()))?.permissionDecision).toBe('deny');
    expect(store.get('v1')?.status).toBe('blocked');
  });
});

describe('a script Harv can’t read', () => {
  it('is held even with cards off, and the chat line says why', async () => {
    writeSettings({ askRisky: false });
    const { gate, notices } = setup();
    const { WORKSPACE } = await import('./paths.ts');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(WORKSPACE, { recursive: true });
    const file = join(WORKSPACE, 'setup.ps1');
    writeFileSync(file, 'iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("ZWNobyBoaQ==")))');
    await gate.setTurn('tab', 'set up the new tool');
    const out = await gate.preToolUse('tab', 'PowerShell', { command: `powershell -File "${file}"` }, 's1', signal());
    expect(decision(out)?.permissionDecision).toBe('deny');
    expect(notices.at(-1)).toMatch(/hides what it runs/);
    expect(notices.at(-1)).toContain(`powershell -File "${file}"`);
  });
});

describe('asked first, not blocked (the user’s rule, 2026-11-11: three hard stops, the rest asks)', () => {
  const firewall = { command: 'netsh advfirewall set allprofiles state off' };

  it('runs at once when the user asked for exactly this outright (their request is the yes)', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent } = setup();
    await gate.setTurn('tab', 'turn the firewall off, I ask outright');
    expect(decision(await gate.preToolUse('tab', 'PowerShell', firewall, 'f0', signal()))?.permissionDecision).toBe('allow');
    expect(await gate.canUseTool('PowerShell', firewall, 'f0', 'tab')).toMatchObject({ behavior: 'allow' });
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
  });

  it('holds its own ideas, keeps them past the turn, and a yes in the next message runs exactly that call once', async () => {
    writeSettings({ askRisky: false });
    const { gate, store, notices } = setup();
    await gate.setTurn('tab', 'make my PC faster');
    const out = await gate.preToolUse('tab', 'PowerShell', firewall, 'f1', signal());
    expect(decision(out)?.permissionDecision).toBe('deny');
    expect(decision(out)?.permissionDecisionReason).toMatch(/finish the rest first/);
    expect(notices.at(-1)).toContain(firewall.command);
    // Retried in the same turn: still held, one line only.
    await gate.preToolUse('tab', 'PowerShell', firewall, 'f1b', signal());
    expect(notices.filter((n) => n.startsWith('Held')).length).toBe(1);
    gate.turnEnded('tab');
    gate.cancel('tab');
    expect(gate.heldCount('tab')).toBe(1);
    expect(await gate.setTurn('tab', 'áno, a potom reštartuj PC')).toMatch(/said yes to: #1/);
    // A changed command is held again; the same one runs once.
    expect(
      decision(await gate.preToolUse('tab', 'PowerShell', { command: `${firewall.command}; whoami` }, 'f2', signal()))?.permissionDecision,
    ).toBe('deny');
    expect(decision(await gate.preToolUse('tab', 'PowerShell', firewall, 'f3', signal()))?.permissionDecision).toBe('allow');
    expect(store.get('f3')?.status).toBe('running');
    expect(decision(await gate.preToolUse('tab', 'PowerShell', firewall, 'f4', signal()))?.permissionDecision).toBe('deny');
  });

  it('a turn is unattended by how it started, not by its text (the full review, S26)', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    const reason = async (id: string) =>
      decision(await gate.preToolUse('tab', 'PowerShell', firewall, id, signal()))?.permissionDecisionReason;
    // The user typing text that looks like the scheduler's tag is still the user: asked in the chat.
    await gate.setTurn('tab', '[Scheduled task "x"] turn the firewall off');
    expect(await reason('k1')).toMatch(/needs the user's yes/);
    gate.turnEnded('tab');
    gate.cancel('tab');
    // The scheduler's own turn: held for the report.
    await gate.setTurn('tab', '[Scheduled task "x"] tidy up', true, undefined, true);
    expect(await reason('k2')).toMatch(/Nobody is here/);
  });

  it('a yes to a held file change covers that content only (the full review, S15)', async () => {
    const dir = join(tmpdir(), `harv-ro-${Date.now()}`);
    writeSettings({ askRisky: false, protectedPaths: [dir] });
    const { gate } = setup();
    const file = join(dir, 'notes.txt');
    await gate.setTurn('tab', 'tidy my notes');
    const write = (content: string, id: string) => gate.preToolUse('tab', 'Write', { file_path: file, content }, id, signal());
    expect(decision(await write('v1', 'w1'))?.permissionDecision).toBe('deny');
    gate.turnEnded('tab');
    gate.cancel('tab');
    expect(await gate.setTurn('tab', 'yes')).toMatch(/said yes to: #1/);
    expect(decision(await write('something else', 'w2'))?.permissionDecision).toBe('deny');
    expect(decision(await write('v1', 'w3'))?.permissionDecision).toBe('allow');
  });

  it("takes the Yes / No buttons' answer as it is, without judging the message (report note, 2026-11-18)", async () => {
    writeSettings({ askRisky: false });
    const { judgeReply } = await import('./judge.ts');
    const { gate } = setup();
    await gate.setTurn('tab', 'make my PC faster');
    await gate.preToolUse('tab', 'PowerShell', firewall, 'b1', signal());
    await gate.preToolUse('tab', 'PowerShell', { command: 'Stop-Service wuauserv' }, 'b2', signal());
    expect(gate.heldCount('tab')).toBe(2);
    gate.turnEnded('tab');
    vi.mocked(judgeReply).mockClear();
    gate.answerNext('tab', 'yes');
    expect(await gate.setTurn('tab', 'yes')).toMatch(/said yes to: #1 .*; #2 /);
    expect(judgeReply).not.toHaveBeenCalled();
    expect(decision(await gate.preToolUse('tab', 'PowerShell', firewall, 'b3', signal()))?.permissionDecision).toBe('allow');

    await gate.preToolUse('tab', 'PowerShell', { command: 'Stop-Service bits' }, 'b4', signal());
    gate.turnEnded('tab');
    gate.answerNext('tab', 'no');
    expect(await gate.setTurn('tab', 'no')).toMatch(/held actions are dropped/);
    expect(gate.heldCount('tab')).toBe(0);
    // A press is used once: the next message is read as usual.
    await gate.preToolUse('tab', 'PowerShell', { command: 'Stop-Service bits' }, 'b5', signal());
    gate.turnEnded('tab');
    expect(await gate.setTurn('tab', 'hmm, what does it do?')).toMatch(/Still held/);
  });

  it('still waits after a restart, but a yes given before it is gone (pass C, C12)', async () => {
    writeSettings({ askRisky: false });
    const { gate, store } = setup();
    await gate.setTurn('tab', 'make my PC faster');
    await gate.preToolUse('tab', 'PowerShell', firewall, 'r1', signal());
    expect(gate.heldAll()).toEqual([expect.objectContaining({ tabId: 'tab', count: 1 })]);
    // A new gate on the same database = Harv restarted.
    const after = new SafetyGate(store, { broadcast: () => {}, notice: () => {}, onChange: () => {} });
    expect(after.heldCount('tab')).toBe(1);
    expect(await after.setTurn('tab', 'yes')).toMatch(/said yes to: #1/);
    expect(decision(await after.preToolUse('tab', 'PowerShell', firewall, 'r2', signal()))?.permissionDecision).toBe('allow');
    // Answered: nothing is kept for the next start.
    expect(new SafetyGate(store, { broadcast: () => {}, notice: () => {}, onChange: () => {} }).heldCount('tab')).toBe(0);
    // A yes is never kept: held again, granted, then restarted before the retry.
    await after.setTurn('tab', 'make it faster again');
    await after.preToolUse('tab', 'PowerShell', firewall, 'r3', signal());
    await after.setTurn('tab', 'yes');
    const third = new SafetyGate(store, { broadcast: () => {}, notice: () => {}, onChange: () => {} });
    expect(decision(await third.preToolUse('tab', 'PowerShell', firewall, 'r4', signal()))?.permissionDecision).toBe('deny');
    // A deleted chat takes its held list with it.
    third.forget('tab');
    expect(new SafetyGate(store, { broadcast: () => {}, notice: () => {}, onChange: () => {} }).heldAll()).toEqual([]);
  });

  it('picks items: "yes 1 and 3", "yes but not 2"; hand-offs and scheduled text never say yes', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    const cmds = ['netsh advfirewall set allprofiles state off', 'sudo ufw disable', 'Set-MpPreference -DisableRealtimeMonitoring $true'];
    const holdAll = async () => {
      await gate.setTurn('tab', 'make it faster');
      for (const [i, command] of cmds.entries()) await gate.preToolUse('tab', 'PowerShell', { command }, `h${i}`, signal());
    };
    await holdAll();
    expect(gate.heldCount('tab')).toBe(3);
    expect(await gate.setTurn('tab', '', false)).toBe('');
    expect(await gate.setTurn('tab', '[Scheduled task "x"] yes', true, undefined, true)).toBe('');
    expect(gate.heldCount('tab')).toBe(3);
    const note = await gate.setTurn('tab', 'yes 1 and 3');
    expect(note).toMatch(/#1 .*#3/);
    expect(note).toMatch(/Dropped: #2 .*; say so in one line/);
    expect(decision(await gate.preToolUse('tab', 'PowerShell', { command: cmds[1]! }, 'x2', signal()))?.permissionDecision).toBe('deny');
    gate.turnEnded('tab');
    // The new hold of #2 above is dropped by a no.
    expect(await gate.setTurn('tab', 'nie, nechaj to')).toMatch(/held actions are dropped: .*say in one line that you dropped them/);
    expect(gate.heldCount('tab')).toBe(0);
    await holdAll();
    const but = await gate.setTurn('tab', 'jo but not 2');
    expect(but).toMatch(/said yes to: #1 .*#3/);
    expect(but).toMatch(/Dropped: #2/);
  });

  it('never asks in a turn nobody typed: it is held for the report', async () => {
    writeSettings({ askRisky: false });
    const { gate, sent, store } = setup();
    gate.setTurn('tab', '[Scheduled task "Tidy"] tidy up', true, undefined, true);
    const out = await gate.preToolUse('tab', 'PowerShell', firewall, 'f2', signal());
    expect(decision(out)?.permissionDecision).toBe('deny');
    expect(JSON.stringify(out)).toMatch(/Do the rest of the task/);
    expect(store.get('f2')?.status).toBe('blocked');
    expect(sent.some((m) => m.type === 'approval.request')).toBe(false);
  });
});

describe('local git rewrites (the ShopNotes chat’s branch -D, 2026-11-10)', () => {
  it('copy the repo’s .git before they run, so Undo can bring the history back', async () => {
    writeSettings({ askRisky: false });
    const { spawnSync } = await import('node:child_process');
    const repo = join(userDir, 'repo');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(repo, { recursive: true });
    spawnSync('git', ['-C', repo, 'init', '-q']);
    const { gate, store } = setup();
    await gate.setTurn('tab', 'clean up the old branches');
    const out = await gate.preToolUse('tab', 'Bash', { command: `cd "${repo}" && git branch -D old` }, 'g1', signal());
    expect(decision(out)?.permissionDecision).toBe('allow');
    expect(store.get('g1')?.backups).toEqual(expect.arrayContaining([join(repo, '.git')]));
  });
});

// 2026-11-24: a program Harv started in one step is his own to stop in a later one (only in that chat).
describe('own programs across steps', () => {
  it('remembers what a step left running, per chat', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    const start = 'google-chrome --headless=new --user-data-dir=/tmp/uitest/profile about:blank';
    const stop = 'pkill -f "user-data-dir=/tmp/uitest/profile"';
    await gate.setTurn('tab', 'test the profile page in a headless browser');
    await gate.setTurn('other', 'tidy up');
    expect(decision(await gate.preToolUse('tab', 'Bash', { command: stop }, 's0', signal()))?.permissionDecision).toBe('deny');
    await gate.preToolUse('tab', 'Bash', { command: start, run_in_background: true }, 's1', signal());
    gate.done('Bash', { command: start, run_in_background: true }, 's1', { stdout: '' });
    expect(decision(await gate.preToolUse('tab', 'Bash', { command: stop }, 's2', signal()))?.permissionDecision).not.toBe('deny');
    expect(decision(await gate.preToolUse('other', 'Bash', { command: stop }, 's3', signal()))?.permissionDecision).toBe('deny');
  });
});

// The full review, S16: Harv's browser holds buying, paying, deleting and secret fields like desktop control.
describe("Harv's browser holds the risky kinds", async () => {
  const { setBrowserRefs } = await import('../tools/browserRefs.ts');
  const el = (ref: number, text: string, extra: Partial<Record<string, string>> = {}) => ({
    ref,
    tag: 'button',
    role: 'button',
    text,
    type: '',
    name: '',
    formSubmit: '',
    ...extra,
  });
  const page = (url: string) =>
    setBrowserRefs(
      url,
      [
        el(1, 'Buy now'),
        el(2, 'Place order'),
        el(3, 'Pay 49,99 €'),
        el(4, 'Delete account'),
        el(5, '', { tag: 'input', role: 'textbox', type: 'password', name: 'password' }),
        el(6, '', { tag: 'input', role: 'textbox', name: 'cc-number' }),
        el(7, 'Confirm'),
        el(8, 'Accept all cookies'),
        el(9, 'Kúpiť'),
        el(10, 'Zmazať účet'),
        el(11, '', { tag: 'input', role: 'searchbox', type: 'search', name: 'q' }),
        el(12, 'Next'),
      ].filter((e) => !/news/.test(url) || e.name !== 'cc-number'),
    );
  const run = async (turn: string, tool: string, input: Record<string, unknown>, url = 'https://shop.example/product') => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    page(url);
    await gate.setTurn('tab', turn);
    return decision(await gate.preToolUse('tab', `mcp__harv__browser_${tool}`, input, 'b1', signal()))?.permissionDecision;
  };

  it.each([
    ['click', { ref: 1 }],
    ['click', { ref: 2 }],
    ['click', { ref: 3 }],
    ['click', { ref: 4 }],
    ['click', { ref: 9 }],
    ['click', { ref: 10 }],
    ['type', { ref: 5, text: 'x' }],
    ['type', { ref: 6, text: '4111' }],
  ])('held: %s %o', async (tool, input) => {
    expect(await run('have a look at the cart', tool, input)).toBe('deny');
  });

  it('a plain Confirm is held only on a page that takes money', async () => {
    expect(await run('have a look', 'click', { ref: 7 }, 'https://shop.example/checkout')).toBe('deny');
    expect(await run('have a look', 'click', { ref: 7 }, 'https://news.example/article')).not.toBe('deny');
  });

  it('runs when the message asked for that kind', async () => {
    expect(await run('buy it', 'click', { ref: 1 })).not.toBe('deny');
    expect(await run('kúp to', 'click', { ref: 9 })).not.toBe('deny');
    expect(await run('delete my account there', 'click', { ref: 4 })).not.toBe('deny');
    expect(await run('log in with password x', 'type', { ref: 5, text: 'x' })).not.toBe('deny');
  });

  // The ShopNotes chat (2026-11-23): logging into the user's own dev app with its test account was held.
  it("a login on this computer's own page runs; its money fields and other sites' passwords still ask", async () => {
    for (const url of ['http://localhost:5000/login.html', 'http://127.0.0.1:8000/', 'http://[::1]:3000/admin'])
      expect(await run('test the profile page', 'type', { ref: 5, text: 'Zakaznik123!' }, url)).not.toBe('deny');
    expect(await run('test the checkout', 'type', { ref: 6, text: '4111' }, 'http://localhost:5000/checkout')).toBe('deny');
    for (const url of ['http://localhost.evil.example/login', 'http://192.168.1.1/login', 'https://gitlab.com/users/sign_in'])
      expect(await run('test the profile page', 'type', { ref: 5, text: 'x' }, url)).toBe('deny');
  });

  // The ShopNotes chat (2026-11-23): a zip had to go into a Gmail draft. Uploading is sending.
  it('an upload is sending: runs when asked, held when not, never a login secret', async () => {
    const zip = join(tmpdir(), 'podklady.zip');
    expect(await run('attach podklady.zip to the draft and send it to Peter', 'upload', { ref: 12, path: zip })).not.toBe('deny');
    expect(await run('have a look at the cart', 'upload', { ref: 12, path: zip })).toBe('deny');
    expect(await run('attach my ssh key to the mail', 'upload', { ref: 12, path: '~/.ssh/id_ed25519' })).toBe('deny');
  });

  it('never answers a human check itself', async () => {
    const { setBrowserRefs } = await import('../tools/browserRefs.ts');
    writeSettings({ askRisky: false });
    const { gate } = setup();
    setBrowserRefs('https://shop.example/', [
      el(1, "I'm not a robot", { tag: 'input', role: 'checkbox', type: 'checkbox' }),
      el(2, 'Press & Hold'),
      el(3, '', { tag: 'input', role: 'textbox', name: 'captcha_code' }),
    ]);
    await gate.setTurn('tab', 'open the shop and get past the check');
    for (const [tool, input] of [
      ['click', { ref: 1 }],
      ['click', { ref: 2 }],
      ['type', { ref: 3, text: 'x7k2' }],
    ] as const)
      expect(decision(await gate.preToolUse('tab', `mcp__harv__browser_${tool}`, input, 'h1', signal()))?.permissionDecision).toBe('deny');
  });

  it('never held: cookie banners, plain links, a search', async () => {
    expect(await run('read the news', 'click', { ref: 8 }, 'https://news.example/')).not.toBe('deny');
    expect(await run('read the news', 'click', { ref: 12 })).not.toBe('deny');
    expect(await run('find cats', 'type', { ref: 11, text: 'cats', submit: true })).not.toBe('deny');
    expect(await run('find cats', 'press', { key: 'Tab' })).not.toBe('deny');
  });
});

// The full review, S4: a destructive call runs without asking only when the backup can cover it.
describe('what the backup cannot cover waits for a yes', () => {
  const many = (dir: string, n: number) => {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${i}.txt`), 'x');
    return dir;
  };
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const shell = async (gate: InstanceType<typeof SafetyGate>, command: string, id: string) =>
    decision(await gate.preToolUse('tab', 'Bash', { command }, id, signal()));

  it('too big to back up: held, and a yes lets it run without a backup', async () => {
    writeSettings({ askRisky: false });
    const { gate, store } = setup();
    const big = many(join(userDir, 'big'), 45);
    await gate.setTurn('tab', 'tidy up');
    const out = await shell(gate, `rm -rf "${fwd(big)}"`, 's4a');
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/Held \(#1\).*Too big to back up/s);
    expect(store.get('s4a')?.status).toBe('blocked');
    await gate.setTurn('tab', 'yes');
    expect((await shell(gate, `rm -rf "${fwd(big)}"`, 's4b'))?.permissionDecision).toBe('allow');
  });

  it.each(['rm -rf $X', 'ls old | xargs rm', 'find . -name "*.bak" -delete'])('cannot see what it deletes: %s', async (command) => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    await gate.setTurn('tab', 'tidy up');
    const out = await shell(gate, command, 's4c');
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/can't see what it deletes/);
  });

  it('a turn nobody typed is told nobody is here', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    expect((await shell(gate, 'rm -rf $X', 's4d'))?.permissionDecisionReason).toMatch(/Nobody is here/);
  });

  it('runs: rebuildable folders, small files, what it can follow', async () => {
    writeSettings({ askRisky: false });
    const { gate, store } = setup();
    await gate.setTurn('tab', 'tidy up');
    const nm = many(join(userDir, 'app', 'node_modules'), 45);
    expect((await shell(gate, `rm -rf "${fwd(nm)}"`, 's4e'))?.permissionDecision).toBe('allow');
    const small = join(userDir, 'notes-small.txt');
    writeFileSync(small, 'x');
    expect((await shell(gate, `rm "${fwd(small)}"`, 's4f'))?.permissionDecision).toBe('allow');
    expect(store.get('s4f')?.backups).toContain(small);
    const out = join(userDir, 'out.txt');
    writeFileSync(out, 'x');
    expect((await shell(gate, `f="${fwd(out)}"; rm "$f"`, 's4g'))?.permissionDecision).toBe('allow');
    expect((await shell(gate, 'tmp=$(mktemp -d); rm -rf "$tmp"', 's4h'))?.permissionDecision).toBe('allow');
  });
});

// The full review, S10: "Try harder", a typed /command and the continue after a limit reset are the
// user's turns, not "nobody is here".
describe('a turn resumed without a new message is still the user being there', () => {
  it('holds for the user, not for the report', async () => {
    writeSettings({ askRisky: false });
    const { gate } = setup();
    await gate.setTurn('tab', 'clean the build folder');
    gate.turnEnded('tab');
    gate.resumeTurn('tab', 'clean the build folder');
    const out = decision(await gate.preToolUse('tab', 'Bash', { command: 'rm -rf $X' }, 's10', signal()));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/needs the user's yes/);
    expect(out?.permissionDecisionReason).not.toMatch(/Nobody is here/);
  });
});

// The user's report note, 2026-11-17: Harv says what he'll do before running anything.
describe('say first, then the tools', () => {
  it('sends the first tool call back once when Harv has said nothing yet, then lets it run', async () => {
    const { gate } = setup();
    gate.sayFirst = true;
    await gate.setTurn('sf', 'how many files are in my workspace?');
    expect(gate.saysFirst('sf', 'Bash')).toBe(true);
    const first = decision(await gate.preToolUse('sf', 'Bash', { command: 'ls' }, 'sf1', signal()));
    expect(first?.permissionDecision).toBe('deny');
    expect(first?.permissionDecisionReason).toMatch(/^\[Say first\] Not run yet: first tell the user/);
    // Once is enough, even when he still says nothing.
    expect(gate.saysFirst('sf', 'Bash')).toBe(false);
    const again = decision(await gate.preToolUse('sf', 'Bash', { command: 'ls' }, 'sf2', signal()));
    expect(again?.permissionDecision).not.toBe('deny');
  });

  it('lets the call run when Harv spoke first, and never asks unattended turns, questions or plans', async () => {
    const { gate } = setup();
    gate.sayFirst = true;
    await gate.setTurn('sp', 'list my files');
    gate.spoke('sp');
    expect(gate.saysFirst('sp', 'Bash')).toBe(false);
    await gate.setTurn('sp', 'list them again');
    expect(gate.saysFirst('sp', 'AskUserQuestion')).toBe(false);
    expect(gate.saysFirst('sp', 'TodoWrite')).toBe(false);
    // A hand-off and a scheduled task: nobody to tell.
    await gate.setTurn('sh', '[Handed over] do it', false);
    expect(gate.saysFirst('sh', 'Bash')).toBe(false);
    await gate.setTurn('ss', 'daily check', true, undefined, true);
    expect(gate.saysFirst('ss', 'Bash')).toBe(false);
    // Off (tests, by default): nothing is sent back.
    const { gate: off } = setup();
    await off.setTurn('o', 'list my files');
    expect(off.saysFirst('o', 'Bash')).toBe(false);
  });
});

describe("working on the user's own other computer (the Windows debloat chat, 2026-11-22)", () => {
  const reg = (host: string) =>
    `ssh ${host} "New-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection' -Name AllowTelemetry -Value 0 -PropertyType DWord -Force"`;

  it('a yes stays for the retry when the connection dropped before anything ran there', async () => {
    writeSettings({ myComputers: ['laptopwin'] });
    const { gate } = setup();
    await gate.setTurn('w', 'check the log there');
    const cmd = { command: reg('someone@officepc') };
    expect(decision(await gate.preToolUse('w', 'PowerShell', cmd, 'c1', signal()))?.permissionDecision).toBe('deny');
    expect(await gate.setTurn('w', 'yes')).toMatch(/said yes to: #1/);
    expect(decision(await gate.preToolUse('w', 'PowerShell', cmd, 'c2', signal()))?.permissionDecision).toBe('allow');
    gate.failed('c2', 'Exit code 255\nConnection reset by 100.64.0.9 port 22');
    expect(decision(await gate.preToolUse('w', 'PowerShell', cmd, 'c3', signal()))?.permissionDecision).toBe('allow');
    // A real failure there spends it.
    gate.failed('c3', 'Exit code 1\nNew-ItemProperty : Access denied');
    expect(decision(await gate.preToolUse('w', 'PowerShell', cmd, 'c4', signal()))?.permissionDecision).toBe('deny');
  });

  it("on the user's own computer the judge reads their earlier messages and the own-computer rule", async () => {
    writeSettings({ myComputers: ['laptopwin'] });
    const { askedOutright } = await import('./judge.ts');
    vi.mocked(askedOutright).mockClear();
    const { gate } = setup();
    await gate.setTurn('o', 'clean up the windows on my notebook from bloatware');
    await gate.setTurn('o', 'you do it, you have full access');
    await gate.preToolUse('o', 'PowerShell', { command: reg('User@laptopwin') }, 'd1', signal());
    const call = vi.mocked(askedOutright).mock.calls.at(-1)!;
    expect(call[0]).toMatch(/bloatware[\s\S]*full access/);
    expect(call[3]).toBe(true);
    // Another computer: only the last message, the usual rule.
    await gate.preToolUse('o', 'PowerShell', { command: reg('someone@officepc') }, 'd2', signal());
    const other = vi.mocked(askedOutright).mock.calls.at(-1)!;
    expect(other[0]).toBe('you do it, you have full access');
    expect(other[3]).toBe(false);
  });

  // Auto mode (the user, 2026-11-26): the 25–26 Nov holds were all steps of the job he gave ("do 1", "bye").
  it('on this computer too the judge reads the job from earlier messages; a hand-off stays strict', async () => {
    const { askedOutright } = await import('./judge.ts');
    vi.mocked(askedOutright).mockClear();
    const { gate } = setup();
    await gate.setTurn('j', 'speed up the unit-slim list and test it on the emulator');
    await gate.setTurn('j', 'do 1');
    await gate.preToolUse('j', 'Bash', { command: 'pkill -f "tools/unit-slim.sh"; adb -s emulator-5554 emu kill' }, 'k1', signal());
    const call = vi.mocked(askedOutright).mock.calls.at(-1)!;
    expect(call[0]).toMatch(/unit-slim[\s\S]*---\ndo 1$/);
    expect(call[3]).toBe(true);
    // Another chat's hand-off is never the user's yes: only its own text, the outright rule.
    await gate.setTurn('j', '[Handed over] stop the emulator', false);
    await gate.preToolUse('j', 'Bash', { command: 'pkill -f qemu-system' }, 'k2', signal());
    const handed = vi.mocked(askedOutright).mock.calls.at(-1)!;
    expect(handed[0]).toBe('[Handed over] stop the emulator');
    expect(handed[3]).toBe(false);
  });
});
