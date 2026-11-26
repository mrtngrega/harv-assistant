import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WallpaperFit, WallpaperInfo } from '@harv/shared';
import { imageType } from './background.ts';
import { IS_WINDOWS } from './platform.ts';

/**
 * The computer's own desktop wallpaper, for the "Wallpaper" background (the user's wish,
 * 2026-11-13): the dashboard shows the very file the desktop shows, placed the way the desktop
 * places it, so Harv's window looks like it has no background at all. Read-only: Harv never sets it.
 */

const run = promisify(execFile);
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

/** Windows' WallpaperStyle + TileWallpaper → how the picture covers a monitor. 22 (Span) is drawn as Fill per monitor. */
export function windowsFit(style: string, tile: string): WallpaperFit {
  if (tile.trim() === '1') return 'tile';
  switch (style.trim()) {
    case '2':
      return 'stretch';
    case '6':
      return 'contain';
    case '0':
      return 'center';
    default:
      return 'cover'; // 10 Fill, 22 Span
  }
}

/** KDE's FillMode (Qt's Image.fillMode); absent = 2, "Scaled and Cropped". */
export function kdeFit(mode: string | undefined): WallpaperFit {
  switch (mode?.trim()) {
    case '0':
      return 'stretch';
    case '1':
      return 'contain';
    case '3':
    case '4':
    case '5':
      return 'tile';
    case '6':
      return 'center';
    default:
      return 'cover';
  }
}

/** The first image wallpaper in KDE's plasma-org.kde.plasma.desktop-appletsrc: its Image (a path or file:// URL) and FillMode. */
export function parseKdeWallpaper(text: string): { image: string; fit: WallpaperFit } | null {
  let inImage = false;
  let image: string | undefined;
  let mode: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      if (inImage && image) break;
      inImage = /\[Wallpaper\]\[org\.kde\.image\]\[General\]$/.test(line);
      image = undefined;
      mode = undefined;
      continue;
    }
    if (!inImage) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'Image') image = value;
    else if (key === 'FillMode') mode = value;
  }
  if (!inImage || !image) return null;
  // KDE runs on Linux only, so a POSIX path out of the URL (fileURLToPath would want a drive letter on Windows).
  const path = image.startsWith('file://') ? decodeURIComponent(new URL(image).pathname) : image;
  return { image: path, fit: kdeFit(mode) };
}

/**
 * Whether KDE has a panel on the top or left edge (Plasma's Location: 3 top, 5 left). Wayland
 * doesn't tell a window where it is, so a maximized window's gap to the monitor is put there.
 */
export function parseKdePanels(text: string): { top: boolean; left: boolean } {
  const found = { top: false, left: false };
  let isPanel = false;
  let location = '';
  let own = false;
  const close = () => {
    if (isPanel && location === '3') found.top = true;
    if (isPanel && location === '5') found.left = true;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // Only a containment's own section, not its applets' or wallpaper's.
    if (line.startsWith('[')) {
      own = /^\[Containments\]\[\d+\]$/.test(line);
      if (own) {
        close();
        isPanel = false;
        location = '';
      }
      continue;
    }
    if (!own) continue;
    if (line === 'plugin=org.kde.panel') isPanel = true;
    else if (line.startsWith('location=')) location = line.slice(9);
  }
  close();
  return found;
}

/** A KDE wallpaper package (a folder) → its biggest picture; a file stays as it is. */
function pictureIn(path: string): string | null {
  if (!existsSync(path)) return null;
  if (!statSync(path).isDirectory()) return path;
  const dir = join(path, 'contents', 'images');
  if (!existsSync(dir)) return null;
  let best: { path: string; size: number } | null = null;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const size = statSync(file).size;
    if (!best || size > best.size) best = { path: file, size };
  }
  return best?.path ?? null;
}

async function windowsWallpaper(): Promise<{ path: string; fit: WallpaperFit } | null> {
  const { stdout } = await run('reg', ['query', 'HKCU\\Control Panel\\Desktop'], { windowsHide: true, timeout: 5000 });
  const value = (name: string) => new RegExp(`^\\s*${name}\\s+REG_SZ\\s*(.*)$`, 'mi').exec(stdout)?.[1]?.trim() ?? '';
  const fit = windowsFit(value('WallpaperStyle'), value('TileWallpaper'));
  const set = value('WallPaper');
  // A slideshow or Spotlight leaves no file of its own: Windows' copy of what shows is TranscodedWallpaper.
  const transcoded = join(
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Themes',
    'TranscodedWallpaper',
  );
  const path = set && existsSync(set) ? set : existsSync(transcoded) ? transcoded : null;
  return path ? { path, fit } : null;
}

const KDE_CONFIG = join(homedir(), '.config', 'plasma-org.kde.plasma.desktop-appletsrc');

function kdeWallpaper(): { path: string; fit: WallpaperFit } | null {
  if (!existsSync(KDE_CONFIG)) return null;
  const found = parseKdeWallpaper(readFileSync(KDE_CONFIG, 'utf8'));
  const path = found && pictureIn(found.image);
  return found && path ? { path, fit: found.fit } : null;
}

/** Where a maximized window's gap to its monitor sits, where the window's position is unknown (Linux). */
function gapEdges(): WallpaperInfo['gap'] {
  if (IS_WINDOWS) return undefined;
  try {
    return existsSync(KDE_CONFIG) ? parseKdePanels(readFileSync(KDE_CONFIG, 'utf8')) : { top: false, left: false };
  } catch {
    return { top: false, left: false };
  }
}

/** Where the desktop's picture is and how it's placed, or null (no picture, a colour, a slideshow folder we can't read). */
export async function findWallpaper(): Promise<{ path: string; fit: WallpaperFit; contentType: string } | null> {
  try {
    const found = IS_WINDOWS ? await windowsWallpaper() : kdeWallpaper();
    if (!found) return null;
    // The type from the bytes: TranscodedWallpaper has no extension, and a name isn't trusted.
    const head = Buffer.alloc(12);
    const fd = openSync(found.path, 'r');
    try {
      readSync(fd, head, 0, 12, 0);
    } finally {
      closeSync(fd);
    }
    const type = imageType(head);
    return type ? { ...found, contentType: TYPES[type] } : null;
  } catch {
    return null;
  }
}

/** What the dashboard needs to place it; `version` changes with the file. */
export async function wallpaperInfo(): Promise<WallpaperInfo> {
  const found = await findWallpaper();
  if (!found) return { found: false, fit: 'cover', version: null };
  const stat = statSync(found.path);
  const gap = gapEdges();
  return { found: true, fit: found.fit, version: `${Math.round(stat.mtimeMs)}-${stat.size}-${found.path.length}`, ...(gap ? { gap } : {}) };
}
