import { describe, expect, it } from 'vitest';
import { kdeFit, parseKdePanels, parseKdeWallpaper, windowsFit } from './wallpaper.ts';

describe('wallpaper placement', () => {
  it('maps Windows styles', () => {
    expect(windowsFit('10', '0')).toBe('cover');
    expect(windowsFit('22', '0')).toBe('cover');
    expect(windowsFit('6', '0')).toBe('contain');
    expect(windowsFit('2', '0')).toBe('stretch');
    expect(windowsFit('0', '0')).toBe('center');
    expect(windowsFit('0', '1')).toBe('tile');
  });

  it('maps KDE fill modes, absent = scaled and cropped', () => {
    expect(kdeFit(undefined)).toBe('cover');
    expect(kdeFit('2')).toBe('cover');
    expect(kdeFit('1')).toBe('contain');
    expect(kdeFit('0')).toBe('stretch');
    expect(kdeFit('6')).toBe('center');
    expect(kdeFit('3')).toBe('tile');
  });
});

describe('parseKdeWallpaper', () => {
  it('finds the first image wallpaper and its fill mode', () => {
    const text = [
      '[Containments][119]',
      'formfactor=2',
      '',
      '[Containments][28][Wallpaper][org.kde.image][General]',
      'Image=file:///home/u/Pictures/forest%20bg.jpg',
      'FillMode=1',
      'SlidePaths=/usr/share/wallpapers/',
      '',
      '[Containments][29]',
      'formfactor=2',
      '[Containments][30][Wallpaper][org.kde.image][General]',
      'Image=/other.png',
    ].join('\n');
    expect(parseKdeWallpaper(text)).toEqual({ image: '/home/u/Pictures/forest bg.jpg', fit: 'contain' });
  });

  it('takes a plain path and the default mode', () => {
    expect(parseKdeWallpaper('[Containments][1][Wallpaper][org.kde.image][General]\nImage=/a.jpg')).toEqual({
      image: '/a.jpg',
      fit: 'cover',
    });
  });

  it('finds panels on the top or left edge, only from a containment’s own section', () => {
    const text = [
      '[Containments][119]',
      'formfactor=2',
      'location=3',
      'plugin=org.kde.panel',
      '[Containments][119][Applets][122]',
      'plugin=org.kde.plasma.weather',
      'location=5',
      '[Containments][28]',
      'location=0',
      'plugin=org.kde.plasma.folder',
      '[Containments][29]',
      'location=4',
      'plugin=org.kde.panel',
    ].join('\n');
    expect(parseKdePanels(text)).toEqual({ top: true, left: false });
    expect(parseKdePanels('[Containments][1]\nplugin=org.kde.panel\nlocation=5')).toEqual({ top: false, left: true });
  });

  it('is null without an image wallpaper', () => {
    expect(parseKdeWallpaper('[Containments][1]\nwallpaperplugin=org.kde.color\n')).toBeNull();
  });
});
