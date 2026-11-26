import { delimiter } from 'node:path';

/** The folders `npm run` puts in front of PATH for its script: every `node_modules/.bin` up the tree, and npm's node-gyp-bin. */
const NPM_ADDED = /[\\/]node_modules[\\/]\.bin[\\/]?$|[\\/]node-gyp-bin[\\/]?$/i;

/**
 * The environment for the script that restarts Harv. Harv runs under `npm run`, which puts its
 * folders in front of PATH; a restart started from Harv used to hand that PATH on, so every
 * restart stacked another ~500 characters until cmd.exe's 8191-character limit cut PATH short and
 * `concurrently` wasn't found: Harv stayed down (2026-11-15, likely the 2026-10-31 one too). This
 * drops npm's folders and `npm_*` variables and keeps each remaining PATH folder once.
 */
export function restartEnv(env: NodeJS.ProcessEnv = process.env, sep = delimiter, caseless = sep === ';'): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_/i.test(key) || key === 'INIT_CWD') continue;
    out[key] = value;
  }
  // Windows spells it Path; whatever key holds it, clean that one.
  const pathKey = Object.keys(out).find((k) => k.toUpperCase() === 'PATH');
  if (pathKey && out[pathKey]) {
    const seen = new Set<string>();
    out[pathKey] = out[pathKey]!.split(sep)
      .filter((dir) => {
        if (!dir || NPM_ADDED.test(dir)) return false;
        const key = (caseless ? dir.toLowerCase() : dir).replace(/[\\/]+$/, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join(sep);
  }
  return out;
}
