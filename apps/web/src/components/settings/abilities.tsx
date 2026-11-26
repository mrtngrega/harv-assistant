import { useEffect, useState } from 'react';
import { ENGLISH_ONLY } from '../../lib/speak.ts';
import { Icon } from '../tools/explorer/icons.tsx';
import { cancelSchedule, useSchedules, whenText } from '../../lib/scheduleStore.ts';
import { useChat } from '../../lib/chatStore.ts';
import { updateSettings, useConnection, useSettings } from '../../lib/useHarvSocket.ts';
import { BUTTON, Choice, Group, LABEL, Note, ROW, Sub, Toggle } from './controls.tsx';

/** Harv's scheduled tasks on this device: what runs when, in which chat, and Cancel. */
export function ScheduledTasks() {
  const tasks = useSchedules();
  const { tabs } = useChat();
  const time = (ms: number) =>
    new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <Sub title="Scheduled tasks">
      <Note>
        Ask Harv in any chat (“every morning at 8 tell me the weather”, “check the build in an hour”). Each run is a turn in that chat, on
        this device while Harv is on; one missed while it was off runs once when it starts. Each run uses your plan.
      </Note>
      {tasks.length === 0 ? (
        <Note>Nothing scheduled.</Note>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((t) => (
            <li key={t.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5 text-xs">
              <span className="text-accent">⏰</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink" title={t.prompt}>
                  {t.title}
                </span>
                <span className="block truncate text-[11px] text-faint">
                  {whenText(t)} · next {t.nextAt ? time(t.nextAt) : '—'} · in “{tabs.find((x) => x.id === t.tabId)?.title ?? 'its chat'}”
                </span>
              </span>
              <button
                type="button"
                onClick={() => cancelSchedule(t.id)}
                className="flex-none cursor-pointer rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-white/10 hover:text-warn"
              >
                cancel
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sub>
  );
}

/** Pictures from Gemini: signing Harv's own Chrome profile in to the Google account kept for it (docs/PLAN.md §6w). */
export function Pictures() {
  const [status, setStatus] = useState<string | null>(null);
  const open = async () => {
    setStatus('Opening…');
    try {
      const res = await fetch('/api/gemini/signin', { method: 'POST' });
      const body = (await res.json()) as { error?: string };
      setStatus(res.ok ? 'Sign in in the Chrome window, then close it.' : (body.error ?? 'Couldn’t open Chrome.'));
    } catch {
      setStatus('Couldn’t reach the Harv server.');
    }
  };
  return (
    <Sub title="Pictures">
      <Note>
        Ask Harv for a picture in any chat and Gemini makes it, on the Google account you sign in with here (once per computer, in a Chrome
        window of Harv’s own). The free Gemini app has a daily limit.
      </Note>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void open()}
          className="min-h-9 cursor-pointer rounded-lg border border-accent/50 px-3 text-xs text-accent hover:bg-accent/15"
        >
          Sign in to Gemini
        </button>
        {status && <span className="text-xs text-muted">{status}</span>}
      </div>
    </Sub>
  );
}

/** Settings › Watchdog: on/off and the programs it ignores (alerts show as toasts, not here). */
export function Watchdog() {
  const { watchdog, watchdogIgnored } = useSettings();
  const onWindows = useConnection().platform === 'windows';
  return (
    <Sub title="Watchdog">
      <Toggle
        on={watchdog}
        label="Watch my PC"
        hint={
          onWindows
            ? 'Warns about overheating, hidden programs hogging the CPU or GPU, Windows Defender threats, miners and remote-control tools. No Claude usage.'
            : 'Warns about overheating, miners, remote-control tools and programs from /tmp that keep working. No Claude usage.'
        }
        onChange={(on) => updateSettings({ watchdog: on })}
      />
      {watchdogIgnored.length > 0 && (
        <div className={ROW}>
          <span className={LABEL}>Never warns about</span>
          <div className="flex flex-1 flex-wrap gap-1.5">
            {watchdogIgnored.map((app) => (
              <span key={app} className="inline-flex items-center gap-1 rounded-md border border-line bg-white/5 py-0.5 pr-0.5 pl-2">
                {app}
                <button
                  type="button"
                  aria-label={`Warn about ${app} again`}
                  onClick={() => updateSettings({ watchdogIgnored: watchdogIgnored.filter((x) => x !== app) })}
                  className="size-5 cursor-pointer rounded text-muted hover:bg-white/10"
                >
                  <Icon name="close" size={12} className="mx-auto block" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </Sub>
  );
}

export interface DesktopStatus {
  available: boolean;
  installed: boolean;
  installing: boolean;
  /** What the install brings (Windows-MCP or agent-desktop). */
  needs?: string;
  error?: string;
  /** The PC's monitors once installed; `work`: the one Harv works on. */
  monitors?: { device: string; label: string; size: string; work: boolean }[];
}

/** Settings › Desktop control (Windows): chats may read the screen and use the mouse and keyboard (docs/PLAN.md §6t item 1). */
export function DesktopControl() {
  const { desktopControl, desktopScreen } = useSettings();
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const load = () =>
    fetch('/api/desktop')
      .then((r) => r.json() as Promise<DesktopStatus>)
      .then(setStatus)
      .catch(() => setStatus(null));
  useEffect(() => {
    void load();
  }, []);
  // While it installs, check every 2 s until it's done.
  useEffect(() => {
    if (!status?.installing) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [status?.installing]);
  if (!status?.available) return null;
  const install = () =>
    fetch('/api/desktop/install', { method: 'POST' })
      .then((r) => r.json() as Promise<DesktopStatus>)
      .then(setStatus)
      .catch(() => {});
  return (
    <Sub title="Desktop control">
      <Toggle
        on={desktopControl}
        label="Let Harv use my mouse and keyboard"
        hint="Chats can read the screen, click, type and switch windows. When your message says what to do on the desktop, Harv just does it; a risky step you didn't ask for (sending, buying, deleting, a password field) waits in the chat for your yes. Scheduled tasks never can. Off by default."
        onChange={(on) => updateSettings({ desktopControl: on })}
      />
      {desktopControl && !status.installed && (
        <>
          {status.needs && <Note>{status.needs}</Note>}
          <div className="flex items-center gap-3">
            <button type="button" className={BUTTON} disabled={status.installing} onClick={() => void install()}>
              {status.installing ? 'Installing…' : 'Install'}
            </button>
            {status.error && <span className="text-xs text-warn">Install failed: {status.error}</span>}
          </div>
        </>
      )}
      {desktopControl && status.installed && <Note>Installed. Chats pick it up with their next message.</Note>}
      {desktopControl && status.installed && (status.monitors?.length ?? 0) > 1 && (
        <>
          <Choice
            label="Works on"
            value={desktopScreen || status.monitors!.find((m) => m.work)?.device || ''}
            options={status.monitors!.map((m) => ({ value: m.device, label: `${m.label.replace(' · main', '')} ${m.size}` }))}
            onChange={(device) => {
              updateSettings({ desktopScreen: device });
              setStatus((s) => (s?.monitors ? { ...s, monitors: s.monitors.map((m) => ({ ...m, work: m.device === device })) } : s));
            }}
          />
          <Note>
            Harv looks at and works on this monitor only (the smallest until you pick). It uses another one only when your message names it,
            like “on the left monitor”.
          </Note>
        </>
      )}
    </Sub>
  );
}

interface SpeechStatus {
  installed: boolean;
  installing: boolean;
  converts: boolean;
  error?: string;
}

interface VoiceStatus {
  installed: boolean;
  installing: boolean;
  running: 'cuda' | 'cpu' | null;
  error?: string;
  speech?: SpeechStatus;
}

/** Settings › Voice: Whisper on this computer for recordings and videos (docs/review/voice-plan.md V1a). */
export function VoiceSettings() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const call = (path: string, method = 'GET') =>
    fetch(path, { method })
      .then((r) => r.json() as Promise<VoiceStatus>)
      .then(setStatus)
      .catch(() => setStatus(null));
  useEffect(() => {
    void call('/api/voice');
  }, []);
  const speechCall = (path: string) =>
    fetch(path, { method: 'POST' })
      .then(() => call('/api/voice'))
      .catch(() => {});
  const installing = !!status?.installing || !!status?.speech?.installing;
  // While something installs, check every 2 s until it's done.
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => void call('/api/voice'), 2000);
    return () => clearInterval(timer);
  }, [installing]);
  if (!status) return null;
  return (
    <Sub title="Voice">
      {!status.installed ? (
        <>
          <Note>
            Speech to text on this computer (Whisper, Slovak and English): Harv can turn recordings and videos into text or subtitles. It
            downloads up to 4 GB once (the model, and on Windows the graphics card’s libraries), is free, and nothing you say leaves the
            computer.
          </Note>
          <div className="flex items-center gap-3">
            <button type="button" className={BUTTON} disabled={status.installing} onClick={() => void call('/api/voice/install', 'POST')}>
              {status.installing ? 'Installing… (a few minutes)' : 'Install'}
            </button>
            {status.error && <span className="text-xs text-warn">Install failed: {status.error}</span>}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <Note>
            <b className="font-medium text-ink">Hearing</b> (speech to text, Whisper): installed.{' '}
            {status.running
              ? `Loaded on the ${status.running === 'cuda' ? 'graphics card' : 'processor'}.`
              : 'Not loaded (it starts when needed).'}
          </Note>
          <button type="button" className={`${BUTTON} ml-auto shrink-0`} onClick={() => void call('/api/voice/remove', 'POST')}>
            Remove
          </button>
        </div>
      )}
      {status.speech && <HarvVoice speech={status.speech} onCall={speechCall} />}
    </Sub>
  );
}

/** Harv's own voice (voice plan V2): Piper, and on the PC the Slovak man's voice by Seed-VC. */
function HarvVoice({ speech, onCall }: { speech: SpeechStatus; onCall: (path: string) => Promise<void> }) {
  if (!speech.installed)
    return (
      <>
        <Note>
          Harv’s voice: he reads his reply aloud when you talked to him (the talk key or the phone’s voice mode). English in a British man’s
          voice;{' '}
          {ENGLISH_ONLY
            ? 'English only for now (Slovak comes later).'
            : speech.converts
              ? 'Slovak in the same man’s voice, made on the graphics card. Downloads about 4 GB once.'
              : 'Slovak in Piper’s woman’s voice (this computer has no graphics card for the man’s). Downloads about 150 MB once.'}{' '}
          Free, and nothing leaves the computer.
        </Note>
        <div className="flex items-center gap-3">
          <button type="button" className={BUTTON} disabled={speech.installing} onClick={() => void onCall('/api/voice/speech/install')}>
            {speech.installing ? 'Installing Harv’s voice… (several minutes)' : 'Install Harv’s voice'}
          </button>
          {speech.error && <span className="text-xs text-warn">Install failed: {speech.error}</span>}
        </div>
      </>
    );
  return (
    <div className="flex items-center gap-3">
      <Note>
        <b className="font-medium text-ink">Speaking</b> (Harv’s voice): installed.{' '}
        {ENGLISH_ONLY
          ? 'English only for now.'
          : speech.converts
            ? 'Slovak in the same man’s voice while the graphics card is free.'
            : 'Slovak in Piper’s woman’s voice.'}
      </Note>
      <button type="button" className={`${BUTTON} ml-auto shrink-0`} onClick={() => void onCall('/api/voice/speech/remove')}>
        Remove
      </button>
    </div>
  );
}

export function AbilitiesSection() {
  return (
    <>
      {/* What Harv does beyond the chat (pass B, B24), then the device's own settings. */}
      <Group title="What Harv can do">
        <DesktopControl />
        <VoiceSettings />
        <Pictures />
        {(
          <>
          </>
        )}
        <Watchdog />
        <ScheduledTasks />
      </Group>
    </>
  );
}
