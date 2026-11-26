import { homedir } from 'node:os';
import { join } from 'node:path';
import { fullPath, isInside } from './paths.ts';
import { BILLED_ENV_NAMES } from '../env.ts';
import { splitCommand, splitHeredocs, unquote, words } from './shell.ts';

/** Where a file name ends inside a command line too (a quote, a space, a separator), not only at the end. */
const END = String.raw`(?=$|[\s"'\\/;|),])`;

const START = String.raw`(^|[\\/\s"'])`;

// END can sit inside a group too (`([\\/]|END)`: the folder itself or anything in it).
const sensitive = (body: string) => new RegExp(body.replace(/\^START/g, START).replace(/END/g, END), 'i');

/** Files and folders that hold passwords, keys, tokens or login sessions: never read or changed. */
const SENSITIVE_PATHS: RegExp[] = [
  // Claude Code's login (.credentials.json, also caught by "credential"). The rest of ~/.claude is the
  // user's Claude Code setup, open to Harv like to Claude Code itself (the user's wish, 2026-10-31):
  // see isClaudeSetup and BILLING_SETTING for what changing it may not do.
  sensitive(String.raw`[\\/]\.claude[\\/]\.credentials\.jsonEND`),
  // Climbing out of a folder to reach it anyway (`~/.claude/projects/x/../../.credentials.json`).
  /[\\/]\.claude[\\/].*\.\.([\\/]|$)/i,
  // Harv's own keys: web push (vapid.json), paired phones' hashed tokens (phones.json); sync.key is a key file.
  /[\\/]\.harv[\\/](vapid|phones|devices)\.json/i,
  /credential/i, // Windows Credentials, .git-credentials, …credentials.json
  // ~/.ssh as a folder isn't one (listing it, public keys, known_hosts, config): only the private keys below (2026-11-11).
  sensitive(String.raw`^START\.(aws|azure|kube|gnupg|gcloud)([\\/]|END)`),
  sensitive(String.raw`^START\.env(?!\.(example|sample|template)\b)(\.[\w.-]+)?END`),
  sensitive(String.raw`^START(id_rsa|id_ed25519|id_ecdsa|id_dsa)(?![\w-]*\.pub\b)`),
  sensitive(String.raw`^START(\.npmrc|\.netrc|_netrc|\.pypirc)END`),
  sensitive(String.raw`[\\/]\.docker[\\/]config\.json`),
  sensitive(String.raw`[\\/]gh[\\/]hosts\.yml`),
  // Browsers (Chrome, Edge, Brave, Opera…): saved passwords, cookies, autofill, and the key that decrypts them.
  sensitive(String.raw`[\\/](login data|cookies|web data|local state)(-journal)?END`),
  // Firefox
  sensitive(String.raw`[\\/](logins\.json|key[34]\.db|cookies\.sqlite|signons\.sqlite)END`),
  // Windows: saved credentials, the vault, DPAPI master keys, the password hives, Wi-Fi keys.
  sensitive(String.raw`[\\/]microsoft[\\/](credentials|vault|protect)([\\/]|END)`),
  sensitive(String.raw`[\\/]system32[\\/]config[\\/](regback[\\/])?(sam|security|system)END`),
  /[\\/]wlansvc[\\/]profiles/i,
  // App logins: Discord / Telegram sessions, Steam, password managers, VPN state, Harv's own browser.
  /[\\/]discord\w*[\\/]local storage/i,
  /[\\/]telegram desktop[\\/]tdata/i,
  /[\\/]steam[\\/](ssfn|config[\\/](loginusers|config)\.vdf)/i,
  sensitive(String.raw`[\\/](bitwarden|1password|keepassxc|logmein hamachi)([\\/]|END)`),
  /[\\/]tailscale[\\/][^\\/]*state/i,
  // Harv's own browsers (the shared one, Gemini's): their logins, cookies and history, at any depth (audit S3).
  /[\\/]\.harv[\\/](browser-profile|gemini-profile|browser-data)([\\/]|$)/i,
  sensitive(String.raw`[\\/]glab-cli[\\/]config\.ymlEND`),
  // Linux: the password hashes, sudo rules, the desktop keyrings (GNOME Keyring, KDE Wallet), pass.
  sensitive(String.raw`[\\/]etc[\\/](g?shadow-?|sudoers(\.d)?)END`),
  /[\\/]keyrings([\\/]|$)/i,
  /[\\/]kwalletd?([\\/]|$)/i,
  /[\\/]\.password-store([\\/]|$)/i,
];

/**
 * Key and certificate files, by extension. Only tested on whole file names: in code
 * (`e.key`, `cert.pem` in a sentence) the same letters are no file at all.
 */
const KEY_FILE = /\.(pem|key|pfx|p12|kdbx|ppk|ovpn|jks|keystore)$/i;

/**
 * A `.pem` named as a public certificate (`platform.x509.pem`, `cert.pem`, `fullchain.pem`, `ca.pem`,
 * `server.pub.pem`): no login secret. 2026-11-25: comparing AOSP's public test certificate's fingerprint
 * was hard-blocked. A name that also says key/private/secret stays one (`cert-key.pem`, `privkey.pem`).
 */
const PUBLIC_CERT = /^(?!.*(key|priv|secret))(?=.*(x509|cert|crt|chain|(^|[._-])ca([._-]|$)|(^|[._-])pub([._-]|$)|public)).*\.pem$/i;

const hasKeyFile = (p: string) => p.split(/[\\/]/).some((part) => KEY_FILE.test(part) && !PUBLIC_CERT.test(part));

export function isSensitivePath(p: string): boolean {
  return (SENSITIVE_PATHS.some((re) => re.test(p)) || hasKeyFile(p)) && !isClaudeHistory(p);
}

/**
 * A command's shell lines mention a credential file (key files only as whole command words, like
 * `cat server.key`). In PowerShell an unquoted `$x.Key` / `$_.Pem` is a property, not a file
 * (a sensor script's `$_.Key -match …` was blocked, 2026-11-01); in Bash `$f.pem` is a file name.
 */
const PS_PROPERTY = /^\$[\w:]+(\.\w+)+$/;

const SEARCHERS = /^(grep|egrep|fgrep|rg|ag|ack|findstr|select-string|sls)(\.exe)?$/i;

/** The command with each search's pattern left out (after -e/--regexp/-Pattern, else its first plain word). */
function withoutSearchPatterns(shell: string): string {
  return splitCommand(shell)
    .map((segment) => {
      const ws = words(segment);
      const program = unquote(ws[0] ?? '');
      if (!SEARCHERS.test(program)) return segment;
      // Only findstr takes `/i` options; the word after `-f`/`--file`/`-Path` is a file to read, not a pattern.
      const option = /^findstr/i.test(program) ? /^[-/]/ : /^-/;
      const takesFile = (w: string | undefined) => w !== undefined && /^(-f|--file|-path|-literalpath)$/i.test(unquote(w));
      const isFlag = (w: string) => /^(-e|--regexp|-pattern)$/i.test(unquote(w));
      const skip = new Set<number>();
      ws.forEach((w, i) => {
        if (isFlag(w)) skip.add(i + 1);
        if (/^--regexp=/i.test(unquote(w))) skip.add(i);
      });
      if (skip.size === 0) {
        const first = ws.findIndex((w, i) => i > 0 && !option.test(unquote(w)) && !takesFile(ws[i - 1]));
        if (first > 0) skip.add(first);
      }
      return ws.filter((_, i) => !skip.has(i)).join(' ');
    })
    .join(' ; ');
}

/**
 * Programs that only see a secret file's name or use a login through its own program: naming a
 * secret to them reads nothing (`ls ~/.ssh`, `chmod 600 ~/.ssh/id_ed25519`, `ssh -i key host`,
 * `git config --get-regexp credential`). The notebook chats were blocked for these (2026-11-11).
 */
const NAME_ONLY =
  /^(ls|dir|gci|get-childitem|stat|test|\[|test-path|tree|du|chmod|chown|icacls|ssh-keygen|ssh-add|ssh|gh|glab|command|which|where|where\.exe)$/i;

/** git subcommands that print a file's contents (the rest only use or list them). */
const GIT_SHOWS = /^(show|cat-file|grep|archive|bundle|credential)$/i;

function nameOnly(segment: string): boolean {
  const ws = words(segment).map(unquote);
  const program = (ws[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  if (program === 'git') return !ws.slice(1).some((w) => GIT_SHOWS.test(w));
  if (program === 'find') return !ws.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint\w*|fls)$/i.test(w));
  return NAME_ONLY.test(program);
}

/** The command without its name-only parts, unless a later part reads what they list (`ls ~/.ssh | xargs cat`). */
function withoutNameOnly(shell: string): string {
  const segments = splitCommand(shell);
  if (segments.some((s) => /^xargs\b/i.test(s.trim()))) return shell;
  return segments.filter((s) => !nameOnly(s)).join(' ; ');
}

export function mentionsSecret(shell: string, powershell = false): boolean {
  shell = withoutNameOnly(shell);
  // git's credential *settings* (`credential.helper`, `credential.https://x.helper`, `credential.username`)
  // name a helper, not a secret: `git config --get-all credential.helper` was blocked (2026-11-10).
  // Nor do a search's pattern (`grep -E "remote|credential"` looks for a word, the files it reads are
  // still checked) and the helper programs `git-credential*` (glab's `auth git-credential`), 2026-11-10.
  const text = withoutSearchPatterns(withoutAllowedClaude(shell))
    .replace(/\bcredential(\.[^\s"'=]+)?\.(helper|usehttppath|username)\b/gi, '')
    .replace(/\bgit-credential(-[\w-]+)?(\.exe)?\b(?!s)/gi, '');
  // `--env-file=.env` names the file as much as `--env-file .env` (it was red vs blocked: the full review, S15).
  const spaced = text.replace(/["']/g, ' ').replace(/(\s--?[\w-]+)=/g, '$1 ');
  if (SENSITIVE_PATHS.some((re) => re.test(spaced))) return true;
  return words(text).some((w) => {
    const file = unquote(w).split('=').at(-1)!;
    if (powershell && PS_PROPERTY.test(w)) return false;
    return !/[\s(){}<>,;]/.test(file) && hasKeyFile(file);
  });
}

/**
 * Claude Code's history (~/.claude/projects/<folder>/): earlier sessions' transcripts
 * (`<session>.jsonl`, the user's wish 2026-10-25), tool outputs too big for the chat
 * (Harv is told to read them there) and the project memory notes. Readable although
 * it's under .claude; the login and settings next to it stay blocked.
 */
export function isClaudeHistory(p: string): boolean {
  return isInside(fullPath(p), join(homedir(), '.claude', 'projects'));
}

/**
 * Claude Code's project memory notes (~/.claude/projects/<folder>/memory/*.md). Project
 * chats share them with Claude Code, so they may write them too.
 */
export function isClaudeMemory(p: string): boolean {
  const path = fullPath(p);
  return isClaudeHistory(path) && /[\\/]memory[\\/][^\\/]+\.md$|[\\/]memory[\\/]?$/i.test(path);
}

/**
 * Claude Code's own setup (~/.claude: the user's CLAUDE.md, skills, plugins, settings, agents).
 * Since 2026-10-31 (the user: "the same access to my computer as you") Harv reads and changes it
 * like any of the user's files (backed up, Undo), except: the login, the session history, and a
 * change that would make Claude Code bill per token (BILLING_SETTING).
 */
export function isClaudeSetup(p: string): boolean {
  const path = fullPath(p);
  return isInside(path, join(homedir(), '.claude')) && !isClaudeHistory(path);
}

/** Settings that move Claude Code off the subscription onto per-token billing: never written by Harv. */
export const BILLING_SETTING = new RegExp(`${BILLED_ENV_NAMES}|apiKeyHelper|awsAuthRefresh|awsCredentialExport`, 'i');

/**
 * Files Claude Code or a shell reads settings or environment from (the full review, S8: the stop
 * covered only ~/.claude). A `.env` counts too: the user wants no API key written anywhere.
 */
export function isSettingsPlace(p: string): boolean {
  const path = fullPath(p).replace(/\\/g, '/');
  const home = homedir().replace(/\\/g, '/');
  const inHome = (rel: string) => path.toLowerCase() === `${home}/${rel}`.toLowerCase();
  if (/\/\.claude\/settings[^/]*\.json$/i.test(path)) return true;
  if (inHome('.claude.json')) return true;
  if (/^[a-z]:\/programdata\/claudecode\//i.test(path) || /^\/etc\/claude-code\//.test(path)) return true;
  if (['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.pam_environment'].some(inHome))
    return true;
  if (/\/\.config\/(fish|environment\.d)\//i.test(path)) return true;
  if (/\/documents\/(windows)?powershell\/[^/]*profile\.ps1$/i.test(path)) return true;
  if (/^\/etc\/(profile|environment|profile\.d\/)/.test(path)) return true;
  return /\/\.env(\.[\w.-]+)?$/i.test(path) && !/\.(example|sample|template)$/i.test(path);
}

/** What a file tool call writes (not what it replaces: an Edit that removes a key isn't one that sets it). */
function newText(input: Record<string, unknown>): string {
  const parts: unknown[] = [input.content, input.new_string, input.new_source];
  if (Array.isArray(input.edits)) for (const e of input.edits) parts.push((e as Record<string, unknown>)?.new_string);
  return parts.filter((p) => typeof p === 'string').join('\n');
}

/** A write into a settings place that would turn on per-token billing (checked on the new text). */
export function writesBillingSetting(path: string, input: Record<string, unknown>): boolean {
  return isSettingsPlace(path) && BILLING_SETTING.test(newText(input));
}

const NAME = `(?:${BILLED_ENV_NAMES})`;
/** A value that clears instead of sets: nothing, "", '' or $null. */
const CLEARS = String.raw`(?:$|\s|""|''|\$null\b)`;
/** Ways to set an environment name for a program, a shell, the user or the system. */
const SETS_ENV = [
  new RegExp(String.raw`^(?:(?:export|declare|typeset|set|env)\s+(?:-\w+\s+)*)?${NAME}\s*=(?!${CLEARS})`, 'i'),
  new RegExp(String.raw`\$env:${NAME}\s*=\s*(?!${CLEARS})`, 'i'),
  new RegExp(String.raw`\bsetx(\.exe)?\s+(?:/\w+\s+)*["']?${NAME}["']?\s+(?!${CLEARS})`, 'i'),
  new RegExp(String.raw`SetEnvironmentVariable\(\s*['"]${NAME}['"]\s*,(?!\s*(\$null|""|''))`, 'i'),
  new RegExp(String.raw`\b(set-item|new-item|si|ni)\s+(-path\s+)?['"]?env:${NAME}`, 'i'),
  new RegExp(String.raw`\b(new-itemproperty|set-itemproperty|reg(\.exe)?\s+add)\b.*\b${NAME}\b`, 'i'),
  new RegExp(String.raw`\blaunchctl\s+setenv\s+${NAME}|\bsystemctl\s+(--user\s+)?set-environment\s+${NAME}`, 'i'),
  new RegExp(String.raw`\bclaude\b.*\b(config\s+set|--settings)\b.*(${NAME}|apiKeyHelper)`, 'i'),
];
/** A billing name written in a setting's shape (into a profile, a settings file, a .env). */
const SETTING_SHAPE = new RegExp(String.raw`${NAME}\s*=\s*\S|["']${NAME}["']\s*:|export\s+${NAME}\b|apiKeyHelper`, 'i');
const WRITES = /(^|[^\d&])>|\b(tee|set-content|add-content|out-file|sc|ac)\b|\bsed\s+(-\w+\s+)*-i/i;

/**
 * A command that puts a billing name where Claude Code would pick it up (the full review, S8): it
 * sets the name in an environment (tested on what runs), or writes it into any file in a setting's
 * shape (tested on the whole text: an `echo … >>` is left out of what runs). Reading or clearing it is fine.
 */
export function setsBillingEnv(command: string, running: string): boolean {
  if (splitCommand(running).some((segment) => SETS_ENV.some((re) => re.test(segment.trim())))) return true;
  const { shell, bodies } = splitHeredocs(command);
  if (splitCommand(shell).some((segment) => WRITES.test(segment) && SETTING_SHAPE.test(segment))) return true;
  return bodies.length > 0 && WRITES.test(shell) && bodies.some((b) => SETTING_SHAPE.test(b.text));
}

/** Claude Code's history named in a command (allowed, although it's under .claude; see isClaudeHistory). */
const CLAUDE_ALLOWED_IN_COMMAND = /\S*\.claude[\\/]projects(?=$|[\\/\s"'])[^\s"']*/gi;

/** The command with those allowed .claude paths taken out (unless they climb out with `..`). */
const withoutAllowedClaude = (command: string) => command.replace(CLAUDE_ALLOWED_IN_COMMAND, (m) => (m.includes('..') ? m : ' '));
