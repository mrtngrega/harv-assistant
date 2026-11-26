/**
 * The rows just above the command line (background tasks, the status line, plan mode) share one
 * look, so everything shown there lines up the same (the user's report, 2026-11-20: the task strip
 * sat off-centre between its dividers and ended short of the status line).
 * `scripts/ui-check/strip-align.mjs` measures them.
 */

/** A band: its divider on top, the same space above and below its rows, the prompt row's edges (it ends where RUN does). */
export const STRIP_BAND = 'border-t border-line py-0.5 pr-3 pl-5 text-xs';
/** One row in a band: 24 px, every piece on its centre line. */
export const STRIP_ROW = 'flex h-6 min-w-0 items-center gap-2 whitespace-nowrap';
/** The status glyph at the start of a row (✻ ⟳ ✓ ✗): one fixed slot, so the text after it starts at the same x in every row. */
export const STRIP_GLYPH = 'flex h-6 w-3 flex-none items-center justify-center leading-none';
/** An action at the right end of a row ("stop", ×, "start it clean"): layout only, so each use adds its colours (two text colours on one element would fight). */
export const STRIP_ACTION = 'flex h-6 min-w-6 flex-none cursor-pointer items-center justify-center rounded px-1.5 text-[11px] leading-none';
/** The usual quiet look of one. */
export const STRIP_QUIET = 'text-faint hover:bg-white/10';
export const STRIP_NOTE = 'flex-none text-[11px] leading-none text-faint';
