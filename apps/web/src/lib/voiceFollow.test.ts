import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@harv/shared';

// The talk key's spoken question sent while the chat is mid-reply (the full review, K13): the running
// reply isn't read from the middle, and the answer to the spoken question is.

const listeners: ((msg: ServerMessage) => void)[] = [];
vi.mock('./socket.ts', () => ({
  onServerMessage: (fn: (msg: ServerMessage) => void) => {
    listeners.push(fn);
    return () => {};
  },
  sendMessage: () => true,
}));
const spoken: string[] = [];
vi.mock('./speak.ts', () => ({
  isSpeaking: () => false,
  localSpeechReady: () => Promise.resolve(true),
  sentencesOf: (t: string) => [t],
  speakSentences: (s: string[]) => void spoken.push(...s),
  stopSpeaking: () => {},
  subscribeSpeaking: () => () => {},
  unlockAudio: () => {},
}));

const { speakReplyIn, spokenTurnStarts } = await import('./voice.ts');
const emit = (msg: unknown) => listeners.forEach((fn) => fn(msg as ServerMessage));
const started = (tabId: string) => emit({ type: 'chat.started', tabId, model: 'sonnet', effort: 'medium', auto: true, reason: '' });
const reply = (tabId: string, text: string) => {
  emit({ type: 'chat.delta', tabId, text });
  emit({ type: 'chat.assistant', tabId, text });
  emit({ type: 'chat.done', tabId });
};

describe('speaking the answer to a question asked mid-reply', () => {
  beforeEach(() => {
    spoken.length = 0;
  });

  it('knows the spoken turn has started once its message left the queue', () => {
    expect(spokenTurnStarts('what time is it', ['what time is it'])).toBe(false);
    expect(spokenTurnStarts('what time is it', ['other'])).toBe(true);
    expect(spokenTurnStarts('what time is it', [])).toBe(true);
  });

  it('stays quiet through the running reply and a typed message queued before it', () => {
    speakReplyIn('t1', 'what time is it', true);
    emit({
      type: 'chat.queued',
      tabId: 't1',
      items: [
        { id: 'a', text: 'typed first' },
        { id: 'b', text: 'what time is it' },
      ],
    });
    reply('t1', 'The long typed reply goes on.');
    emit({ type: 'chat.queued', tabId: 't1', items: [{ id: 'b', text: 'what time is it' }] });
    started('t1');
    reply('t1', 'Answer to the typed one.');
    emit({ type: 'chat.queued', tabId: 't1', items: [] });
    started('t1');
    reply('t1', 'It is nine.');
    expect(spoken.join(' ')).toBe('It is nine.');
  });

  // 2026-11-17: words spoken mid-reply go into the running reply; the work between isn't read aloud.
  it('reads only the "got it" and the last line when the words went into the running reply', () => {
    speakReplyIn('t3', 'make it blue', true);
    emit({ type: 'chat.queued', tabId: 't3', items: [{ id: 'c', text: 'make it blue', handed: true }] });
    emit({ type: 'chat.assistant', tabId: 't3', text: 'Now editing the header styles.' });
    emit({ type: 'chat.queued', tabId: 't3', items: [] });
    emit({ type: 'chat.line', tabId: 't3', line: { kind: 'you', text: 'make it blue' } });
    emit({ type: 'chat.assistant', tabId: 't3', text: 'Got it, blue it is.' });
    emit({ type: 'chat.assistant', tabId: 't3', text: 'Checking the build now.' });
    emit({ type: 'chat.assistant', tabId: 't3', text: '## Done\n\n- header 24px\n\nThe header is bigger and blue now.' });
    emit({ type: 'chat.done', tabId: 't3' });
    expect(spoken).toEqual(['Got it, blue it is.', 'The header is bigger and blue now.']);
  });

  it('follows "start a new chat and …" into the new chat', () => {
    speakReplyIn('t4', 'start a new chat and check the weather', true);
    emit({ type: 'chat.assistant', tabId: 't4', text: 'Old chat keeps working.' });
    emit({ type: 'chat.opened', chat: { id: 't5', title: 'Check the weather', lines: [] }, focus: false, movedFrom: 't4' });
    started('t5');
    reply('t5', 'It is sunny.');
    reply('t4', 'Old chat done.');
    expect(spoken.join(' ')).toBe('It is sunny.');
  });

  it('follows at once when the chat was free', () => {
    speakReplyIn('t2', 'hello', false);
    started('t2');
    reply('t2', 'Hi there.');
    expect(spoken.join(' ')).toBe('Hi there.');
  });
});
