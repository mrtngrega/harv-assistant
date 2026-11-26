import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BACKDROPS, COMPACT_ROWS, DEFAULT_SETTINGS, WARN_MARKS, type Backdrop, type HarvSettings } from '@harv/shared';
import { HARV_HOME } from './paths.ts';
import { osPath } from './platform.ts';

const settingsPath = () => join(HARV_HOME, 'settings.json');

/** An HTTPS or SSH Git URL (never a local path or an option like `--upload-pack`). */

// eslint-disable-next-line no-control-regex -- control characters don't belong in a device name
const CONTROL = /[\u0000-\u001f]/g;

/** A settings file as read: anything may be wrong or missing. */
type Raw = Partial<Record<keyof HarvSettings, unknown>>;

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : fallback;
const oneOf = <T>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
/** Usage warnings are one switch (pass B, B33): any marks = the fixed 75% and 90%, none = off. */
const marks = (v: unknown, fallback: number[]) => (Array.isArray(v) ? (v.length ? [...WARN_MARKS] : []) : fallback);

/** A list of strings: trimmed, empty ones and repeats dropped (`lower`: compared without case). */
const strings = (v: unknown, fallback: string[], lower = false): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => (lower ? s.trim().toLowerCase() : s.trim())),
        ),
      ]
    : fallback;

/** Keeps only valid values, so a hand-edited or partial file never breaks Harv. */
export function cleanSettings(raw: Raw, base: HarvSettings = DEFAULT_SETTINGS): HarvSettings {
  const rows = Array.isArray(raw.compactRows) ? COMPACT_ROWS.filter((r) => (raw.compactRows as unknown[]).includes(r)) : base.compactRows;
  const folder = (v: unknown, fallback: string) => {
    if (typeof v !== 'string') return fallback;
    const path = v.trim();
    // Only a full path (or nothing).
    return path === '' ? '' : osPath.isAbsolute(path) ? osPath.normalize(path) : fallback;
  };
  return {
    protectedPaths: strings(raw.protectedPaths, base.protectedPaths),
    myComputers: strings(raw.myComputers, base.myComputers, true),
    backupDays: num(raw.backupDays, 1, 365, base.backupDays),
    backupMaxGb: num(raw.backupMaxGb, 1, 100, base.backupMaxGb),
    motion: bool(raw.motion, base.motion),
    noticeSound: bool(raw.noticeSound, base.noticeSound),
    noticeVolume: num(raw.noticeVolume, 0, 100, base.noticeVolume),
    accent: typeof raw.accent === 'string' && /^#[0-9a-f]{6}$/i.test(raw.accent) ? raw.accent.toUpperCase() : base.accent,
    backgroundBlur: num(raw.backgroundBlur, 0, 30, base.backgroundBlur),
    scrim: num(raw.scrim, 0, 90, base.scrim),
    glass: num(raw.glass, 20, 95, base.glass),
    glassBlur: num(raw.glassBlur, 0, 40, base.glassBlur),
    backdrop: (BACKDROPS as readonly unknown[]).includes(raw.backdrop) ? (raw.backdrop as Backdrop) : base.backdrop,
    frost: bool(raw.frost, base.frost),
    uiScale: num(raw.uiScale, 80, 130, base.uiScale),
    density: oneOf(raw.density, ['comfy', 'compact'] as const, base.density),
    showTimes: bool(raw.showTimes, base.showTimes),
    showTags: bool(raw.showTags, base.showTags),
    sendKey: oneOf(raw.sendKey, ['enter', 'ctrlEnter'] as const, base.sendKey),
    startModel: oneOf(raw.startModel, ['auto', 'last'] as const, base.startModel),
    allowFable: bool(raw.allowFable, base.allowFable),
    statsExpanded: bool(raw.statsExpanded, base.statsExpanded),
    historyOpen: bool(raw.historyOpen, base.historyOpen),
    compactRows: rows,
    metricsMs: oneOf(raw.metricsMs, [1000, 2000, 3000, 5000] as const, base.metricsMs),
    warnSession: marks(raw.warnSession, base.warnSession),
    warnWeekly: marks(raw.warnWeekly, base.warnWeekly),
    workDir: folder(raw.workDir, base.workDir),
    projectsDir: folder(raw.projectsDir, base.projectsDir),
    startSensors: bool(raw.startSensors, base.startSensors),
    restoreTabs: bool(raw.restoreTabs, base.restoreTabs),
    watchdog: bool(raw.watchdog, base.watchdog),
    watchdogIgnored: strings(raw.watchdogIgnored, base.watchdogIgnored, true),
    desktopControl: bool(raw.desktopControl, base.desktopControl),
    desktopScreen:
      typeof raw.desktopScreen === 'string' && /^(\\\\\.\\DISPLAY\d{1,2})?$/.test(raw.desktopScreen)
        ? raw.desktopScreen
        : base.desktopScreen,
    deviceName:
      typeof raw.deviceName === 'string' ? raw.deviceName.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, 40) : base.deviceName,
  };
}

/** The last settings read without a problem (this run), the fallback when the file breaks. */
let lastGood: HarvSettings | null = null;
/** The broken file's time already reported, so one broken file is reported once. */
let brokenSeen = -1;
const brokenListeners = new Set<(problem: string) => void>();

/** Called once per broken settings.json (a hand edit with a stray comma, a write cut off by a crash). */
export function onSettingsBroken(listener: (problem: string) => void): () => void {
  brokenListeners.add(listener);
  return () => brokenListeners.delete(listener);
}

/** A copy of the settings as last saved fine, for a start with a broken file. */
const goodPath = () => join(osPath.dirname(settingsPath()), 'settings.good.json');

/**
 * Read on every check, so edits to ~/.harv/settings.json apply at once. A file that can't be read
 * never turns into "all defaults" (the full review, D17: the protected folders and sync quietly went
 * away, and the next switch saved that for good): Harv keeps the last good settings, keeps the broken
 * file as settings.broken.json and says so once.
 */
export function loadSettings(): HarvSettings {
  const path = settingsPath();
  if (!existsSync(path)) return DEFAULT_SETTINGS;
  let text: string | null = null;
  try {
    text = readFileSync(path, 'utf8');
    const settings = cleanSettings(JSON.parse(text) as Record<string, unknown>);
    lastGood = settings;
    return settings;
  } catch (err) {
    const mtime = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (text !== null && mtime !== brokenSeen) {
      brokenSeen = mtime;
      try {
        writeFileSync(join(osPath.dirname(path), 'settings.broken.json'), text);
      } catch {
        /* keep going on the good settings */
      }
      for (const listener of brokenListeners) listener((err as Error).message);
    }
    if (lastGood) return lastGood;
    try {
      return (lastGood = cleanSettings(JSON.parse(readFileSync(goodPath(), 'utf8')) as Record<string, unknown>));
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
}

/** Writes a file whole or not at all (a crash mid-write leaves the old one), with a plain write as the fallback. */
function writeWhole(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, text);
  }
}

const listeners = new Set<(before: HarvSettings, after: HarvSettings) => void>();

/** Called after every change made on this device (sync sends the shared ones to the other device). */
export function onSettingsChange(listener: (before: HarvSettings, after: HarvSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Applies a change from the dashboard and saves it. `quiet` (a change from the other device) tells no listener. */
export function updateSettings(patch: Raw, quiet = false): HarvSettings {
  const before = loadSettings();
  const next = cleanSettings(patch, before);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  writeWhole(settingsPath(), text);
  writeWhole(goodPath(), text);
  lastGood = next;
  if (!quiet) for (const listener of listeners) listener(before, next);
  return next;
}

/** When settings.json last changed (0 = never saved). */
export function settingsTime(): number {
  try {
    return statSync(settingsPath()).mtimeMs;
  } catch {
    return 0;
  }
}

/** Where new projects get their folder. */
export function projectsDir(settings = loadSettings()): string {
  return settings.projectsDir || join(homedir(), 'Projects');
}

/** The user's default folder, if it's set and still there. */
export function workDir(settings = loadSettings()): string | undefined {
  return settings.workDir && existsSync(settings.workDir) ? settings.workDir : undefined;
}
