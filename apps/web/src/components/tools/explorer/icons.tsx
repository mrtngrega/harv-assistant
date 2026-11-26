/** Line icons for the explorer's command bar, in the style of Windows 11's (simple strokes). */
const PATHS = {
  cut: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.1 7.9 20 20M8.1 16.1 20 4',
  copy: 'M8 8h11v13H8zM5 16H4V3h11v1',
  paste: 'M9 4h6v3H9zM7 5H5v16h14V5h-2M9 12h6M9 16h4',
  rename: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  share: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  delete: 'M4 6h16M9 6V4h6v2M6 6l1 15h10l1-15M10 10v7M14 10v7',
  sort: 'M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4',
  view: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  pane: 'M4 4h16v16H4zM14 4v16',
  back: 'M19 12H5M11 6l-6 6 6 6',
  forward: 'M5 12h14M13 6l6 6-6 6',
  up: 'M12 19V5M6 11l6-6 6 6',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  details: 'M4 6h16M4 12h16M4 18h16',
  icons: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  chat: 'M4 5h16v11H9l-4 4v-4H4zM8 9h8M8 12h5',
  folder: 'M3 6h6l2 2h10v11H3z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  chevron: 'M6 9l6 6 6-6',
  project: 'M4 4h16v16H4zM4 9h16',
  close: 'M6 6l12 12M18 6L6 18',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  // Drawn rather than the ⚙ character, which some fonts (Linux) render tiny.
  gear: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};

export type IconName = keyof typeof PATHS;

// Even sizes only: in even-sized buttons an odd icon sits on half a pixel (the 2026-11-10 centring check).
export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3.2 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-none ${className}`}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Bytes the way Explorer shows them (512 B, 14.2 KB, 3.1 GB): one formatter for the whole dashboard. */
export { formatSize as bytes } from '../../../lib/attachments.ts';
