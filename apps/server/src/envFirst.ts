// Imported on index.ts's first line: ES imports run before the importing module's own code, so the
// billed names are stripped before any other module's top level can read process.env (the full
// review, S15; CLAUDE.md: "keep it first").
import { stripBilledCredentials } from './env.ts';

/** The billed names removed at startup (logged by index.ts once the logger exists). */
export const removedAtStart = stripBilledCredentials();
