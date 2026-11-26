import { useEffect, useState } from 'react';
import type { WallpaperFit, WallpaperInfo } from '@harv/shared';
import { inApp } from './desktop.ts';

/**
 * The "Wallpaper" background (the user's wish, 2026-11-13): the desktop's own picture, placed
 * the way the desktop places it on the monitor and shifted by where Harv's window sits, so the
 * window looks like it has no background of its own. The app tells where the window and its
 * monitor are; Wayland doesn't tell a window where it is, so on the notebook it lines up when
 * the window is maximized (it then sits at the monitor's top left).
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The picture's size and position as CSS for a layer covering the window. All inputs in physical pixels. */
export function placeWallpaper(
  fit: WallpaperFit,
  image: { w: number; h: number },
  monitor: Rect,
  window: { x: number; y: number },
  /** Physical pixels per CSS pixel of the layer (device pixel ratio × the dashboard's zoom). */
  ratio: number,
): { size: string; position: string; repeat: string } {
  let w = image.w;
  let h = image.h;
  if (fit === 'cover' || fit === 'contain') {
    const s = (fit === 'cover' ? Math.max : Math.min)(monitor.w / image.w, monitor.h / image.h);
    w = image.w * s;
    h = image.h * s;
  } else if (fit === 'stretch') {
    w = monitor.w;
    h = monitor.h;
  }
  // Tiles start at the monitor's corner; the rest is centred on it.
  const left = fit === 'tile' ? 0 : (monitor.w - w) / 2;
  const top = fit === 'tile' ? 0 : (monitor.h - h) / 2;
  const px = (n: number) => `${Math.round((n / ratio) * 100) / 100}px`;
  return {
    size: `${px(w)} ${px(h)}`,
    position: `${px(monitor.x + left - window.x)} ${px(monitor.y + top - window.y)}`,
    repeat: fit === 'tile' ? 'repeat' : 'no-repeat',
  };
}

interface Where {
  monitor: Rect;
  window: { x: number; y: number };
  dpr: number;
}

/**
 * Where a window that can't learn its position (Wayland) sits on its monitor, if it's maximized:
 * the gap between them goes to the side that has a panel (`gap`), else to the bottom / right.
 */
export function guessSpot(monitor: Rect, size: { w: number; h: number }, gap: { top: boolean; left: boolean }): { x: number; y: number } {
  return {
    x: monitor.x + (gap.left ? Math.max(0, monitor.w - size.w) : 0),
    y: monitor.y + (gap.top ? Math.max(0, monitor.h - size.h) : 0),
  };
}

/** Where the window and its monitor are now (physical pixels); the screen's size as a fallback. */
async function where(gap: WallpaperInfo['gap']): Promise<Where> {
  const dpr = window.devicePixelRatio || 1;
  const fallback: Where = {
    monitor: { x: 0, y: 0, w: screen.width * dpr, h: screen.height * dpr },
    window: { x: 0, y: 0 },
    dpr,
  };
  if (!inApp) return fallback;
  try {
    const { getCurrentWindow, currentMonitor } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const [pos, size, mon] = await Promise.all([win.innerPosition(), win.innerSize(), currentMonitor()]);
    const monitor = mon ? { x: mon.position.x, y: mon.position.y, w: mon.size.width, h: mon.size.height } : fallback.monitor;
    // The server sends `gap` only where the position can't be known.
    const spot = gap ? guessSpot(monitor, { w: size.width, h: size.height }, gap) : { x: pos.x, y: pos.y };
    return { monitor, window: spot, dpr };
  } catch {
    return fallback;
  }
}

/** Calls `cb` whenever the window moves, resizes or changes monitor scale; returns the stop. */
function watchWindow(cb: () => void): () => void {
  window.addEventListener('resize', cb);
  const stops: (() => void)[] = [() => window.removeEventListener('resize', cb)];
  let stopped = false;
  if (inApp) {
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      for (const listen of [w.onMoved.bind(w), w.onResized.bind(w), w.onScaleChanged.bind(w)]) {
        const un = await listen(cb).catch(() => null);
        if (!un) continue;
        if (stopped) un();
        else stops.push(un);
      }
    });
  }
  return () => {
    stopped = true;
    for (const stop of stops) stop();
  };
}

export interface WallpaperLayer {
  url: string;
  size: string;
  position: string;
  repeat: string;
}

/** The layer's picture and placement while `on`; null until it's known or when there's no wallpaper. */
export function useWallpaper(on: boolean, zoom: number): { layer: WallpaperLayer | null; info: WallpaperInfo | null } {
  const [info, setInfo] = useState<WallpaperInfo | null>(null);
  const [image, setImage] = useState<{ url: string; w: number; h: number } | null>(null);
  const [spot, setSpot] = useState<Where | null>(null);

  // What the desktop shows: on start and whenever Harv comes back to the front (the user may have changed it).
  useEffect(() => {
    if (!on) return;
    let live = true;
    const read = () =>
      void fetch('/api/wallpaper/info')
        .then((r) => (r.ok ? (r.json() as Promise<WallpaperInfo>) : null))
        .then((next) => live && next && setInfo((old) => (old && JSON.stringify(old) === JSON.stringify(next) ? old : next)))
        .catch(() => {});
    read();
    window.addEventListener('focus', read);
    return () => {
      live = false;
      window.removeEventListener('focus', read);
    };
  }, [on]);

  // The picture's own size, needed to place it.
  useEffect(() => {
    if (!on || !info?.found) return;
    let live = true;
    const url = `/api/wallpaper?v=${encodeURIComponent(info.version ?? '')}`;
    const img = new Image();
    img.onload = () => live && setImage({ url, w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
    return () => {
      live = false;
    };
  }, [on, info?.found, info?.version]);

  // Where the window is, kept current while it moves (a frame at most per update).
  const gapTop = info?.gap?.top;
  const gapLeft = info?.gap?.left;
  const known = info !== null;
  useEffect(() => {
    if (!on || !known) return;
    const gap = gapTop === undefined || gapLeft === undefined ? undefined : { top: gapTop, left: gapLeft };
    let frame = 0;
    let live = true;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        void where(gap).then((w) => live && setSpot(w));
      });
    };
    update();
    const stop = watchWindow(update);
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      stop();
    };
  }, [on, known, gapTop, gapLeft]);

  if (!on || !info?.found || !image || !spot) return { layer: null, info };
  const placed = placeWallpaper(info.fit, image, spot.monitor, spot.window, spot.dpr * zoom);
  return { layer: { url: image.url, ...placed }, info };
}
