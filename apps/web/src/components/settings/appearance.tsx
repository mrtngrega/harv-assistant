import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ACCENTS, DEFAULT_SETTINGS, type HarvSettings, type WallpaperInfo } from '@harv/shared';
import { inApp } from '../../lib/desktop.ts';
import { playSound } from '../../lib/sound.ts';
import { updateSettings, useBackground, useConnection, useSettings } from '../../lib/useHarvSocket.ts';
import { BUTTON, Choice, Group, LABEL, Note, ROW, Slider, Sub, Toggle } from './controls.tsx';

export const ACCENT_NAMES: Record<string, string> = {
  '#A8C8E8': 'Ice blue',
  '#9FE0C4': 'Mint',
  '#F2B880': 'Amber',
  '#C9B8F0': 'Lavender',
};

export const LOOK_KEYS = [
  'motion',
  'accent',
  'backgroundBlur',
  'scrim',
  'glass',
  'glassBlur',
  'uiScale',
  'density',
] as const satisfies (keyof HarvSettings)[];

/** The photo: preview, choose, remove. */
export function PhotoPicker() {
  const { version } = useBackground();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  const upload = async (file: File) => {
    setStatus('Uploading…');
    try {
      const res = await fetch('/api/background', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const body = (await res.json()) as { error?: string };
      setStatus(res.ok ? null : (body.error ?? 'Upload failed'));
    } catch {
      setStatus('Upload failed: is the Harv server running?');
    }
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <div
          aria-hidden="true"
          className="h-14 w-24 flex-none rounded-lg border border-line bg-ground bg-cover bg-center"
          style={{ backgroundImage: version ? `url(/api/background?v=${version})` : undefined }}
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => input.current?.click()} className={BUTTON}>
            {version ? 'Change photo…' : 'Choose photo…'}
          </button>
          {version && (
            <button
              type="button"
              onClick={() => void fetch('/api/background', { method: 'DELETE' })}
              className="min-h-9 cursor-pointer rounded-lg px-3 text-xs text-muted hover:bg-white/10"
            >
              Remove
            </button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = '';
        }}
      />
      <Note>{status ?? 'JPEG, PNG or WebP up to 20 MB. It stays on your devices.'}</Note>
    </>
  );
}

/** Settings › Appearance › Background: photo, see-through (the app) or plain, and what each one takes. */
/** Settings › Appearance › Look: the background and the glass panels in one box (pass B, B34); `children` = the panel sliders. */
export function Background({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const onWindows = useConnection().platform === 'windows';
  // In a browser see-through and the wallpaper can't work, so the photo shows: say so instead of hiding the choice.
  const appOnly = (settings.backdrop === 'seeThrough' || settings.backdrop === 'wallpaper') && !inApp;
  const shown = appOnly ? 'photo' : settings.backdrop;
  const [wallpaper, setWallpaper] = useState<WallpaperInfo | null>(null);
  useEffect(() => {
    if (shown !== 'wallpaper') return;
    void fetch('/api/wallpaper/info')
      .then((r) => (r.ok ? (r.json() as Promise<WallpaperInfo>) : null))
      .then(setWallpaper)
      .catch(() => {});
  }, [shown]);
  return (
    <Sub title="Look">
      <Choice
        label="Show"
        value={settings.backdrop}
        options={[
          { value: 'photo', label: 'Photo' },
          { value: 'wallpaper', label: 'Wallpaper' },
          { value: 'seeThrough', label: 'See-through' },
          { value: 'plain', label: 'Plain' },
        ]}
        onChange={(backdrop) => updateSettings({ backdrop })}
      />
      {appOnly && (
        <Note>
          {settings.backdrop === 'wallpaper' ? 'The wallpaper' : 'See-through'} works in the Harv app; this browser window shows the photo.
        </Note>
      )}
      {shown === 'wallpaper' &&
        (wallpaper && !wallpaper.found ? (
          <Note>Harv can’t find your desktop’s wallpaper picture (a colour or a slideshow?), so the photo shows.</Note>
        ) : (
          <Note>
            Your desktop’s own wallpaper, lined up with the desktop, so Harv’s window looks clear; the glass panels still frost it.
            {onWindows ? '' : ' KDE doesn’t tell an app where its window is: it lines up when Harv is maximized.'}
          </Note>
        ))}
      {shown === 'photo' && (
        <>
          <PhotoPicker />
          <Slider
            label="Photo blur"
            value={settings.backgroundBlur}
            min={0}
            max={30}
            unit="px"
            onChange={(backgroundBlur) => updateSettings({ backgroundBlur })}
          />
        </>
      )}
      {shown === 'seeThrough' &&
        (onWindows ? (
          <Toggle
            on={settings.frost}
            label="Frost what’s behind"
            hint="Off is clear glass. Windows has one frost strength."
            onChange={(frost) => updateSettings({ frost })}
          />
        ) : (
          <Note>Your desktop shows behind Harv. KDE can’t frost it for an app yet.</Note>
        ))}
      {shown !== 'plain' && shown !== 'wallpaper' && (
        <Slider
          label="Darkness"
          value={settings.scrim}
          min={0}
          max={90}
          step={5}
          unit="%"
          onChange={(scrim) => updateSettings({ scrim })}
        />
      )}
      <Note>The background is only on this device{shown === 'photo' ? '; the photo itself syncs' : ''}.</Note>
      {children}
    </Sub>
  );
}

export function AppearanceSection() {
  const settings = useSettings();
  const lookChanged = LOOK_KEYS.some((k) => settings[k] !== DEFAULT_SETTINGS[k]);
  const resetLook = () => updateSettings(Object.fromEntries(LOOK_KEYS.map((k) => [k, DEFAULT_SETTINGS[k]])) as Partial<HarvSettings>);
  return (
    <>
      <Group title="Appearance">
        <Sub title="Theme">
          <div role="radiogroup" aria-label="Accent colour" className={ROW}>
            <span className={LABEL}>Accent</span>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={settings.accent === c}
                  aria-label={ACCENT_NAMES[c]}
                  title={ACCENT_NAMES[c]}
                  onClick={() => updateSettings({ accent: c })}
                  className={`size-7 cursor-pointer rounded-full border-2 ${settings.accent === c ? 'border-ink' : 'border-transparent'}`}
                  style={{ background: c }}
                />
              ))}
              <label
                title="Any colour"
                className={`relative size-7 cursor-pointer overflow-hidden rounded-full border-2 ${
                  (ACCENTS as readonly string[]).includes(settings.accent) ? 'border-dashed border-line' : 'border-ink'
                }`}
                style={{ background: (ACCENTS as readonly string[]).includes(settings.accent) ? undefined : settings.accent }}
              >
                <span className="sr-only">Custom accent colour</span>
                {(ACCENTS as readonly string[]).includes(settings.accent) && (
                  <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-muted">
                    +
                  </span>
                )}
                <input
                  type="color"
                  value={settings.accent.toLowerCase()}
                  onChange={(e) => updateSettings({ accent: e.target.value.toUpperCase() })}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </label>
            </div>
          </div>
          <Slider
            label="Size"
            value={settings.uiScale}
            min={80}
            max={130}
            step={5}
            unit="%"
            onChange={(uiScale) => updateSettings({ uiScale })}
          />
          <Choice
            label="Chat spacing"
            value={settings.density}
            options={[
              { value: 'comfy', label: 'Comfy' },
              { value: 'compact', label: 'Compact' },
            ]}
            onChange={(density) => updateSettings({ density })}
          />
          <Toggle
            on={settings.motion}
            label="Animations"
            hint="Subtle fades, pulses and bars. Off keeps everything still."
            onChange={(motion) => updateSettings({ motion })}
          />
        </Sub>
        <Sub title="Notifications">
          <Toggle
            on={settings.noticeSound}
            label="Notification sound"
            hint="A soft tick for Harv's notices, a two-note chime for warnings. Kept per computer."
            onChange={(noticeSound) => {
              updateSettings({ noticeSound });
              if (noticeSound) playSound('tick', settings.noticeVolume);
            }}
          />
          {settings.noticeSound && (
            <>
              <Slider
                label="Volume"
                value={settings.noticeVolume}
                min={5}
                max={100}
                step={5}
                unit="%"
                onChange={(noticeVolume) => {
                  updateSettings({ noticeVolume });
                  playSound('tick', noticeVolume);
                }}
              />
              <div className="flex flex-wrap gap-2">
                <button type="button" className={BUTTON} onClick={() => playSound('tick', settings.noticeVolume)}>
                  ▶ Tick
                </button>
                <button type="button" className={BUTTON} onClick={() => playSound('chime', settings.noticeVolume)}>
                  ▶ Chime
                </button>
              </div>
            </>
          )}
        </Sub>
        <Background>
          <Slider
            label="Panel opacity"
            value={settings.glass}
            min={20}
            max={95}
            step={5}
            unit="%"
            onChange={(glass) => updateSettings({ glass })}
          />
          <Slider
            label="Panel frost"
            value={settings.glassBlur}
            min={0}
            max={40}
            unit="px"
            onChange={(glassBlur) => updateSettings({ glassBlur })}
          />
          <Note>How solid the glass panels are, and how much they blur what’s behind them.</Note>
          {lookChanged && (
            <button
              type="button"
              onClick={resetLook}
              className="min-h-7 cursor-pointer self-start rounded px-1.5 text-[11px] text-muted hover:text-accent"
            >
              Reset the whole look to default
            </button>
          )}
        </Background>
      </Group>
    </>
  );
}
