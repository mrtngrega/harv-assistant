import { useEffect, useState, type KeyboardEvent } from 'react';
import { comboOf, desktop, inApp, type AppSettings, type UpdateInfo } from '../../lib/desktop.ts';
import { updateSettings, useConnection, useSettings } from '../../lib/useHarvSocket.ts';
import { BUTTON, Group, LABEL, Note, ROW, Sub, TextSetting, Toggle, useExample } from './controls.tsx';

export function WorkFolder() {
  const example = useExample('C:\\Users\\you\\Projects', '/home/you/Projects');
  const { workDir } = useSettings();
  return (
    <Sub title="Default folder">
      <Note>Where new terminals and the file explorer open, and where Harv works when you don’t say where. Empty = your home folder.</Note>
      <TextSetting id="harv-workdir" label="Folder" value={workDir} placeholder={example} onSave={(v) => updateSettings({ workDir: v })} />
    </Sub>
  );
}

/** Restarts the Harv server (to load changes to its own code); the page reconnects by itself. */
export function RestartButton() {
  const [state, setState] = useState<'idle' | 'asking' | 'restarting'>('idle');
  if (state === 'restarting') return <Note>Restarting… the page reconnects in a few seconds.</Note>;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        onClick={() => {
          if (state === 'idle') return setState('asking');
          setState('restarting');
          void fetch('/api/restart', { method: 'POST' }).catch(() => {});
        }}
        className={`${BUTTON} ${state === 'asking' ? 'border-warn/60 text-warn' : ''}`}
      >
        {state === 'asking' ? 'Yes, restart now' : 'Restart Harv'}
      </button>
      <span className="text-[11px] text-faint">
        {state === 'asking'
          ? 'A reply in progress stops; tabs, drafts and terminals come back.'
          : 'Needed after Harv changes his own code.'}
      </span>
    </div>
  );
}

/** The desktop app's own settings (this device only, ~/.harv/app.json): hotkey, autostart, updates. */
export function AppSection() {
  const [app, setApp] = useState<AppSettings | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState<'checking' | 'updating' | null>(null);

  useEffect(() => {
    desktop.settings().then(setApp, () => {});
  }, []);

  const change = (patch: { hotkey?: string; autostart?: boolean }) => {
    setError(null);
    desktop.setSettings(patch).then(setApp, (e: unknown) => setError(String(e)));
  };
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    if (e.key === 'Escape') return setRecording(false);
    const combo = comboOf(e);
    if (!combo) return;
    setRecording(false);
    change({ hotkey: combo });
  };
  const run = (what: 'checking' | 'updating') => {
    setUpdating(what);
    setError(null);
    (what === 'checking' ? desktop.checkUpdates() : desktop.applyUpdate())
      .then(setUpdate, (e: unknown) => setError(String(e)))
      .finally(() => setUpdating(null));
  };

  return (
    <Sub title="App">
      {!app ? (
        <Note>Reading the app’s settings…</Note>
      ) : (
        <>
          <div className={ROW}>
            <span className={LABEL}>Hotkey</span>
            {app.hotkeyWorks ? (
              <button
                type="button"
                title="Brings Harv up from anywhere, ready to type; again hides it"
                onClick={() => setRecording(true)}
                onKeyDown={recording ? onKey : undefined}
                onBlur={() => setRecording(false)}
                className={`${BUTTON} ${recording ? 'border-accent text-accent' : ''}`}
              >
                {recording ? 'Press the keys…' : app.hotkey}
              </button>
            ) : (
              <span className="text-faint">{app.hotkey}, set in KDE’s System Settings › Shortcuts.</span>
            )}
          </div>
          <Toggle
            on={app.autostart}
            label="Open Harv when I log in"
            hint="Starts in the tray, ready for the hotkey."
            onChange={(autostart) => change({ autostart })}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {update && update.behind > 0 ? (
              <button type="button" disabled={!!updating || update.dirty} onClick={() => run('updating')} className={BUTTON}>
                {updating === 'updating' ? 'Updating…' : `Update (${update.behind} new)`}
              </button>
            ) : (
              <button type="button" disabled={!!updating} onClick={() => run('checking')} className={BUTTON}>
                {updating === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            )}
            <span className="text-[11px] text-faint">
              {update?.error ??
                (update?.dirty && update.behind > 0
                  ? 'Harv’s folder has uncommitted changes; the update waits for them.'
                  : update && update.behind === 0
                    ? 'Up to date.'
                    : `App ${app.version}. Never updates by itself.`)}
            </span>
          </div>
          {error && <Note warn>{error}</Note>}
        </>
      )}
    </Sub>
  );
}

export function ComputerSection() {
  const settings = useSettings();
  const platform = useConnection().platform;
  const onWindows = platform === 'windows';
  return (
    <>
      <Group title="This computer" hint="These stay on this device.">
        <Sub title="Startup">
          <Toggle
            on={settings.restoreTabs}
            label="Reopen tabs"
            hint="After a restart, bring back the tabs, their files and terminals, and unsent messages."
            onChange={(restoreTabs) => updateSettings({ restoreTabs })}
          />
          {onWindows && (
            <Toggle
              on={settings.startSensors}
              label="Start the hardware sensors"
              hint="Starts LibreHardwareMonitor with Harv (Windows asks first). Off: no temperatures or fans until you press Start sensors."
              onChange={(startSensors) => updateSettings({ startSensors })}
            />
          )}
          <RestartButton />
        </Sub>
        {inApp && <AppSection />}
        <WorkFolder />
      </Group>
    </>
  );
}
