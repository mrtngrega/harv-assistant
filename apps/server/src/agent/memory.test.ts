import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  forget,
  listMemories,
  matchMemories,
  memoryChanges,
  memoryContext,
  memoryIndex,
  memoryNote,
  memorySnapshot,
  memoryTotal,
  recall,
  recallArgs,
  remember,
  savedText,
  toSlug,
} from './memory.ts';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'harv-memory-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('memory', () => {
  it('slugs names safely', () => {
    expect(toSlug("User's GPU!")).toBe('users-gpu');
    expect(toSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(toSlug('!!!')).toBeNull();
  });

  it('can only write inside the memory folder', () => {
    const dir = tempDir();
    expect(remember('../escape', 'x', dir)).toBe('escape');
    expect(readdirSync(dir)).toEqual(['escape.md']);
  });

  it('saves, replaces and forgets memories', () => {
    const dir = tempDir();
    remember('coding prefs', 'Likes TypeScript.', dir);
    remember('coding-prefs', 'Likes TypeScript and short answers.', dir);
    expect(listMemories(dir).map((m) => [m.name, m.body])).toEqual([['coding-prefs', 'Likes TypeScript and short answers.']]);
    expect(forget('coding prefs', dir)).toBe(true);
    expect(forget('coding prefs', dir)).toBe(false);
    expect(listMemories(dir)).toEqual([]);
  });

  it('rejects oversized memories', () => {
    expect(() => remember('big', 'x'.repeat(2001), tempDir())).toThrow(/under 2000/);
  });

  // 2026-11-20: by topic. Core notes in full, the rest as an index line; nothing is cut, however many there are.
  it('builds the prompt block: core notes in full, an index of the rest', () => {
    const dir = tempDir();
    expect(memoryContext(dir)).toBe('You have no saved memories yet.');
    remember('working-style', 'Do it yourself.', dir);
    remember('user-profile', 'Alex, casual.', dir);
    remember('watch', 'Wants a Garmin under 300 EUR.', dir, { about: 'smartwatch hunt', keys: ['hodin'] });
    remember('pc', 'Ryzen, RTX card.', dir, { always: true });
    for (let i = 0; i < 40; i++) remember(`topic-${i}`, 'x'.repeat(1900), dir, { about: `topic ${i}` });
    const block = memoryContext(dir);
    expect(block.startsWith('Notes go out of date')).toBe(true);
    expect(block.indexOf('### user-profile\nAlex, casual.')).toBeLessThan(block.indexOf('### working-style'));
    expect(block).toContain('### working-style\nDo it yourself.');
    expect(block).toContain('### pc\nRyzen, RTX card.');
    expect(block).not.toContain('Garmin');
    expect(block).toContain('- watch: smartwatch hunt');
    expect(block).toContain('- topic-39: topic 39');
    expect(block).toMatch(/recall/);
    expect(block.length).toBeLessThan(4000);
    expect(memoryIndex(dir).map((m) => m.name)).not.toContain('pc');
  });

  it('keeps core notes within their budget and says so when they outgrow it', () => {
    const dir = tempDir();
    for (let i = 0; i < 5; i++) remember(`core-${i}`, 'x'.repeat(1900), dir, { always: true, about: `core ${i}` });
    const block = memoryContext(dir);
    expect(block).toContain('### core-3');
    expect(block).not.toContain('### core-4');
    expect(block).toContain('- core-4: core 4');
    expect(memoryTotal(dir).fits).toBe(false);
  });

  it('stores about/keys/always in a header and keeps them when an update leaves them out', () => {
    const dir = tempDir();
    remember('cars', 'Corolla 7.', dir, { about: 'the user’s cars', keys: ['car', 'auto'] });
    remember('cars', 'Corolla 7 GTD.', dir);
    const [m] = listMemories(dir);
    expect(m).toMatchObject({ body: 'Corolla 7 GTD.', about: 'the user’s cars', keys: ['car', 'auto'], always: false });
    // Trigger words only grow: a shorter list sent with an update adds, never drops (seen live, 2026-11-20).
    remember('cars', 'Corolla 7 GTD, 120k km.', dir, { keys: ['km', 'car'] });
    expect(listMemories(dir)[0]?.keys).toEqual(['car', 'auto', 'km']);
    // A note without a header is described by its first line.
    remember('plain', 'First line.\nMore.', dir);
    expect(listMemories(dir).find((n) => n.name === 'plain')?.about).toBe('First line.');
  });

  it('matches a message to notes by their keys and name, across languages and word forms', () => {
    const dir = tempDir();
    remember('smartwatches', 'Garmin vs Garmin.', dir, { keys: ['hodin', 'garmin', 'watch'] });
    remember('bike-edit-project', 'Resolve edit.', dir, { keys: ['bike video', 'resolve'] });
    remember('vue-class-project', 'School project.', dir, { keys: ['vue'] });
    const idx = memoryIndex(dir);
    expect(matchMemories('Aké hodinky mi odporúčaš?', idx)).toEqual(['smartwatches']);
    expect(matchMemories('my new Watch broke', idx)).toEqual(['smartwatches']);
    expect(matchMemories('cut the bike video shorter', idx)).toEqual(['bike-edit-project']);
    // A note with keys is matched by its keys only: its name's words were noise (2026-11-21).
    expect(matchMemories('I rode my bike today', idx)).toEqual([]);
    expect(matchMemories('edit this photo', idx)).toEqual([]);
    expect(matchMemories('I played tennis today', idx)).toEqual([]);
    expect(matchMemories('fix the vue router', idx)).toEqual(['vue-class-project']);
    expect(matchMemories('a revue of the film', idx)).toEqual([]);
    expect(matchMemories('what time is it', idx)).toEqual([]);
  });

  it('falls back to the telling words of the name only for a note without keys', () => {
    const dir = tempDir();
    remember('car-search-friends', 'Beater hunt.', dir, { keys: ['beater', 'bazos'] });
    remember('tennis-club', 'Club night on Fridays.', dir);
    const idx = memoryIndex(dir);
    expect(matchMemories('my friend has a ps5', idx)).toEqual([]);
    expect(matchMemories('search the web for it', idx)).toEqual([]);
    expect(matchMemories('any beater on bazos?', idx)).toEqual(['car-search-friends']);
    expect(matchMemories('is the tennis club open?', idx)).toEqual(['tennis-club']);
  });

  const seen = () => ({ shown: new Set<string>(), hinted: new Set<string>() });

  it('puts the picked notes in full in front of a message, once per session', () => {
    const dir = tempDir();
    remember('user-profile', 'Alex.', dir);
    remember('smartwatches', 'Garmin vs Garmin.', dir, { keys: ['watch'] });
    remember('cars', 'Corolla 7.', dir, { keys: ['car'] });
    const s = seen();
    const note = memoryNote('which watch should I get', ['smartwatches', 'cars', 'user-profile', 'nope'], s, dir)!;
    expect(note).toMatch(/### smartwatches \(saved \d{4}-\d\d-\d\d, today\)\nGarmin vs Garmin\./);
    expect(note).toMatch(/### cars \(saved .*\)\nCorolla 7\./);
    expect(note).toMatch(/update it with remember right away/);
    expect(note).not.toContain('Alex');
    expect(note).not.toContain('Maybe in your memory');
    expect(memoryNote('and the watch strap?', ['smartwatches'], s, dir)).toBeNull();
  });

  // 2026-11-26 review of 20–26 Nov: key words alone brought whole notes in wrongly most of the time.
  it('only hints at a note a key word touched, once, and never in place of the full text', () => {
    const dir = tempDir();
    remember('investing', 'ETFs on Trading 212.', dir, { about: 'his investing', keys: ['stock', 'etf'] });
    remember('email', 'Mail rules.', dir, { about: 'how he mails', keys: ['send', 'mail'] });
    remember('harv-gmail', 'Harv has his own Gmail.', dir, { about: "Harv's own Gmail", keys: ['harvs inbox'] });
    const s = seen();
    const hint = memoryNote('the stock volume bar is still there', [], s, dir)!;
    expect(hint).toBe(
      '[Maybe in your memory (a word matched; only if this message is really about its thing, read it with recall, names: ["<name>"]): investing (his investing)]',
    );
    expect(hint).not.toContain('ETFs');
    expect(memoryNote('still the stock bar', [], s, dir)).toBeNull(); // hinted once
    // The classifier picking it later still brings the full text.
    expect(memoryNote('how are my stocks doing?', ['investing'], s, dir)).toContain('ETFs on Trading 212.');
    // Picked and matched at once: full text only, no hint for the same note.
    const both = memoryNote('send Hi on Discord, and did you get my mail?', ['harv-gmail'], s, dir)!;
    expect(both).toContain('Harv has his own Gmail.');
    expect(both).toContain('email (how he mails)');
    expect(both).not.toContain('Mail rules.');
  });

  it('hints nothing for a note recall or an earlier turn already brought in', () => {
    const dir = tempDir();
    remember('cars', 'Corolla 7.', dir, { about: 'his car', keys: ['corolla'] });
    const s = seen();
    s.shown.add('cars');
    expect(memoryNote('my corolla needs tyres', [], s, dir)).toBeNull();
  });

  // 2026-11-20: notes go stale; each carries its date, so Harv sees how old a fact is and fixes it when a chat contradicts it.
  it('dates every save and says how old a note is', () => {
    const dir = tempDir();
    remember('cars', 'Corolla 7.', dir, { about: 'cars' });
    expect(listMemories(dir)[0]?.updated).toBe(new Date().toISOString().slice(0, 10));
    const now = Date.parse('2026-11-20T15:00:00Z');
    expect(savedText('2026-11-01', now)).toBe('saved 2026-11-01, 19 days ago');
    expect(savedText('2026-11-19', now)).toBe('saved 2026-11-19, 1 day ago');
    expect(savedText('2026-11-20', now)).toBe('saved 2026-11-20, today');
    expect(savedText(undefined, now)).toBe('');
  });

  it('recalls notes by name or by words in them', () => {
    const dir = tempDir();
    remember('smartwatches', 'Garmin Forerunner 165 is the pick.', dir);
    remember('cars', 'Corolla 7.', dir);
    expect(recall(['Smartwatches'], undefined, dir).map((m) => m.name)).toEqual(['smartwatches']);
    expect(recall([], 'forerunner pick', dir).map((m) => m.name)).toEqual(['smartwatches']);
    expect(recall([], 'tesla', dir)).toEqual([]);
  });

  // 2026-11-26: Haiku called recall with `query` (and names as one string) and got "no memory matches".
  it('takes the inputs a model guesses: query as a name or words, names as one string', () => {
    const dir = tempDir();
    remember('printer-setup', 'Office printer to install.', dir);
    remember('cars', 'Corolla 7.', dir);
    const names = (n: string[] | string | undefined, s: string | undefined, q: string | undefined) =>
      recall(...recallArgs(n, s, q, dir), dir).map((m) => m.name);
    expect(names(undefined, undefined, 'printer-setup')).toEqual(['printer-setup']);
    expect(names(undefined, undefined, 'office printer')).toEqual(['printer-setup']);
    expect(names('cars', undefined, undefined)).toEqual(['cars']);
    expect(names(['cars'], undefined, 'printer-setup')).toEqual(['cars', 'printer-setup']);
    expect(names(undefined, undefined, '  ')).toEqual([]);
  });

  it('reports what other chats saved, updated or forgot', () => {
    const dir = tempDir();
    remember('pc', 'Ryzen.', dir);
    remember('old', 'Stale fact.', dir);
    const before = memorySnapshot(dir);
    expect(memoryChanges(before, memorySnapshot(dir))).toBeNull();

    remember('pc', 'Ryzen 7 5800X.', dir);
    remember('car', 'Corolla 7.', dir);
    forget('old', dir);
    expect(memoryChanges(before, memorySnapshot(dir))).toBe('- saved "car": Corolla 7.\n- updated "pc": Ryzen 7 5800X.\n- forgot "old"');
  });
});
