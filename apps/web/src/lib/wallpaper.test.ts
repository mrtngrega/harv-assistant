import { describe, expect, it } from 'vitest';
import { guessSpot, placeWallpaper } from './wallpaper.ts';

describe('guessSpot (Wayland: no window position)', () => {
  it('puts a maximized window under a top panel', () => {
    expect(guessSpot(monitorOf(), { w: 1920, h: 1036 }, { top: true, left: false })).toEqual({ x: 0, y: 44 });
  });
  it('keeps it at the corner without a top or left panel', () => {
    expect(guessSpot(monitorOf(), { w: 1920, h: 1036 }, { top: false, left: false })).toEqual({ x: 0, y: 0 });
  });
  it('puts it right of a left panel', () => {
    expect(guessSpot(monitorOf(), { w: 1860, h: 1080 }, { top: false, left: true })).toEqual({ x: 60, y: 0 });
  });
});

function monitorOf() {
  return { x: 0, y: 0, w: 1920, h: 1080 };
}

const monitor = { x: 0, y: 0, w: 1920, h: 1080 };

describe('placeWallpaper', () => {
  it('fills a monitor like Windows Fill: scaled to cover, centred', () => {
    // 4000×2000 on 1920×1080: scale 0.54 → 2160×1080, 120 px cut on each side.
    expect(placeWallpaper('cover', { w: 4000, h: 2000 }, monitor, { x: 0, y: 0 }, 1)).toEqual({
      size: '2160px 1080px',
      position: '-120px 0px',
      repeat: 'no-repeat',
    });
  });

  it('shifts by where the window sits', () => {
    const p = placeWallpaper('cover', { w: 1920, h: 1080 }, monitor, { x: 300, y: 200 }, 1);
    expect(p.position).toBe('-300px -200px');
  });

  it('works on a second monitor and with display scaling', () => {
    // The right monitor at x 2560, 150 % scaling, the window 100 physical px into it.
    const p = placeWallpaper('cover', { w: 1920, h: 1080 }, { x: 2560, y: 0, w: 1920, h: 1080 }, { x: 2660, y: 0 }, 1.5);
    expect(p).toEqual({ size: '1280px 720px', position: '-66.67px 0px', repeat: 'no-repeat' });
  });

  it('stretches, letterboxes, centres and tiles', () => {
    expect(placeWallpaper('stretch', { w: 100, h: 100 }, monitor, { x: 0, y: 0 }, 1).size).toBe('1920px 1080px');
    expect(placeWallpaper('contain', { w: 1000, h: 1000 }, monitor, { x: 0, y: 0 }, 1)).toMatchObject({
      size: '1080px 1080px',
      position: '420px 0px',
    });
    expect(placeWallpaper('center', { w: 1000, h: 1000 }, monitor, { x: 0, y: 0 }, 1).position).toBe('460px 40px');
    expect(placeWallpaper('tile', { w: 100, h: 100 }, monitor, { x: 50, y: 0 }, 1)).toEqual({
      size: '100px 100px',
      position: '-50px 0px',
      repeat: 'repeat',
    });
  });
});
