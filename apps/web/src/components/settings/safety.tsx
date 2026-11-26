import { useEffect, useState } from 'react';
import { type BackupInfo } from '@harv/shared';
import { updateSettings, useSettings } from '../../lib/useHarvSocket.ts';
import { safety } from '../../lib/safetyStore.ts';
import { AddPath, Group, Note, PathList, Slider, Sub, useExample } from './controls.tsx';

export const sizeText = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

/** This device's backups, biggest first, with "keep forever" (the cleanup skips kept ones; the user's wish for the car radio backup). */
export function BackupList() {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [all, setAll] = useState(false);
  const load = () =>
    void fetch('/api/backups')
      .then((r) => r.json() as Promise<{ backups: BackupInfo[] }>)
      .then((r) => setBackups(r.backups))
      .catch(() => setBackups([]));
  useEffect(load, []);
  const keep = (name: string, kept: boolean) =>
    void fetch('/api/backups/keep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, keep: kept }),
    })
      .catch(() => {})
      .finally(load);
  // Restore = that action's Undo; asked once more first, since it puts the old files back over today's.
  const [asking, setAsking] = useState<string | null>(null);
  const restore = (b: BackupInfo) => {
    if (!b.action) return;
    if (asking !== b.name) return setAsking(b.name);
    setAsking(null);
    safety.undo(b.action.id);
    window.setTimeout(load, 1500);
  };
  if (!backups) return null;
  const total = backups.reduce((sum, b) => sum + b.bytes, 0);
  const kept = backups.filter((b) => b.kept);
  // Newest first (pass B, B31): "what was that, and bring it back" is about the latest changes.
  const shown = all ? backups : backups.filter((b, i) => b.kept || i < 5);
  const date = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const what = (b: BackupInfo) => {
    const first = b.originals[0]?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'backup';
    return b.originals.length > 1 ? `${first} +${b.originals.length - 1}` : first;
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Note>
        {backups.length} on this device, {sizeText(total)}
        {kept.length > 0 && `; ${kept.length} kept forever (${sizeText(kept.reduce((s, b) => s + b.bytes, 0))}, not counted in the limit)`}.
        Keep one and it’s never deleted.
      </Note>
      {shown.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
          {shown.map((b) => (
            <li key={b.name} className="flex min-w-0 items-center gap-2 rounded-lg bg-black/15 py-1 pr-1 pl-2.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate" title={b.action?.summary ?? b.originals.join('\n')}>
                  {b.action?.summary ?? what(b)}
                </span>
                <span className="truncate text-[11px] text-faint" title={b.originals.join('\n')}>
                  {date(b.at)} · {sizeText(b.bytes)}
                  {b.action ? ` · ${what(b)}` : ''}
                </span>
              </span>
              {b.action?.canUndo && (
                <button
                  type="button"
                  title="Put these files back the way they were before this change (the action's Undo)"
                  onClick={() => restore(b)}
                  className={`min-h-7 flex-none cursor-pointer rounded border px-2 text-[11px] hover:bg-white/10 ${
                    asking === b.name ? 'border-warn/60 text-warn' : 'border-line text-muted'
                  }`}
                >
                  {asking === b.name ? 'yes, restore' : 'restore'}
                </button>
              )}
              <button
                type="button"
                aria-pressed={b.kept}
                title={b.kept ? 'Kept forever. Click to let the cleanup delete it when it’s old.' : 'Keep this backup forever'}
                onClick={() => keep(b.name, !b.kept)}
                className={`min-h-7 flex-none cursor-pointer rounded border px-2 text-[11px] hover:bg-white/10 ${
                  b.kept ? 'border-accent/60 text-accent' : 'border-line text-muted'
                }`}
              >
                {b.kept ? 'kept' : 'keep'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {backups.length > shown.length || all ? (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="min-h-7 cursor-pointer self-start px-1 text-[11px] text-muted hover:text-ink"
        >
          {all ? 'show fewer' : `show all ${backups.length}`}
        </button>
      ) : null}
    </div>
  );
}

export function ProtectedFolders() {
  const example = useExample('C:\\Users\\you\\Documents\\Taxes', '/home/you/Documents/Taxes');
  const { protectedPaths } = useSettings();
  return (
    <Sub title="Read-only folders">
      <Note>Harv can read these freely, but asks you in the chat before changing, moving or deleting anything inside them.</Note>
      <PathList
        items={protectedPaths.map((p) => ({ key: p, path: p, label: `Remove ${p}` }))}
        onRemove={(p) => updateSettings({ protectedPaths: protectedPaths.filter((x) => x !== p) })}
      />
      <AddPath
        id="harv-protect"
        label="Folder to protect"
        placeholder={example}
        onAdd={(path) => updateSettings({ protectedPaths: [...protectedPaths, path] })}
      />
    </Sub>
  );
}

/** The user's own other computers: SSH, scp and Taildrop there is their own work, not sending to someone. */
export function MyComputers() {
  const { myComputers } = useSettings();
  return (
    <Sub title="My other computers">
      <Note>
        Your own computers Harv works on over SSH (their Tailscale names). Copying files there isn’t sending to someone, and a job you asked
        for there covers its steps. Other devices on your tailnet don’t count.
      </Note>
      <PathList
        items={myComputers.map((c) => ({ key: c, path: c, label: `Remove ${c}` }))}
        onRemove={(c) => updateSettings({ myComputers: myComputers.filter((x) => x !== c) })}
      />
      <AddPath
        id="harv-my-computer"
        label="Computer to add"
        placeholder="laptop"
        onAdd={(name) => updateSettings({ myComputers: [...new Set([...myComputers, name.toLowerCase()])] })}
      />
    </Sub>
  );
}

/** Harv's settings, shown as a tab in the chat bar. Saved in ~/.harv/settings.json and applied at once in every window. */

export function SafetySection() {
  const settings = useSettings();
  return (
    <>
      <Group
        title="Safety"
        hint="Three things never happen: per-token billing, reading your login secrets, wiping the system disk. What can’t simply be undone waits in the chat for your yes. Everything else runs, backed up, with Undo."
      >
        <Sub title="Backups">
          <Note>Every change Harv makes is backed up first, so Undo can bring it back. Older backups are deleted, oldest first.</Note>
          <Slider
            label="Keep for"
            value={settings.backupDays}
            min={7}
            max={180}
            unit=" days"
            onChange={(backupDays) => updateSettings({ backupDays })}
          />
          <Slider
            label="At most"
            value={settings.backupMaxGb}
            min={1}
            max={50}
            unit=" GB"
            onChange={(backupMaxGb) => updateSettings({ backupMaxGb })}
          />
          <BackupList />
        </Sub>
        <ProtectedFolders />
        <MyComputers />
      </Group>
    </>
  );
}
