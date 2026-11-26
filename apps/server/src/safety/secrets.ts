import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { IS_WINDOWS } from '../platform.ts';

/**
 * Secrets reached without naming them: a wildcard (`~/.cl?ude/.cred*`, `id_*`), a variable
 * (`$env:APPDATA\Microsoft\Cred*`) or a recursive search over a folder that holds them
 * (`grep -r token ~`). The literal-name check (SENSITIVE_PATHS in classify.ts) can't see those,
 * so this tests the words against where secrets really live on this computer.
 */

const home = homedir();
const env = (name: string, fallback: string) => process.env[name] || fallback;

/** Where secrets live, as full paths ("*" for a folder whose name differs per computer, like a profile). */
function secretPaths(): string[] {
  const h = (...p: string[]) => join(home, ...p);
  const common = [
    h('.claude', '.credentials.json'),
    // Private keys only: ~/.ssh/config, public keys and known_hosts hold no secret (2026-11-11).
    ...['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'].map((k) => h('.ssh', k)),
    h('.aws', 'credentials'),
    h('.azure', '*'),
    h('.kube', 'config'),
    h('.gnupg', '*'),
    h('.git-credentials'),
    // GitLab's CLI keeps its login here (glab auth login), like gh's hosts.yml.
    h('.config', 'glab-cli', 'config.yml'),
    h('.npmrc'),
    h('.netrc'),
    h('.pypirc'),
    h('.docker', 'config.json'),
    h('.harv', 'sync.key'),
    h('.harv', 'browser-profile', '*'),
    h('.harv', 'gemini-profile', '*'),
    h('.harv', 'browser-data', '*'),
    h('.harv', 'vapid.json'),
    h('.harv', 'phones.json'),
    h('.harv', 'devices.json'),
  ];
  if (!IS_WINDOWS) {
    const browsers = ['google-chrome', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].flatMap((b) =>
      ['Login Data', 'Cookies', 'Web Data'].map((f) => h('.config', b, 'Default', f)),
    );
    return [
      ...common,
      ...browsers,
      ...['logins.json', 'key4.db', 'cookies.sqlite'].map((f) => h('.mozilla', 'firefox', '*', f)),
      h('.config', 'gh', 'hosts.yml'),
      h('.local', 'share', 'keyrings', '*'),
      h('.local', 'share', 'kwalletd', '*'),
      h('.password-store', '*'),
      '/etc/shadow',
      '/etc/gshadow',
      '/etc/sudoers',
    ];
  }
  const local = env('LOCALAPPDATA', h('AppData', 'Local'));
  const roaming = env('APPDATA', h('AppData', 'Roaming'));
  const browsers = [
    ['Google', 'Chrome'],
    ['Microsoft', 'Edge'],
    ['BraveSoftware', 'Brave-Browser'],
  ].flatMap((b) => [
    ...['Login Data', 'Cookies', 'Web Data'].map((f) => join(local, ...b, 'User Data', 'Default', f)),
    join(local, ...b, 'User Data', 'Local State'),
  ]);
  return [
    ...common,
    ...browsers,
    ...['logins.json', 'key4.db', 'cookies.sqlite'].map((f) => join(roaming, 'Mozilla', 'Firefox', 'Profiles', '*', f)),
    ...['Credentials', 'Vault', 'Protect'].flatMap((d) => [join(roaming, 'Microsoft', d, '*'), join(local, 'Microsoft', d, '*')]),
    join(roaming, 'GitHub CLI', 'hosts.yml'),
    join(local, 'glab-cli', 'config.yml'),
    join(roaming, 'glab-cli', 'config.yml'),
    join(env('SystemRoot', 'C:\\Windows'), 'System32', 'config', 'SAM'),
  ];
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
const SECRETS = secretPaths().map(norm);
const SECRET_NAMES = new Set(SECRETS.map((p) => p.split('/').at(-1)!).filter((n) => n !== '*'));

const GLOB = /[*?[]/;

/** `~`, `$HOME`, `$env:NAME`, `${env:NAME}` and `%NAME%` replaced by their values (unknown ones stay). */
export function expandVars(word: string): string {
  const value = (name: string) => (name.toUpperCase() === 'HOME' ? home : (process.env[name] ?? process.env[name.toUpperCase()]));
  return word
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/\$\{?env:(\w+)\}?/gi, (m, n: string) => value(n) ?? m)
    .replace(/%(\w+)%/g, (m, n: string) => value(n) ?? m)
    .replace(/\$\{?(HOME|USERPROFILE)\}?(?=$|[\\/])/g, (m, n: string) => value(n) ?? m);
}

/**
 * A glob as a regex over normalized paths (`*` within one folder, `**` across folders). A `[…]` that
 * isn't a valid class (a file name like `song [aZ-b9].wav`, lowercased into a backwards range) is
 * taken literally instead of throwing, which used to fail the whole safety check.
 */
function globRegex(pattern: string, classes = true): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '[' && classes) {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += `[${pattern
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return globRegex(pattern, false);
  }
}

/** A secret's own placeholder folder ("*") matches any name the pattern gives it. */
const secretRegex = (secret: string) =>
  new RegExp(
    `^${secret
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]+')}$`,
  );
const SECRET_RES = SECRETS.map((s) => ({ path: s, re: secretRegex(s) }));

/**
 * A secret's Windows 8.3 short name (`.credentials.json` → `creden~1.jso`, `id_ed25519` → `id_ed2~1`):
 * the disk opens the file by it, and cmd's wildcards match it (the full review, S2).
 */
function shortName(name: string): string | null {
  if (name === '*' || name.includes('*')) return null;
  const bare = name.replace(/^\.+/, '');
  const dot = bare.lastIndexOf('.');
  const stem = (dot > 0 ? bare.slice(0, dot) : bare).replace(/[.\s]/g, '');
  const ext = dot > 0 ? bare.slice(dot + 1, dot + 4) : '';
  if (!stem || (stem.length <= 8 && bare === name && ext.length <= 3 && !/[\s]/.test(name))) return null; // already 8.3
  return `${stem.slice(0, 6)}~1${ext ? `.${ext}` : ''}`;
}
const SHORT_RES = SECRETS.flatMap((s) => {
  const parts = s.split('/');
  const short = shortName(parts.at(-1)!);
  if (!short) return [];
  const dir = parts.slice(0, -1).join('/');
  const re = new RegExp(`^${secretRegex(dir).source.slice(1, -1)}/${short.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('~1', '~\\d+')}$`);
  return [{ sample: `${dir.replace(/\*/g, 'x')}/${short}`, re }];
});

/** A literal path that is a secret, by its long or its short name. */
const isSecretPath = (full: string) => SECRET_RES.some(({ re }) => re.test(full)) || SHORT_RES.some(({ re }) => re.test(full));

/** A path pattern that names a secret, or a folder of one (with letters of its own, so `~/*` alone isn't one). */
function globHitsSecret(pattern: string): boolean {
  const re = globRegex(pattern);
  if (SHORT_RES.some(({ sample }) => re.test(sample))) return true;
  const last = pattern.split('/').at(-1) ?? '';
  const ownLetters = /[^*?[\]/]{2,}/.test(last.replace(/\[[^\]]*\]/g, ''));
  return SECRET_RES.some(({ path, re: secret }) => {
    // The pattern can stand for the whole secret path (placeholders in the secret take any name)…
    const sample = path.replace(/\*/g, 'x');
    if (re.test(sample) || (!GLOB.test(pattern) && secret.test(pattern))) return true;
    // …or for one of its folders (`~/.s?h`, then read what's inside).
    if (!ownLetters) return false;
    const parts = sample.split('/');
    for (let n = 2; n < parts.length; n++) if (re.test(parts.slice(0, n).join('/'))) return true;
    return false;
  });
}

/**
 * What the Grep tool must leave out when it searches a folder (the full review, S1; the user, 2026-11-17:
 * "access what he needs, but safely"). One ripgrep glob, flat (ripgrep refuses nested braces).
 */
const EXCLUDED = [
  '**/.claude/.credentials.json',
  '**/.ssh/id_*',
  '**/.aws/**',
  '**/.azure/**',
  '**/.kube/**',
  '**/.gnupg/**',
  '**/.gcloud/**',
  '**/*credential*',
  '**/*Credential*',
  '**/Microsoft/Credentials/**',
  '**/Microsoft/Vault/**',
  '**/Microsoft/Protect/**',
  '**/.npmrc',
  '**/.netrc',
  '**/_netrc',
  '**/.pypirc',
  '**/.docker/config.json',
  '**/gh/hosts.yml',
  '**/GitHub CLI/hosts.yml',
  '**/glab-cli/config.yml',
  '**/Login Data*',
  '**/Cookies*',
  '**/Web Data*',
  '**/Local State',
  '**/logins.json',
  '**/key3.db',
  '**/key4.db',
  '**/cookies.sqlite',
  '**/signons.sqlite',
  '**/.harv/sync.key',
  '**/.harv/vapid.json',
  '**/.harv/phones.json',
  '**/.harv/devices.json',
  '**/.harv/browser-profile/**',
  '**/.harv/gemini-profile/**',
  '**/.harv/browser-data/**',
  '**/keyrings/**',
  '**/kwalletd/**',
  '**/kwallet/**',
  '**/.password-store/**',
  '**/.env',
  '**/.env.*',
  ...['pem', 'key', 'pfx', 'p12', 'kdbx', 'ppk', 'ovpn', 'jks', 'keystore'].map((x) => `**/*.${x}`),
  '**/shadow',
  '**/gshadow',
  '**/sudoers',
  '**/config/SAM',
  '**/config/SECURITY',
  '**/wlansvc/**',
  '**/Local Storage/**',
  '**/tdata/**',
  '**/ssfn*',
  '**/loginusers.vdf',
  '**/Bitwarden/**',
  '**/1Password/**',
  '**/KeePassXC/**',
  '**/LogMeIn Hamachi/**',
  '**/Tailscale/*state*',
];
export const SECRET_EXCLUDE_GLOB = `!{${EXCLUDED.join(',')}}`;

/** A negative glob of Harv's own (`!*.log`, `!{a,b}`) merged with the secret exclusion. */
export function withSecretExclusion(glob: string): string {
  const own = glob.replace(/^!/, '').replace(/^\{(.*)\}$/, '$1');
  return `!{${[own, ...EXCLUDED].join(',')}}`;
}

/** `*.{ts,json}` → [`*.ts`, `*.json`] (one level, like ripgrep). */
const expandBraces = (glob: string): string[] => {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  return m[1]!.split(',').flatMap((alt) => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
};

/** Secret files as samples a glob is tried on: this computer's own, plus the kinds found anywhere. */
const SAMPLES = [
  ...SECRETS.map((s) => s.replace(/\*/g, 'x')),
  ...['.env', '.env.local', 'a.pem', 'a.key', 'a.pfx', 'a.p12', 'a.kdbx', 'a.ppk', 'a.ovpn', 'a.jks', 'credentials.json'].map(
    (n) => `/x/${n}`,
  ),
];

/**
 * Could a Grep with this file pattern open a login secret? A pattern without a slash matches a file name
 * anywhere; one with a slash matches the end of a path (ripgrep's rules). Case doesn't help: Windows ignores it.
 */
export function globMayReadSecret(glob: string): boolean {
  return expandBraces(norm(glob)).some((g) => {
    const re = globRegex(g.replace(/^\.?\//, ''));
    return SAMPLES.some((sample) => {
      const parts = sample.split('/').filter(Boolean);
      if (!g.includes('/')) return re.test(parts.at(-1)!);
      for (let i = 0; i < parts.length; i++) if (re.test(parts.slice(i).join('/'))) return true;
      return false;
    });
  });
}

/** A file name pattern (`id_*`, `Login*`) that matches a secret's name. Needs letters of its own: `*` is everything. */
const nameHitsSecret = (name: string) =>
  /[^*?[\]]{2,}/.test(name.replace(/\[[^\]]*\]/g, '')) && [...SECRET_NAMES].some((s) => globRegex(norm(name)).test(s));

/** A folder that holds secrets (home, a drive root, AppData…). */
const holdsSecrets = (dir: string) => {
  const d = norm(dir).replace(/\/$/, '');
  return d !== '' && SECRETS.some((s) => s.startsWith(`${d}/`));
};

/** Recursive search options of the usual tools. */
const RECURSIVE = /^(-r|-R|-rn|-rl|-ri|-Rn|--recursive|-recurse|\/s)$/i;
const NAME_FILTER = /^(-filter|-include|-name|-iname|-path|-ipath|--include|--glob|-g)$/i;
/** Tools that read what they find (as opposed to only listing names). */
const READERS =
  /^(grep|egrep|fgrep|rg|ag|ack|findstr|select-string|sls|get-content|gc|cat|type|more|less|head|tail|strings|xxd|od|copy-item|cp|copy)$/i;
/** Tools that only see names or permissions, never contents. */
const NAMES_ONLY = /^(ls|dir|gci|get-childitem|stat|test-path|tree|du|chmod|chown|icacls)$/i;
/** Tools that copy whole folders, contents included. */
const ARCHIVERS = /^(tar|zip|7z|7za|compress-archive|rsync|scp|cp|copy-item|robocopy|xcopy)$/i;
/** Of those, the ones that open the files a pipe hands them (the rest read the pipe's text: names). */
const PIPED_READERS = /^(get-content|gc|cat|type|select-string|sls|copy-item|cp|copy|xargs)$/i;

/** A reader inside a PowerShell script block (`% { gc $_.FullName }`) or .NET's file readers. */
const PS_BLOCK_READS =
  /[{(;|]\s*(get-content|gc|cat|type|select-string|sls)\b|\[(system\.)?io\.file\]::(readall\w*|opentext|openread)|\.opentext\(/i;

/**
 * A substitution that lists secrets handed to a reader (`cat $(ls ~/.ssh/id*)`, ``cat `ls -d ~/.ssh/*` ``):
 * the listing's words name the files the reader then opens (the full review, S2).
 */
export function substitutionReadsSecret(shell: string, cwd: string): boolean {
  const inners = [...shell.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? '');
  if (inners.length === 0) return false;
  const outer = shell.replace(/\$\([^()]*\)|`[^`]*`/g, ' ');
  if (
    !/(^|[\s;|&(])(cat|type|more|less|head|tail|strings|xxd|od|get-content|gc|cp|copy|copy-item|tar|zip|7z|scp|rsync|base64|curl|grep|rg)\b/i.test(
      outer,
    )
  )
    return false;
  return inners.some((inner) =>
    inner.split(/\s+/).some((raw) => {
      const word = expandVars(raw.replace(/^["']|["']$/g, ''));
      if (!/[\\/]/.test(word) && !word.startsWith('~')) return false;
      const full = norm(isAbsolute(word) || /^[a-z]:/i.test(word) ? word : join(cwd, word));
      return GLOB.test(word) ? globHitsSecret(full) : isSecretPath(full) || holdsSecrets(full);
    }),
  );
}

/** A command part with the folder it runs in (after a `cd`). */
export type SecretSegment = { words: string[]; base?: string };

/**
 * Does this command reach a secret without naming it? `segments` are the command's parts (a pipe
 * or chain splits them), each as its words without quotes and the folder it runs in (a `cd` moves
 * it: the full review, S2); `cwd` is where the command starts. In PowerShell a listing piped into a
 * reader reads the files (`Get-ChildItem ~/.ssh | Get-Content`), in Bash only their names.
 */
export function reachesSecret(segments: (string[] | SecretSegment)[], cwd: string, powershell = false): boolean {
  const parts = segments.map((s) => (Array.isArray(s) ? { words: s, base: cwd } : { words: s.words, base: s.base ?? cwd }));
  const programs = parts.map(({ words: ws }) => (ws[0] ?? '').toLowerCase().replace(/\.exe$/, ''));
  // Another part reads the files the search found: PowerShell's file readers take piped files,
  // xargs hands names to a reader. `find ~ -iname x | head` only reads the names (2026-11-11).
  const reads =
    programs.some((p) => PIPED_READERS.test(p)) || (powershell && parts.some(({ words: ws }) => PS_BLOCK_READS.test(ws.join(' '))));
  const xargs = programs.includes('xargs');
  for (const { words: ws, base } of parts) {
    const program = (ws[0] ?? '').toLowerCase().replace(/\.exe$/, '');
    // Programs that only see names or change who may read a file (`chmod 600 ~/.ssh/id_ed25519`).
    if (NAMES_ONLY.test(program) && !xargs && !reads) continue;
    const recursive = ws.some((w) => RECURSIVE.test(w)) || program === 'find' || (program === 'rg' && !ws.includes('--files'));
    // A reader's plain words are files too (`cd ~/.docker && cat config.json`).
    const readsWords = READERS.test(program) || ARCHIVERS.test(program);
    let searchesSecrets = false;
    let narrowed = false;
    for (let i = 1; i < ws.length; i++) {
      const raw = ws[i]!;
      const value = raw.includes('=') && raw.startsWith('-') ? raw.slice(raw.indexOf('=') + 1) : raw;
      const word = expandVars(value);
      if (!word || (word.startsWith('-') && !GLOB.test(word))) continue;
      // A name filter (`-Filter id_* | Get-Content`, `find -name "Login*" -exec cat`) that finds secrets
      // and reads them. Only listing names (`find ~ -name "*.json"`) is fine.
      if (NAME_FILTER.test(ws[i - 1] ?? '') && !/[\\/]/.test(word)) {
        if (nameHitsSecret(word) && (reads || ws.includes('-exec') || ws.includes('-execdir'))) return true;
        narrowed = true;
        continue;
      }
      // `..` alone is a folder too (`cd ~/tools && grep -rn token ..` searches home).
      const looksLikePath = /[\\/]/.test(word) || GLOB.test(word) || /^[a-z]:$/i.test(word) || /^(~|\.\.?)$/.test(word);
      if (!looksLikePath && !readsWords) continue;
      const full = norm(isAbsolute(word) || /^[a-z]:/i.test(word) ? word : join(base, word));
      if (GLOB.test(word) ? globHitsSecret(full) : isSecretPath(full)) return true;
      if (!GLOB.test(word) && looksLikePath && holdsSecrets(full)) searchesSecrets = true;
    }
    // A recursive search through home (or a drive, AppData…) that reads the files it finds.
    if (searchesSecrets && recursive && (READERS.test(program) || reads || ws.includes('-exec') || ws.includes('-execdir'))) return true;
    // Packing or copying a folder that holds secrets copies them (`tar czf x.tgz ~/.ssh`); a listing
    // handed to a reader reads them (`ls ~/.ssh | xargs cat`, PowerShell's `gci ~/.ssh | gc`).
    if (searchesSecrets && (ARCHIVERS.test(program) || xargs)) return true;
    if (searchesSecrets && powershell && reads && !narrowed) return true;
  }
  return false;
}
