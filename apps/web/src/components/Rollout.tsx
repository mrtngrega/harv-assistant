import type { ReactNode } from 'react';

/**
 * A picker folded to its current choice that rolls out on hover or keyboard focus (the user's wish,
 * 2026-11-14): the full row slides open leftwards OVER its neighbours, from the pill's right edge, so
 * nothing else moves. Touch screens (no hover) get the full row from the caller instead.
 */
export function Rollout({ folded, label, children }: { folded: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="group/roll relative flex flex-none">
      <div
        aria-hidden="true"
        className="flex transition-opacity duration-150 group-has-[:focus-visible]/roll:opacity-0 group-hover/roll:opacity-0"
      >
        {folded}
      </div>
      <div
        aria-label={label}
        className="pointer-events-none absolute top-0 right-0 z-30 flex w-max opacity-0 transition-[clip-path,opacity] delay-150 duration-200 ease-out [clip-path:inset(0_0_0_100%_round_12px)] group-has-[:focus-visible]/roll:pointer-events-auto group-has-[:focus-visible]/roll:opacity-100 group-has-[:focus-visible]/roll:delay-0 group-has-[:focus-visible]/roll:[clip-path:inset(0_0_0_0_round_12px)] group-hover/roll:pointer-events-auto group-hover/roll:opacity-100 group-hover/roll:delay-0 group-hover/roll:[clip-path:inset(0_0_0_0_round_12px)] motion-reduce:transition-none"
      >
        {children}
      </div>
    </div>
  );
}
