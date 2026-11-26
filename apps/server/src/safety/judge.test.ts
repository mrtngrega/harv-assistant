import { describe, expect, it } from 'vitest';
import { askedOutright, onlyAsking, readReply } from './judge.ts';

// A job given earlier doesn't make a later "is it safe?" a yes: the last message only asks (no Haiku call).
describe('the job rule still hears a question as a question', () => {
  it('is false at once when the last message only asks about the step', async () => {
    expect(await askedOutright('clean up my PC\n---\nis it safe to kill the emulator?', 'adb emu kill', undefined, true)).toBe(false);
    expect(await askedOutright('', 'adb emu kill', undefined, true)).toBe(false);
  });
});

// The user's rules for a yes to held actions (2026-11-11): any clear agreement counts, the rest of the
// message is the next instruction; numbers pick items; a clear no drops them; the unclear rest goes to Haiku.
describe('reading the reply to held actions', () => {
  it.each(['yes', 'Yes, and then restart it', 'ok', 'jo', 'áno', 'Áno, a potom reštartuj', 'pokračuj', 'do it', 'sure thing', 'go ahead'])(
    'yes to all: %s',
    (reply) => {
      expect(readReply(reply)).toEqual({ kind: 'yes', items: 'all' });
    },
  );

  it('picks items by number', () => {
    expect(readReply('yes 1 and 3')).toEqual({ kind: 'yes', items: [1, 3] });
    expect(readReply('ok #2')).toEqual({ kind: 'yes', items: [2] });
    expect(readReply('jo 1, 3')).toEqual({ kind: 'yes', items: [1, 3] });
    expect(readReply('yes but not 2')).toEqual({ kind: 'yes', items: 'all', except: [2] });
    expect(readReply('jo okrem 3')).toEqual({ kind: 'yes', items: 'all', except: [3] });
  });

  it.each(['no', 'nope', 'nie', 'wait', "don't", 'not that one', 'zruš to', 'počkaj'])('no: %s', (reply) => {
    expect(readReply(reply)).toEqual({ kind: 'no' });
  });

  it.each(['yes but leave the logs', 'what is the weather', 'hmm maybe later'])('leaves the unclear to the model: %s', (reply) => {
    expect(readReply(reply)).toBeNull();
  });

  // The full review (S5): only a WHOLE short answer is a quick yes or no; "ok stop" was a yes.
  it.each([
    'OK!',
    'ok please',
    'yes harv',
    'sprav to',
    'go ahead.',
    'ok, and now check the logs',
    'jo a teraz zapni svetlo',
    'ok then restart it',
  ])('whole yes, or a yes and the next instruction: %s', (reply) => {
    expect(readReply(reply)).toEqual({ kind: 'yes', items: 'all' });
  });

  it.each(['stop', 'cancel', 'never mind', 'nechaj tak', 'zrus to', '', 'nope'])('whole no: "%s"', (reply) => {
    expect(readReply(reply)).toEqual({ kind: 'no' });
  });

  it.each(['ok?', 'yes?', 'sure?', 'ok so what did you find?'])('a question is unclear: %s', (reply) => {
    expect(readReply(reply)).toEqual({ kind: 'unclear' });
  });

  it.each([
    'ok stop',
    'ok no',
    'ok never mind',
    "ok, don't",
    "ok don't do it",
    'ok skip it',
    'ok wait',
    'ok cancel',
    'ok zrus to',
    'fine, leave it',
    'sure, no',
    'dobre nechaj tak',
    'do it later',
    'ok thanks',
    'aha',
    'go back to the old version',
    'ok 2 things first',
    'no problem, go ahead',
    'nie je problem, sprav to',
    'ok and then stop',
    'jo a potom nie',
    'yes, and do it later',
  ])('never a quick yes or no: %s', (reply) => {
    expect(readReply(reply)).toBeNull();
  });
});

// The Fable playbook (2026-11-13, P2): asking about an action is not asking for it.
describe('a question about an action is never the yes for it', () => {
  it.each([
    'What would happen if I uninstalled Steam?',
    'Is it safe to turn the firewall off?',
    'should I delete the old backups?',
    'Čo by sa stalo, keby som vypol firewall?',
    'Je bezpečné zmazať tie logy?',
    'Mal by som odinštalovať Steam?',
  ])('only asking: %s', (message) => {
    expect(onlyAsking(message)).toBe(true);
  });

  it.each([
    'can you uninstall Steam?',
    'Môžeš odinštalovať Steam?',
    'uninstall Steam',
    'turn the firewall off, then tell me what would happen to the games',
    'what would be nice: uninstall Steam.',
  ])('a request (or left to the model): %s', (message) => {
    expect(onlyAsking(message)).toBe(false);
  });
});
