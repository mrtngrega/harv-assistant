import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RouteStore } from '../store/routes.ts';
import { cleanSummary, cleanTitle, parseClassification } from './classifier.ts';
import { Router, THREE_TRIES_NOTE } from './router.ts';
import { instantRules, isFollowUp, isSignOff, parseOverride, saysStillWrong } from './rules.ts';
import { pickFor, stepUp, tag, type Classification } from './table.ts';

const c = (difficulty: Classification['difficulty'], extra: Partial<Classification> = {}): Classification => ({
  category: 'question',
  difficulty,
  stakes: 'normal',
  ambiguous: false,
  ...extra,
});

function newRouter(classify: (text: string, ...rest: unknown[]) => Promise<Classification | null> = vi.fn(async () => c(3))) {
  const log = new RouteStore(join(mkdtempSync(join(tmpdir(), 'harv-routes-')), 'harv.db'));
  // Never the real ~/.harv/memory in tests.
  const memories = () => [{ name: 'smartwatches', about: 'the smartwatch hunt' }];
  return { router: new Router(log, classify, undefined, undefined, undefined, memories), classify, log };
}

describe('table', () => {
  it('maps difficulty to model·effort, tuned for Pro', () => {
    expect(([1, 2, 3, 4, 5] as const).map((d) => tag(pickFor(c(d)).pick))).toEqual([
      'sonnet·medium',
      'sonnet·medium',
      'sonnet·medium',
      'opus·medium',
      'opus·high',
    ]);
    expect(tag(pickFor(c(3, { category: 'code' })).pick)).toBe('sonnet·high');
  });

  // The user's wish (2026-11-18): research on medium guessed instead of checking.
  it('gives research sonnet·high from difficulty 2, but not a simple fact', () => {
    expect(tag(pickFor(c(2, { category: 'research' })).pick)).toBe('sonnet·high');
    expect(tag(pickFor(c(3, { category: 'web search' })).pick)).toBe('sonnet·high');
    expect(tag(pickFor(c(3, { category: 'comparison' })).pick)).toBe('sonnet·high');
    expect(tag(pickFor(c(1, { category: 'research' })).pick)).toBe('sonnet·medium');
    expect(tag(pickFor(c(2, { category: 'research', simple: true })).pick)).toBe('haiku·medium');
    expect(tag(pickFor(c(4, { category: 'research' })).pick)).toBe('opus·medium');
  });

  // The user's rule (2026-11-11): Haiku only for really simple things; unsure or ambiguous gets Sonnet.
  it('gives Haiku only what is really simple and clear', () => {
    expect(tag(pickFor(c(1, { simple: true })).pick)).toBe('haiku·medium');
    expect(tag(pickFor(c(2, { simple: true })).pick)).toBe('haiku·medium');
    expect(tag(pickFor(c(1, { simple: true, ambiguous: true })).pick)).toBe('sonnet·medium');
    expect(tag(pickFor(c(2, { category: 'explain' })).pick)).toBe('sonnet·medium');
    expect(tag(pickFor(c(3, { simple: true })).pick)).toBe('sonnet·medium');
  });

  it('uses Fable for difficulty 5 only when allowed', () => {
    expect(tag(pickFor(c(5), undefined, true).pick)).toBe('fable·high');
    expect(tag(pickFor(c(4), undefined, true).pick)).toBe('opus·medium');
  });

  it('pushes high stakes one step up, up to opus·medium (the user, 2026-11-22)', () => {
    expect(tag(pickFor(c(2, { stakes: 'high', simple: true })).pick)).toBe('sonnet·medium');
    expect(tag(pickFor(c(3, { stakes: 'high' })).pick)).toBe('sonnet·high');
    expect(tag(pickFor(c(3, { stakes: 'high', category: 'code' })).pick)).toBe('opus·medium');
    // The Windows debloat chat: pc-task, difficulty 4, high stakes ran on opus·high throughout.
    expect(tag(pickFor(c(4, { stakes: 'high', category: 'pc-task' })).pick)).toBe('opus·medium');
    expect(tag(pickFor(c(5, { stakes: 'high' })).pick)).toBe('opus·high');
  });

  it('trims effort on easy work late in the week, never on hard work', () => {
    expect(tag(pickFor(c(3), 75).pick)).toBe('sonnet·low');
    expect(tag(pickFor(c(4), 95).pick)).toBe('opus·medium');
    expect(tag(pickFor(c(3), 50).pick)).toBe('sonnet·medium');
    // Never below haiku·medium (the user's floor).
    expect(tag(pickFor(c(1, { simple: true }), 95).pick)).toBe('haiku·medium');
  });

  it('climbs the ladder from any pick, manual ones included', () => {
    expect(tag(stepUp({ model: 'sonnet', effort: 'medium' })!)).toBe('sonnet·high');
    expect(tag(stepUp({ model: 'sonnet', effort: 'low' })!)).toBe('sonnet·medium');
    expect(tag(stepUp({ model: 'haiku', effort: 'max' })!)).toBe('sonnet·medium');
    expect(tag(stepUp({ model: 'sonnet', effort: 'high' })!)).toBe('opus·medium');
    expect(tag(stepUp({ model: 'opus', effort: 'medium' })!)).toBe('opus·high');
    expect(stepUp({ model: 'fable', effort: 'high' })).toBeNull();
    expect(stepUp({ model: 'opus', effort: 'max' })).toBeNull();
    expect(tag(stepUp({ model: 'opus', effort: 'max' }, true)!)).toBe('fable·high');
    expect(tag(stepUp({ model: 'fable', effort: 'high' }, true)!)).toBe('fable·max');
  });
});

describe('rules', () => {
  it('parses /model and /effort overrides at the start', () => {
    expect(parseOverride('/opus /max fix it')).toEqual({ model: 'opus', effort: 'max', text: 'fix it' });
    expect(parseOverride('/high explain')).toEqual({ model: undefined, effort: 'high', text: 'explain' });
    expect(parseOverride('see /opus later')).toEqual({ model: undefined, effort: undefined, text: 'see /opus later' });
    expect(parseOverride('/usage')).toEqual({ model: undefined, effort: undefined, text: '/usage' });
  });

  it('sends small talk to Haiku, and a PC action gets at least sonnet·high (review S22, Q6)', () => {
    expect(instantRules('thanks!', [])).toMatchObject({ kind: 'decide', pick: { model: 'haiku', effort: 'medium' } });
    expect(instantRules('uninstall the old Java packages', [])).toMatchObject({
      kind: 'floor',
      pick: { model: 'sonnet', effort: 'high' },
    });
    expect(instantRules('remove the comma from this sentence', [])).toBeNull();
  });

  // The full review, S21: ordinary words aren't "still wrong"; the phrases still are.
  it('hears "still wrong" in phrases, not in ordinary words', () => {
    for (const ok of [
      'urob to zase pre druhy subor',
      'stále používam starý názov, premenuj to',
      'nejde mi o to, chcem iba zoznam',
      'furt lepsie',
      'do the same thing for the other file',
    ])
      expect(saysStillWrong(ok), ok).toBe(false);
    for (const bad of ['stále nefunguje', 'zase nejde', 'furt to isté', 'nejde to', 'still broken', 'same problem', 'it doesnt work'])
      expect(saysStillWrong(bad), bad).toBe(true);
  });

  it('treats a sign-off as a wrap-up (memory, learn-from-session), not small talk for Haiku', () => {
    for (const bye of ['bye', 'Bye!', 'bye harv', 'goodbye', 'good night', "I'm done for today", 'see you tomorrow'])
      expect(instantRules(bye, [])).toMatchObject({ kind: 'decide', pick: { model: 'sonnet' }, why: 'wrapping up' });
    expect(isSignOff('bye, and also fix the build')).toBe(false);
    expect(instantRules('hi', [])).toMatchObject({ pick: { model: 'haiku' } });
  });

  it('puts a floor under code and large files', () => {
    const file = { id: 'f', name: 'main.py', size: 100, mime: 'text/x-python' };
    expect(instantRules('what does this do?', [file])).toMatchObject({ kind: 'floor', pick: { model: 'sonnet', effort: 'high' } });
  });

  // The Word chat (2026-11-10): Haiku lost its way on the desktop; acting in an app gets at least Sonnet.
  it('puts a Sonnet floor under work on the desktop', () => {
    for (const ask of [
      'open word and type hello',
      'click the Send button in Discord',
      'otvor word a napíš ahoj',
      'klikni na tlačidlo Uložiť',
      'switch to Brave and scroll down',
    ])
      expect(instantRules(ask, []), ask).toMatchObject({
        kind: 'floor',
        pick: { model: 'sonnet', effort: 'medium' },
        why: 'work on your desktop',
      });
    for (const not of ['what is a window function in SQL', 'type annotations in python', 'open question: why is the sky blue'])
      expect(instantRules(not, []), not).toBeNull();
  });

  // Connectors plan K2: a mail or calendar turn reads other people's text and picks among many tools.
  it('puts a Sonnet floor under mail and calendar', () => {
    for (const ask of [
      "what's new in my mail?",
      'check my email',
      'put the dentist in my calendar for Tuesday',
      'any invites this week?',
      'prišla mi nejaká pošta?',
      'čo mám v kalendári zajtra?',
      'pozri schránku',
    ])
      expect(instantRules(ask, []), ask).toMatchObject({
        kind: 'floor',
        pick: { model: 'sonnet', effort: 'medium' },
        why: 'your mail or calendar',
      });
    for (const not of ['what does a mailbox rule do in exchange', 'the mailman came late', 'hello'])
      expect(instantRules(not, [])?.why, not).not.toBe('your mail or calendar');
  });

  it('treats short replies soon after as follow-ups', () => {
    const now = Date.now();
    expect(isFollowUp('and the other one?', [], now - 60_000, now)).toBe(true);
    expect(isFollowUp('and the other one?', [], now - 60 * 60_000, now)).toBe(false);
    expect(isFollowUp('new question: how do tides work', [], now - 60_000, now)).toBe(false);
    expect(isFollowUp('x'.repeat(400), [], now - 60_000, now)).toBe(false);
  });
});

describe('classifier reply', () => {
  it('reads the JSON, even wrapped in prose', () => {
    expect(parseClassification('Sure: {"category":"code","difficulty":4,"stakes":"high","ambiguous":false}')).toEqual({
      category: 'code',
      difficulty: 4,
      stakes: 'high',
      ambiguous: false,
      simple: false,
    });
    expect(parseClassification('{"difficulty": 9}')).toBeNull();
    expect(parseClassification('no idea')).toBeNull();
  });

  it('keeps a tidy short title', () => {
    expect(parseClassification('{"category":"planning","difficulty":3,"stakes":"normal","title":"\\"Week plan.\\""}')?.title).toBe(
      'Week plan',
    );
    expect(cleanTitle('  GPU   driver\nupdate ')).toBe('GPU driver update');
    // At most 3 words (the user, 2026-11-20): a longer suggestion is no name, a long 3-word one is cut.
    expect(cleanTitle('A very long title that goes on and on forever')).toBeUndefined();
    expect(cleanTitle('PS5 rental for GTA6')).toBeUndefined();
    expect(cleanTitle('Slovak classifieds RWD-car-hunting')).toHaveLength(28);
    expect(cleanTitle('')).toBeUndefined();
    expect(cleanTitle(42)).toBeUndefined();
  });

  it('keeps the chat summary on one line, capped, and drops unusable ones', () => {
    const reply = '{"category":"planning","difficulty":3,"stakes":"normal","summary":" Planned the\\nweek;  Friday left. "}';
    expect(parseClassification(reply)?.summary).toBe('Planned the week; Friday left.');
    expect(cleanSummary('x'.repeat(300))).toHaveLength(200);
    expect(cleanSummary('ok')).toBeUndefined();
    expect(cleanSummary(null)).toBeUndefined();
  });
});

describe('router', () => {
  it('asks the classifier once, then reuses the decision for follow-ups', async () => {
    const { router, classify } = newRouter(vi.fn(async () => c(4)));
    const first = await router.route('t', 'Plan the migration of my photo library to the NAS with dedup');
    expect(first.decision).toMatchObject({ model: 'opus', effort: 'medium', source: 'classifier' });
    const next = await router.route('t', 'ok and what about raw files?');
    expect(next.decision).toMatchObject({ model: 'opus', effort: 'medium', source: 'followup' });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  // The Win11 install chat (2026-11-09): a long reply plus time in the BIOS, then "done" went to the classifier as chat d1 → haiku.
  it('counts the follow-up window from the end of the last turn, not its start', async () => {
    vi.useFakeTimers();
    try {
      const { router, classify } = newRouter(vi.fn(async () => c(4)));
      await router.route('long', 'Make a Windows 11 USB stick and set up dual boot with Fedora');
      vi.advanceTimersByTime(30 * 60 * 1000); // the reply runs for half an hour
      router.finished('long', true, false);
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect((await router.route('long', 'done')).decision).toMatchObject({ model: 'opus', source: 'followup' });
      expect(classify).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the classifier’s title on, and the current title to the classifier', async () => {
    const classify = vi.fn(async () => ({ ...c(3), title: 'Week plan' }));
    const { router } = newRouter(classify);
    const r = await router.route('t', 'Plan my week around the deadlines in notes.md', [], 'Old name');
    expect(r.title).toBe('Week plan');
    expect(classify).toHaveBeenCalledWith(
      'Plan my week around the deadlines in notes.md',
      [],
      undefined,
      'Old name',
      undefined,
      expect.any(Array),
      expect.any(Array),
    );
    // Follow-ups skip the classifier, so they don't rename.
    expect((await router.route('t', 'and Friday?')).title).toBeUndefined();
  });

  // Chat summaries (docs/PLAN.md §6c): one more field in the call that already names the chat, no extra call.
  it('passes the classifier’s summary on, and the current summary to the classifier', async () => {
    const classify = vi.fn(async () => ({ ...c(3), title: 'Week plan', summary: 'Planning the week around three deadlines.' }));
    const { router } = newRouter(classify);
    const r = await router.route('t', 'Plan my week around the deadlines in notes.md', [], 'Old name', {
      summary: 'Earlier: notes cleanup.',
    });
    expect(r.summary).toBe('Planning the week around three deadlines.');
    expect(classify).toHaveBeenCalledWith(
      'Plan my week around the deadlines in notes.md',
      [],
      undefined,
      'Old name',
      'Earlier: notes cleanup.',
      expect.any(Array),
      expect.any(Array),
    );
    expect((await router.route('t', 'and Friday?')).summary).toBeUndefined();
  });

  it('doesn’t let small talk replace the task decision', async () => {
    const { router } = newRouter(vi.fn(async () => c(4)));
    await router.route('t', 'Write a careful plan for my thesis chapters');
    expect((await router.route('t', 'thanks')).decision.model).toBe('haiku');
    expect((await router.route('t', 'and chapter 3?')).decision).toMatchObject({ model: 'opus', source: 'followup' });
  });

  it('skips the classifier for overrides and strips them', async () => {
    const { router, classify } = newRouter();
    const r = await router.route('t', '/sonnet /low hello there friend');
    expect(r).toMatchObject({ decision: { model: 'sonnet', effort: 'low', source: 'override' }, text: 'hello there friend' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('falls back to the default when the classifier fails, respecting floors', async () => {
    const { router } = newRouter(vi.fn(async () => null));
    expect((await router.route('t', 'explain black holes')).decision).toMatchObject({
      model: 'sonnet',
      effort: 'medium',
      source: 'fallback',
    });
    const code = await router.route('u', '```js\nconsole.log(1)\n```');
    expect(code.decision).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('steps up after a failed turn, and on Try harder', async () => {
    const { router, log } = newRouter(vi.fn(async () => c(3)));
    await router.route('t', 'Summarise the attached report for me');
    router.finished('t', false, false);
    expect((await router.route('t', 'try again')).decision).toMatchObject({ model: 'sonnet', effort: 'high', source: 'followup' });
    router.finished('t', true, false);
    expect(router.harder('t', { model: 'sonnet', effort: 'high' })).toMatchObject({ model: 'opus', effort: 'medium', source: 'harder' });
    expect(router.harder('t', { model: 'opus', effort: 'max' })).toBeNull();
    expect(log.split().find((r) => r.model === 'sonnet' && r.effort === 'high')).toMatchObject({ harder: 1 });
  });
});

describe('router fixes (2026-10-24)', () => {
  it('classifies a short "now do X" again when the chat started light', async () => {
    const classify = vi.fn(async (text: string) =>
      text.startsWith('we continue') ? c(2, { category: 'chat', simple: true }) : c(4, { category: 'code' }),
    );
    const { router } = newRouter(classify);
    expect(tag((await router.route('w', 'we continue on harv project, where did we end')).decision)).toBe('haiku·medium');
    const r = await router.route('w', 'do the startup prompt then gimme your ideas');
    expect(classify).toHaveBeenCalledTimes(2);
    expect(r.decision).toMatchObject({ model: 'opus', source: 'classifier' });
    // Reactions to the answer still reuse the pick.
    expect((await router.route('w', 'and the other tab too?')).decision.source).toBe('followup');
  });

  // Changed by the full review, S17 (the user's OK, Q7): new work in a task is classified again, never below the task.
  it('classifies new work in a task again, keeping at least the task’s pick', async () => {
    const classify = vi.fn(async () => c(3, { category: 'code' }));
    const { router } = newRouter(classify);
    const first = (await router.route('k', 'Refactor the settings loader to validate every field')).decision;
    const next = (await router.route('k', 'now add tests for the new validation too')).decision;
    expect(classify).toHaveBeenCalledTimes(2);
    expect(tag(next)).toBe(tag(first));
    // Not new work ("why?", "does it work now?"): the task's pick, no call.
    await router.route('k', 'ok, why did you pick that name?');
    await router.route('k', 'does it look right to you now?');
    expect(classify).toHaveBeenCalledTimes(2);
  });

  // The full review, S17, with its five messages.
  it('lets a project chat climb for bigger work, and never lets a follow-up drop the task', async () => {
    const levels = [c(2), c(5), c(5)];
    const classify = vi.fn(async () => levels.shift() ?? c(2));
    const { router } = newRouter(classify);
    const p = { project: true };
    expect(tag((await router.route('pj', "what's the state of the sync code?", [], undefined, p)).decision)).toBe('sonnet·high');
    expect(
      tag(
        (await router.route('pj', 'now redesign the whole sync engine around a hub, with live sync and full tests', [], undefined, p))
          .decision,
      ),
    ).toBe('opus·high');
    expect(tag((await router.route('pj', 'implement the hub server and migrate both devices to it', [], undefined, p)).decision)).toBe(
      'opus·high',
    );

    const hard = vi.fn(async () => c(5));
    const { router: r2 } = newRouter(hard);
    expect(tag((await r2.route('n', 'Work out why my build pipeline deadlocks under load and fix it')).decision)).toBe('opus·high');
    hard.mockImplementation(async () => c(2));
    expect(tag((await r2.route('n', 'open the result in explorer')).decision)).toBe('opus·high');
    expect(tag((await r2.route('n', 'check my mail for the receipt too')).decision)).toBe('opus·high');
  });

  it('gives project work at least sonnet·high, but not small talk', async () => {
    const { router } = newRouter(vi.fn(async () => c(1, { simple: true })));
    expect(tag((await router.route('p', 'what does this function return', [], undefined, { project: true })).decision)).toBe('sonnet·high');
    expect(tag((await router.route('p2', 'thanks', [], undefined, { project: true })).decision)).toBe('haiku·medium');
    expect(tag((await router.route('p3', 'what does this function return')).decision)).toBe('haiku·medium');
  });

  it('passes the last lines of the chat to the classifier', async () => {
    const classify = vi.fn(async () => c(2));
    const { router } = newRouter(classify);
    await router.route('r', 'Plan the release notes for version two', [], undefined, { recent: 'User: hi\nHarv: hello' });
    expect(classify).toHaveBeenCalledWith(
      'Plan the release notes for version two',
      [],
      'User: hi\nHarv: hello',
      undefined,
      undefined,
      expect.any(Array),
      expect.any(Array),
    );
  });

  it('learns from "Try harder": a kind of task that keeps needing more starts a step up', async () => {
    const { router } = newRouter(vi.fn(async () => c(2, { category: 'writing', simple: true })));
    for (const tab of ['a', 'b']) {
      const first = await router.route(tab, 'Write a short note to my landlord about the heating');
      router.harder(tab, first.decision);
    }
    const next = await router.route('c', 'Write a short note to my neighbour about the party');
    expect(tag(next.decision)).toBe('sonnet·medium');
    expect(next.decision.reason).toMatch(/try harder on 2 similar tasks/);
  });
});

describe('stepping up a struggling reply (2026-10-29)', () => {
  it('goes one step up the ladder and says from what and why', () => {
    const { router } = newRouter();
    const up = router.struggling('s', { model: 'sonnet', effort: 'medium' }, 'the tests failed');
    expect(up).toMatchObject({ model: 'sonnet', effort: 'high', source: 'stepup' });
    expect(up!.reason).toBe('↑ stepped up from sonnet·medium: the tests failed');
  });

  it("never climbs past opus·high by itself (the user's ceiling, 2026-11-11; above it is Try harder)", () => {
    const { router } = newRouter();
    expect(router.struggling('s', { model: 'opus', effort: 'medium' }, 'x')).toMatchObject({ model: 'opus', effort: 'high' });
    expect(router.struggling('s', { model: 'opus', effort: 'high' }, 'x')).toBeNull();
    expect(router.struggling('s', { model: 'opus', effort: 'xhigh' }, 'x')).toBeNull();
    expect(router.struggling('s', { model: 'opus', effort: 'max' }, 'x')).toBeNull();
  });

  it("the task keeps the higher pick, so a follow-up doesn't drop back", async () => {
    const { router, classify } = newRouter();
    await router.route('f', 'fix the failing build in my project please', []);
    router.struggling('f', { model: 'sonnet', effort: 'medium' }, 'the build failed');
    (classify as ReturnType<typeof vi.fn>).mockClear();
    const next = await router.route('f', 'ok go on', []);
    expect(next.decision).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  describe('drops back once the task works again (the user’s rule, 2026-11-09)', () => {
    const start = async () => {
      const r = newRouter();
      const first = await r.router.route('d', 'fix the failing build in my project please', []);
      expect(first.decision).toMatchObject({ model: 'sonnet', effort: 'medium' });
      return r;
    };

    it('a reply that ends well after a step-up returns the follow-ups to the task’s own pick', async () => {
      const { router } = await start();
      router.struggling('d', { model: 'sonnet', effort: 'medium' }, 'the build failed');
      router.struggling('d', { model: 'sonnet', effort: 'high' }, 'the tests failed');
      router.finished('d', true, false);
      const next = await router.route('d', 'ok go on', []);
      expect(next.decision).toMatchObject({ model: 'sonnet', effort: 'medium', source: 'followup' });
      expect(next.decision.reason).toContain('works again');
      // Struggling again later steps up from there, and drops back to the same pick.
      router.struggling('d', { model: 'sonnet', effort: 'medium' }, 'the build failed');
      router.finished('d', true, false);
      const again = (await router.route('d', 'and now?', [])).decision;
      expect(again).toMatchObject({ model: 'sonnet', effort: 'medium' });
      // The reason doesn't nest a new layer each round (it was three deep in the log, 2026-11-21).
      expect(again.reason.match(/works again/g)).toHaveLength(1);
      expect(again.reason.match(/same task/g)).toHaveLength(1);
    });

    it('keeps the higher pick while it still fails: an error, a stop, or a last tool call that failed', async () => {
      for (const [ok, stopped, troubled] of [
        [false, false, false],
        [true, true, false],
        [true, false, true],
      ] as const) {
        const { router } = await start();
        router.struggling('d', { model: 'sonnet', effort: 'medium' }, 'the build failed');
        router.finished('d', ok, stopped, undefined, troubled);
        const next = await router.route('d', 'ok go on', []);
        expect(next.decision.effort === 'high' || next.decision.model === 'opus').toBe(true);
      }
    });

    it('never drops below what the task ran at, and a task without a step-up stays as it is', async () => {
      const { router } = await start();
      router.finished('d', true, false);
      expect((await router.route('d', 'ok go on', [])).decision).toMatchObject({ model: 'sonnet', effort: 'medium' });
      router.struggling('d', { model: 'sonnet', effort: 'medium' }, 'x');
      router.finished('d', true, false);
      const back = (await router.route('d', 'ok go on', [])).decision;
      expect(back).toMatchObject({ model: 'sonnet', effort: 'medium' });
    });
  });
});

describe('the struggle watch says whether the reply ended with a failure', () => {
  it('troubled follows the last tool result', async () => {
    const { StruggleWatch } = await import('./struggle.ts');
    const w = new StruggleWatch();
    w.toolUse('1', 'npm test');
    w.toolResult('1', true, 'Tests: 2 failed');
    expect(w.troubled).toBe(true);
    w.toolUse('2', 'grep foo x');
    w.toolResult('2', true, '');
    expect(w.troubled).toBe(false);
    w.toolUse('3', 'npm test');
    w.toolResult('3', false, 'Tests: 2 failed');
    expect(w.troubled).toBe(true);
    w.toolUse('4', 'npm test');
    w.toolResult('4', false, 'Tests: 40 passed');
    expect(w.troubled).toBe(false);
    w.toolResult('5', true, 'Edit failed');
    expect(w.troubled).toBe(true);
    w.reset();
    expect(w.troubled).toBe(false);
  });
});

describe('the user saying it still doesn’t work, and a bare yes (2026-11-11)', () => {
  it('"still wrong" in an ongoing task steps up once per message, never past opus·high', async () => {
    const { router } = newRouter(vi.fn(async () => c(3)));
    await router.route('w', 'Make the file explorer show folders first, then files');
    const first = await router.route('w', 'still wrong');
    expect(first.decision).toMatchObject({ model: 'sonnet', effort: 'high', source: 'stepup' });
    expect(first.decision.reason).toMatch(/still doesn't work/);
    expect(tag((await router.route('w', 'nefunguje to')).decision)).toBe('opus·medium');
    expect(tag((await router.route('w', 'zase to isté')).decision)).toBe('opus·high');
    expect(tag((await router.route('w', 'still not working')).decision)).toBe('opus·high');
  });

  it('after the third "still wrong" the turn is told to stop unless it tries something truly different (pass C, C12)', () => {
    const { router } = newRouter();
    const t0 = Date.now();
    expect(router.tries('t', 'Make the explorer show folders first', t0)).toBe('');
    expect(router.tries('t', 'still wrong', t0 + 60_000)).toBe('');
    expect(router.tries('t', 'nefunguje', t0 + 120_000)).toBe('');
    // A detail in between doesn't start over.
    expect(router.tries('t', 'the folders are at the bottom', t0 + 150_000)).toBe('');
    expect(router.tries('t', 'zase to isté', t0 + 180_000)).toBe(THREE_TRIES_NOTE);
    expect(router.tries('t', 'still not working', t0 + 240_000)).toBe(THREE_TRIES_NOTE);
    // A new task (after the follow-up window) starts over; so does a "still wrong" long after.
    expect(router.tries('t', 'Now write me a poem about autumn', t0 + 2 * 3600_000)).toBe('');
    expect(router.tries('t', 'still wrong', t0 + 2 * 3600_000 + 60_000)).toBe('');
    // Other chats count on their own.
    expect(router.tries('u', 'still wrong', t0)).toBe('');
  });

  it('a bare "yes" stays on the task’s model; in a fresh chat it is small talk', async () => {
    const { router } = newRouter(vi.fn(async () => c(4)));
    await router.route('y', 'Plan the database migration for the new schema');
    expect((await router.route('y', 'yes')).decision).toMatchObject({ model: 'opus', effort: 'medium', source: 'followup' });
    expect((await router.route('y', 'jo')).decision).toMatchObject({ model: 'opus', source: 'followup' });
    expect(tag((await router.route('fresh', 'yes')).decision)).toBe('haiku·medium');
    expect(tag((await router.route('fresh2', 'ahoj')).decision)).toBe('haiku·medium');
  });
});

// Siri gave up at 8 s on nearly every question (2026-11-14): spoken turns skip the classifier.
describe('spoken messages (Siri, voice mode)', () => {
  const spoken = { spoken: true };
  it('never ask the classifier: Sonnet by default, the instant rules still count', async () => {
    const { router, classify } = newRouter();
    expect((await router.route('s1', 'When does my weekly limit reset', [], undefined, spoken)).decision).toMatchObject({
      model: 'sonnet',
      effort: 'medium',
      source: 'rule',
    });
    expect(tag((await router.route('s2', 'thanks', [], undefined, spoken)).decision)).toBe('haiku·medium');
    expect(tag((await router.route('s3', 'delete the files in my downloads folder', [], undefined, spoken)).decision)).toBe('sonnet·high');
    expect(tag((await router.route('s4', 'open discord on my pc and check who is online', [], undefined, spoken)).decision)).toBe(
      'sonnet·medium',
    );
    expect(classify).not.toHaveBeenCalled();
  });

  it('keep the user’s own /opus', async () => {
    const { router } = newRouter();
    expect(tag((await router.route('s5', '/opus what is the plan for today', [], undefined, spoken)).decision)).toBe('opus·high');
  });
});

describe('the gate sending a call back to say first is not a failure', () => {
  it('does not count it toward a step-up', async () => {
    const { StruggleWatch } = await import('./struggle.ts');
    const w = new StruggleWatch();
    const say = "[Say first] Not run yet: first tell the user in one short sentence what you're about to do.";
    expect(w.toolResult('a', true, say)).toBeNull();
    w.toolUse('b', 'mkdir /locked/a');
    expect(w.toolResult('b', true, 'Permission denied')).toBeNull();
    expect(w.toolResult('c', true, say)).toBeNull();
    w.toolUse('d', 'mkdir /locked/b');
    // Only now two real failures in a row.
    expect(w.toolResult('d', true, 'Permission denied')).toMatch(/2 tool calls failed/);
  });
});

describe('skills (the user, 2026-11-19: Harv uses them when they are needed)', () => {
  it('keeps only a skill from the list it was given', () => {
    const reply = '{"category":"research","difficulty":3,"stakes":"normal","skill":"research"}';
    expect(parseClassification(reply, ['research', 'teach'])?.skill).toBe('research');
    expect(parseClassification(reply, ['teach'])?.skill).toBeUndefined();
    expect(parseClassification('{"category":"chat","difficulty":1,"stakes":"low","skill":"none"}', ['research'])?.skill).toBeUndefined();
  });

  it('gives the classifier the chat kind of skills, and a new task its skill, a follow-up none', async () => {
    const classify = vi.fn(async () => c(3, { category: 'research', skill: 'research' }));
    const { router } = newRouter(classify);
    const first = await router.route('t', 'find me a cheap rear-wheel-drive car under 700 euros in Slovakia');
    expect(first.skill).toBe('research');
    const names = (classify.mock.calls[0] as unknown[])[5] as { name: string }[];
    expect(names.some((s) => s.name === 'research')).toBe(true);
    expect(names.some((s) => s.name === 'tdd')).toBe(false); // project chats only
    const next = await router.route('t', 'and the second one?');
    expect(next.skill).toBeUndefined();
  });
});

describe('memory notes by topic (the user, 2026-11-20: "knows everything that is needed at the right time")', () => {
  it('keeps only notes from the list it was given, once each', () => {
    const reply = '{"category":"research","difficulty":3,"stakes":"normal","memories":["smartwatches","made-up","smartwatches",4]}';
    expect(parseClassification(reply, [], ['smartwatches', 'cars'])?.memories).toEqual(['smartwatches']);
    expect(parseClassification('{"category":"chat","difficulty":1,"stakes":"low","memories":[]}', [], ['cars'])?.memories).toBeUndefined();
    expect(parseClassification(reply)?.memories).toBeUndefined();
  });

  it('gives the classifier the topic notes and a new task the notes it named, a follow-up none', async () => {
    const classify = vi.fn(async () => c(3, { category: 'research', memories: ['smartwatches'] }));
    const { router } = newRouter(classify);
    const first = await router.route('t', 'which of the two should I buy then, compare them properly');
    expect(first.memories).toEqual(['smartwatches']);
    expect((classify.mock.calls[0] as unknown[])[6]).toEqual([{ name: 'smartwatches', about: 'the smartwatch hunt' }]);
    const next = await router.route('t', 'and the second one?');
    expect(next.memories).toBeUndefined();
  });
});
