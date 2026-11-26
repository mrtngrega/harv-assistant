import { useId } from 'react';
import type { HarvStatus } from '@harv/shared';

/**
 * Harv's logo (the user's pick, 2026-11-14, idea 4 in a planet): an H whose crossbar is Harv's two
 * eyes, inside a small dark planet with an ice rim. The same drawing is the app, tray, phone and
 * favicon icon (scripts/make-app-icons.mjs draws those from LOGO_PARTS). Here it also shows Harv's
 * state: blinking at rest, eyes scanning while he works, amber looking down while a yes waits,
 * closed at a plan limit. Motion off keeps it still (the .still rules in index.css).
 */
export type LogoMode = 'idle' | 'work' | 'wait' | 'sleep';

export const logoMode = (status: HarvStatus | undefined): LogoMode =>
  status === 'thinking' || status === 'working' ? 'work' : status === 'waiting' ? 'wait' : status === 'paused' ? 'sleep' : 'idle';

export function HarvLogo({ size = 22, mode = 'idle', title }: { size?: number; mode?: LogoMode; title?: string }) {
  const id = useId().replace(/:/g, '');
  const rim = mode === 'wait' ? '#F2B880' : '#A8C8E8';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={`harv-logo harv-logo-${mode} flex-none`}
    >
      <defs>
        <radialGradient id={`hv${id}`} cx="36%" cy="30%" r="78%">
          <stop offset="0" stopColor="#2c3e51" />
          <stop offset="0.6" stopColor="#16212c" />
          <stop offset="1" stopColor="#0b1118" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="29" fill={`url(#hv${id})`} stroke={rim} strokeOpacity="0.8" strokeWidth="2.6" />
      <path d="M8.6 23.4 A25 25 0 0 1 21.4 9.4" fill="none" stroke="#eef5fb" strokeOpacity="0.35" strokeWidth="2" strokeLinecap="round" />
      <rect x="18.5" y="19" width="5.6" height="26" rx="1.6" fill={rim} />
      <rect x="39.9" y="19" width="5.6" height="26" rx="1.6" fill={rim} />
      <g className="harv-logo-eyes">
        <rect x="26.1" y="26.5" width="4.4" height="11" rx="2.2" fill={mode === 'wait' ? '#fde9d6' : '#eef5fb'} />
        <rect x="33.5" y="26.5" width="4.4" height="11" rx="2.2" fill={mode === 'wait' ? '#fde9d6' : '#eef5fb'} />
      </g>
    </svg>
  );
}
