import { describe, expect, it } from 'vitest';
import { newChatTask } from './newChat.ts';

describe('"start a new chat and …" (docs/PLAN.md §6ac)', () => {
  it('catches the ways the user asks, typed or spoken, with the task after it', () => {
    expect(newChatTask('start a new chat and look up the weather in Bratislava')).toBe('Look up the weather in Bratislava');
    expect(newChatTask('Hey Harv, open another chat to check my email')).toBe('Check my email');
    expect(newChatTask('harv, can you start a new conversation about the car radio')).toBe('The car radio');
    expect(newChatTask('Start a separate chat: find a cheap flight to Rome.')).toBe('Find a cheap flight to Rome.');
    expect(newChatTask('in a new chat, summarise this video')).toBe('Summarise this video');
    expect(newChatTask('new chat: plan my week')).toBe('Plan my week');
    expect(newChatTask('please start one more new chat where you check the lights')).toBe('You check the lights');
  });

  it('just opens one when nothing follows', () => {
    expect(newChatTask('start a new chat')).toBe('');
    expect(newChatTask('Open a new chat please.')).toBe('');
    expect(newChatTask('okay, start another chat.')).toBe('');
  });

  it('understands Slovak too (push-to-talk hears Slovak)', () => {
    expect(newChatTask('otvor nový chat a zisti počasie')).toBe('Zisti počasie');
    expect(newChatTask('Harv, začni nový rozhovor o aute')).toBe('Aute');
    expect(newChatTask('v novom chate pozri moje maily')).toBe('Pozri moje maily');
  });

  it('leaves everything else alone: additions, code work, the browser, old chats', () => {
    for (const msg of [
      'use blue instead',
      'also check the logs',
      'add a new chat button to the sidebar',
      'start a new chat feature in the app',
      'make a new tab for the settings',
      'open a new tab and go to youtube',
      'open the chat about the car radio',
      'open a chat about the radio',
      'why does starting a new chat take so long?',
      'the new chat: it has no title',
      '/fresh',
      '',
    ])
      expect(newChatTask(msg), msg).toBeNull();
  });
});
