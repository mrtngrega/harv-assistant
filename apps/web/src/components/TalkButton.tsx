import { useEffect, useState } from 'react';
import { chat, getChatState } from '../lib/chatStore.ts';
import { getDraftTexts, setDraftText } from '../lib/drafts.ts';
import { getConnection, subscribeConnection } from '../lib/useHarvSocket.ts';
import { speakReplyIn } from '../lib/voice.ts';
import { clearTalkError, getTalk, onHeard, startTalk, stopTalk, subscribeTalk, useTalk, voiceReach, type VoiceReach } from '../lib/talk.ts';

// The mic in harv> (docs/review/voice-plan.md V1b): click, talk, click; the words land in the line
// to read before sending. The app's hold key (Ctrl+Alt+Space) sends what it heard at once.

onHeard((text, by) => {
  if (by === 'phone') return; // voice mode (lib/voice.ts) takes its own words
  if (!text) {
    chat.noticeInActive('Harv didn’t catch anything.');
    return;
  }
  if (by === 'key') {
    // A spoken turn (short replies), read aloud in Harv's voice when this computer has it.
    const tabId = chat.ensureTab();
    const busy = !!getChatState().tabs.find((t) => t.id === tabId)?.busy;
    chat.send(text, [], true);
    speakReplyIn(tabId, text, busy);
    return;
  }
  const tabId = chat.ensureTab();
  const now = getDraftTexts()[tabId] ?? '';
  setDraftText(tabId, now.trim() ? `${now.trimEnd()} ${text}` : text);
  const input = document.getElementById('harv-cmd') as HTMLTextAreaElement | null;
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
});

// A microphone that didn't start or a clip Whisper couldn't read: one line in the chat on screen.
subscribeTalk(() => {
  const { error } = getTalk();
  if (!error) return;
  clearTalkError();
  chat.noticeInActive(error);
});

/**
 * Whether Harv can hear here (Settings › Voice, or through the other computer), checked when the window
 * comes back, and every 20 s while the other computer is away (the mic comes back by itself).
 */
function useVoiceReach(): VoiceReach {
  const [reach, setReach] = useState<VoiceReach>({ state: 'none' });
  useEffect(() => {
    let state: VoiceReach['state'] = 'none';
    const check = () =>
      void voiceReach().then((r) => {
        state = r.state;
        setReach(r);
      });
    check();
    // Only while the other computer is away and the window is seen: it polled in every state, in the tray too (the full review, U27).
    const timer = window.setInterval(() => {
      if (state === 'away' && !document.hidden) check();
    }, 20_000);
    window.addEventListener('focus', check);
    // After a restart of Harv (the first check may have run while the server was away).
    let was = getConnection().connected;
    const off = subscribeConnection(() => {
      const now = getConnection().connected;
      if (now && !was) check();
      was = now;
    });
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      off();
    };
  }, []);
  return reach;
}

export function TalkButton({ className }: { className: string }) {
  const reach = useVoiceReach();
  const { stage, by } = useTalk();
  if (reach.state === 'none') return null;
  if (reach.state === 'away') {
    // Voice goes through the other computer and it can't be reached (the user's choice: greyed, with a note).
    const note = `Voice needs ${reach.name}: it can’t be reached right now`;
    return (
      <button
        type="button"
        disabled
        aria-label={note}
        title={note}
        className={`grid cursor-not-allowed place-items-center rounded-[10px] border border-[rgb(220_232_245/0.12)] px-2.5 text-muted opacity-40 ${className}`}
      >
        <MicIcon />
      </button>
    );
  }
  const busy = stage !== 'off';
  const label =
    stage === 'recording'
      ? by === 'key'
        ? 'Listening (let go of Ctrl+Alt+Space to send)'
        : 'Listening: click when done'
      : stage === 'hearing'
        ? 'Hearing you…'
        : 'Talk (click, speak, click), or hold Ctrl+Alt+Space anywhere to talk and send';
  return (
    <button
      type="button"
      onClick={() => {
        if (stage === 'off') void startTalk('button');
        else if (stage === 'recording' && by === 'button') void stopTalk();
      }}
      aria-label={label}
      aria-pressed={busy}
      title={label}
      className={`grid cursor-pointer place-items-center rounded-[10px] border px-2.5 ${className} ${
        stage === 'recording'
          ? 'animate-pulse-ring border-accent/70 bg-accent/25 text-accent'
          : stage === 'hearing'
            ? 'border-accent/40 bg-accent/10 text-accent'
            : 'border-[rgb(220_232_245/0.2)] text-muted hover:bg-white/10 hover:text-ink'
      }`}
    >
      {stage === 'hearing' ? (
        <span aria-hidden="true" className="w-4 text-center">
          …
        </span>
      ) : (
        <MicIcon />
      )}
    </button>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15" strokeLinecap="round" />
    </svg>
  );
}
