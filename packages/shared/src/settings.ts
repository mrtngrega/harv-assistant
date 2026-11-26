/** The accent colours the mockup offers; the first is the default ice blue. Any other #rrggbb works too. */
export const ACCENTS = ['#A8C8E8', '#9FE0C4', '#F2B880', '#C9B8F0'] as const;

/** Rows the collapsed stats panel can show, in order. */
export const COMPACT_ROWS = ['cpu', 'gpu', 'ram', 'disk', 'net', 'session', 'weekly'] as const;
export type CompactRow = (typeof COMPACT_ROWS)[number];

/** The usage warning marks (brief §2.12): one switch turns them on or off. */
export const WARN_MARKS = [75, 90];

export const BACKDROPS = ['photo', 'wallpaper', 'seeThrough', 'plain'] as const;
export type Backdrop = (typeof BACKDROPS)[number];

/** How the desktop places its wallpaper on a monitor (Windows' Fill/Fit/Stretch/Center/Tile, KDE's fill modes). */
export type WallpaperFit = 'cover' | 'contain' | 'stretch' | 'center' | 'tile';

/** GET /api/wallpaper/info: the "Wallpaper" background's picture (GET /api/wallpaper) and how to place it. */
export interface WallpaperInfo {
  found: boolean;
  fit: WallpaperFit;
  /** Changes with the file, for cache-busting; null when there's none. */
  version: string | null;
  /**
   * Only where a window can't learn its own position (Linux/Wayland): whether a maximized
   * window's gap to the monitor sits at the top / left (a KDE panel there) rather than bottom / right.
   */
  gap?: { top: boolean; left: boolean };
}

/** ~/.harv/settings.json: shared by every dashboard window, the server and the safety gate. */
export interface HarvSettings {
  /** Folders Harv may read but never change (the user's read-only list). */
  protectedPaths: string[];
  /**
   * The user's own other computers (tailnet names like "mylaptop", or addresses), lower case. Harv
   * working on them over SSH is the user's own work, not sending to someone (the user, 2026-11-22).
   * Not every device on the user's tailnet is theirs, so only this list counts.
   */
  myComputers: string[];
  /** Backups (for Undo) older than this many days are deleted (the user's wish, 2026-10-29). */
  backupDays: number;
  /** All backups together stay under this many GB: the oldest go first. */
  backupMaxGb: number;

  // Look
  /** Subtle animations on (off = everything still). */
  motion: boolean;
  /** Harv's notices make a soft sound (a tick, a chime for warnings); per computer. */
  noticeSound: boolean;
  /** Their volume, 0–100. */
  noticeVolume: number;
  /** #rrggbb. */
  accent: string;
  /** Background photo blur in px (0–30). */
  backgroundBlur: number;
  /** How dark the layer over the photo is, in % (0–90). */
  scrim: number;
  /** How solid the glass panels are, in % (20–95). */
  glass: number;
  /** How much the glass panels blur what's behind them, in px (0–40). */
  glassBlur: number;
  /**
   * What's behind the panels: the photo, the desktop's own wallpaper lined up with the desktop
   * (the app; so the window looks like it has no background), the desktop (the app's see-through
   * window; a browser shows the photo instead), or the plain ground colour. Per device.
   */
  backdrop: Backdrop;
  /** See-through on Windows: frost what's behind the window (Acrylic; Windows has one strength). Per device. */
  frost: boolean;
  /** Size of everything, in % (80–130). */
  uiScale: number;
  /** Space between chat lines. */
  density: 'comfy' | 'compact';

  // Chat
  showTimes: boolean;
  /** The [model·effort] tag on Harv's replies. */
  showTags: boolean;
  /** Enter sends (Shift+Enter = new line), or Ctrl+Enter sends (Enter = new line). */
  sendKey: 'enter' | 'ctrlEnter';
  /** What the model switcher starts on when the dashboard opens. */
  startModel: 'auto' | 'last';
  /** Let AUTO use Fable 5.1 for the hardest tasks (it's always a manual pick). */
  allowFable: boolean;

  // Stats panel
  /** The stats panel's last state on this device (its ‹ › buttons save it). */
  statsExpanded: boolean;
  /** The chat history's last state on this device. */
  historyOpen: boolean;
  compactRows: CompactRow[];
  /** How often the hardware stats update, in ms. */
  metricsMs: 1000 | 2000 | 3000 | 5000;

  // Usage
  /** Warn at these % of the session (5-hour) limit; empty = off. */
  warnSession: number[];
  /** Warn at these % of the weekly limit; empty = off. */
  warnWeekly: number[];

  // Workspace
  /** The user's default folder: where terminals and the explorer open, and where Harv works on files unless told otherwise. '' = none. */
  workDir: string;
  /** Where new projects get their folder ('' = a Projects folder in the user's home). */
  projectsDir: string;

  // Startup
  /** Start LibreHardwareMonitor (UAC prompt) when Harv starts. */
  startSensors: boolean;
  /** Bring back the tabs, tools and drafts after a restart, like Chrome. */
  restoreTabs: boolean;

  // Watchdog
  /** Warn about overheating, background apps hogging the CPU/GPU, and dangerous software. */
  watchdog: boolean;
  /** Programs the watchdog never warns about (lowercase exe names, e.g. "blender.exe"). */
  watchdogIgnored: string[];

  /** This computer's name in Harv's notes and scheduled tasks ('' = the computer's name). */
  deviceName: string;

  // Desktop control (docs/PLAN.md §6t item 1), per device, Windows only.
  /** Chats may read the screen and use the mouse and keyboard (Windows-MCP); the first action of each reply asks. Off by default. */
  desktopControl: boolean;
  /** The monitor Harv works on (Windows device name, e.g. "\\.\DISPLAY2"); '' = the smallest. Others only when the user's message names one. */
  desktopScreen: string;

}

export const DEFAULT_SETTINGS: HarvSettings = {
  protectedPaths: [],
  myComputers: [],
  backupDays: 30,
  backupMaxGb: 5,
  motion: true,
  noticeSound: true,
  noticeVolume: 60,
  accent: ACCENTS[0],
  backgroundBlur: 9,
  scrim: 55,
  glass: 50,
  glassBlur: 22,
  backdrop: 'photo',
  frost: true,
  uiScale: 100,
  density: 'comfy',
  showTimes: true,
  showTags: true,
  sendKey: 'enter',
  startModel: 'last',
  allowFable: false,
  statsExpanded: false,
  historyOpen: false,
  compactRows: [...COMPACT_ROWS],
  metricsMs: 1000,
  warnSession: [75, 90],
  warnWeekly: [75, 90],
  workDir: '',
  projectsDir: '',
  startSensors: true,
  restoreTabs: true,
  watchdog: true,
  watchdogIgnored: [],
  deviceName: '',
  desktopControl: false,
  desktopScreen: '',
};

export type SettingsClientMessage = { type: 'settings.update'; patch: Partial<HarvSettings> };

export type SettingsServerMessage =
  | { type: 'settings'; settings: HarvSettings }
  /** The background photo changed; `version` busts the image cache (null = none set). */
  | { type: 'background'; version: number | null };
