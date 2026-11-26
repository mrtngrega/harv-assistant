import { CHANGING_WORDS } from './base.ts';
import { unquote, words } from './shell.ts';

/** Commands that only read or show information. */
const GREEN_COMMANDS = new Set(
  (
    'ls dir pwd cd echo cat type head tail wc grep rg findstr which where where.exe whoami hostname date uname df du file stat tree sort uniq cut ' +
    'tasklist systeminfo ipconfig ping nslookup tracert netstat nvidia-smi ver get-date ' +
    'select-object select where-object ? sort-object format-table ft format-list fl measure-object measure select-string sls test-path resolve-path ' +
    'split-path join-path out-string out-host write-output write-host convertto-json convertfrom-json compare-object group-object gci gc gps gsv gl gi ' +
    'free uptime ps lsblk lscpu lspci lsusb sensors id ss nproc realpath basename dirname lsof ' +
    'fc-list nl md5sum sha1sum sha256sum sha512sum cksum column tr rev jq printf test [ true false identify'
  ).split(' '),
);

const GREEN_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'ls-files',
  'ls-remote',
  'rev-parse',
  'blame',
  'remote',
  'branch',
  'tag',
  'describe',
  'config',
]);

/** Programs that only show information when their first argument is one of these. */
const READ_ONLY_PROGRAMS: Record<string, RegExp> = {
  ollama: /^(list|ls|ps|show|--version|-v)$/i,
  winget: /^(list|search|show|--version|-v)$/i,
  npm: /^(ls|list|ll|view|info|outdated|root|prefix|--version|-v)$/i,
  pnpm: /^(ls|list|outdated|--version|-v)$/i,
  yarn: /^(list|info|--version|-v)$/i,
  pip: /^(list|show|freeze|--version|-V)$/,
  pip3: /^(list|show|freeze|--version|-V)$/,
  node: /^(--version|-v)$/i,
  python: /^(--version|-V)$/,
  python3: /^(--version|-V)$/,
  py: /^(--version|-V|--list|-0)$/,
  dotnet: /^(--version|--info|--list-sdks|--list-runtimes)$/i,
  docker: /^(ps|images|version|info)$/i,
  wsl: /^(-l|--list|--status|--version)$/i,
  choco: /^(list|search|info|--version)$/i,
  scoop: /^(list|search|info|status)$/i,
  code: /^(--version|--list-extensions)$/i,
  tailscale: /^(status|ip|version)$/i,
  java: /^(-version|--version)$/,
  javac: /^(-version|--version)$/,
  adb: /^(devices|version|get-state|get-serialno)$/,
  magick: /^(identify|-version|--version)$/,
  dnf: /^(list|info|search|repolist|repoquery|history|check-update|--version)$/i,
  rpm: /^(-q[a-z]*|--query|--version)$/,
  flatpak: /^(list|info|search|remotes|history|--version)$/i,
  systemctl: /^(status|list-units|list-unit-files|list-timers|is-active|is-enabled|is-failed|show|cat|--failed|--version)$/i,
  hostnamectl: /^status$/i,
  timedatectl: /^status$/i,
  powercfg: /^[/-](l|list|q|query|a|availablesleepstates|getactivescheme|requests)$/i,
};

const LITERAL_ASSIGN = /^\s*[A-Za-z_]\w*=(?:"[^"$`\\]*"|'[^']*'|[^\s$`"'()|;&<>]*)(?=\s|$)/;
const SUBSTITUTION_ASSIGN = /^\s*[A-Za-z_]\w*=\$\(/;

/**
 * A command part without what changes nothing on disk: plain variable assignments alone (`f=a.txt`,
 * `A="timeout 50 adb"` → empty), and the `NAME=$(` / `)` around a substitution the lexer split at its
 * pipes (`f=$(ls -t | sed -n 2p)` → `ls -t`, `sed -n 2p`), so the inner command is judged itself.
 * `X=1 cmd` stays whole: a variable in front can make a reader run code (`LD_PRELOAD`). 2026-11-26:
 * `f=$(ls -t *.jsonl | sed -n 2p)` in Claude Code's history folder was held as changing it.
 */
export function withoutAssignments(segment: string): string {
  let s = segment;
  const sub = SUBSTITUTION_ASSIGN.exec(s);
  if (sub) s = s.slice(sub[0].length);
  else {
    let rest = s;
    for (let m = LITERAL_ASSIGN.exec(rest); m; m = LITERAL_ASSIGN.exec(rest)) rest = rest.slice(m[0].length);
    if (rest.trim() === '') return '';
  }
  s = s.trim();
  // The substitution's closing paren the lexer left on its last part.
  let unmatched = (s.match(/\)/g) ?? []).length - (s.match(/\(/g) ?? []).length;
  while (unmatched > 0 && s.endsWith(')')) {
    s = s.slice(0, -1).trimEnd();
    unmatched--;
  }
  return s;
}

/** `ollama list`, `npm --version`: a program from the list above, asked only to show something. */
export function isReadOnlyProgram(name: string, args: string[]): boolean {
  const program = name.toLowerCase().replace(/\.exe$/, '');
  const first = args.find((a) => a.length > 0);
  return Object.hasOwn(READ_ONLY_PROGRAMS, program) && first !== undefined && READ_ONLY_PROGRAMS[program]!.test(first);
}

const PS_KEYWORDS = new Set(
  'if else elseif foreach for while do until switch return break continue try catch finally in default begin process end'.split(' '),
);

/** PowerShell commands that only read: Get-*, Test-*, filters, formatting. */
const PS_READ_CMDLET =
  /^(get|test|resolve|measure|select|sort|group|where|foreach|compare|convertto|convertfrom|split|join)-[a-z]+$|^(format-(table|list|wide|custom|hex)|out-(string|null|host|default)|write-(output|host)|start-sleep)$/;

const PS_READ_ALIASES = new Set('% ? foreach where sort select measure group gp gpv gm gcm gal'.split(' '));

/** .NET methods that only compute or read; any other method call (`.Delete()`, `.Kill()`, `::Start(`) isn't read-only. */
const SAFE_METHODS = new Set(
  (
    'tostring substring trim trimend trimstart tolower toupper tolowerinvariant toupperinvariant replace split join contains startswith endswith ' +
    'indexof lastindexof padleft padright insert normalize equals compareto gettype gethashcode format concat isnullorempty isnullorwhitespace ' +
    'round floor ceiling truncate max min abs pow sqrt log log10 sign parse tryparse toint32 toint64 todouble todecimal toboolean tochararray ' +
    'tobase64string frombase64string adddays addhours addminutes addseconds addmilliseconds addmonths addyears subtract toshortdatestring ' +
    'tolongdatestring toshorttimestring touniversaltime tolocaltime fromfiletime now today match matches ismatch escape unescape toarray ' +
    'getfolderpath getenvironmentvariable getenvironmentvariables getlogicaldrives getfilename getextension getdirectoryname ' +
    'getfilenamewithoutextension combine getfullpath getpathroot gettemppath exists getfiles getdirectories getfilesystementries ' +
    'enumeratefiles enumeratedirectories getlastwritetime getcreationtime getattributes readalltext readalllines getvalue getvaluenames ' +
    'getsubkeynames getbytes getstring openread add'
  ).split(' '),
);

/**
 * A PowerShell command that only reads, however it's put together: pipelines, script blocks
 * (`ForEach-Object { … }`, `@{n=…;e={…}}`), variables, `[math]::Round(…)`. Every command
 * that runs, wherever it sits, must be a read-only one, and every .NET call a harmless one.
 */
export function isReadOnlyPowerShell(command: string): boolean {
  // Here-strings are hard to read safely.
  if (/@["']/.test(command)) return false;
  // Strings are data, but "…$(…)…" runs code inside a string.
  let code = command.replace(/'[^']*'/g, "''");
  if (/"[^"]*\$\(/.test(code)) return false;
  code = code.replace(/"[^"]*"/g, '""');
  // An unclosed quote, a backtick (escapes, line continuations) or a comment.
  if (/['"`#]/.test(code.replace(/''|""/g, ''))) return false;

  for (const m of code.matchAll(/(?:\.|::)\s*([A-Za-z_]\w*)\s*\(/g)) {
    if (!SAFE_METHODS.has(m[1]!.toLowerCase())) return false;
  }
  // A method named by a string or a variable: `$x.'Delete'()`, `$x.$name()`.
  if (/(\.|::)\s*(''|""|\$\w*)\s*\(/.test(code)) return false;

  const tokens = code.match(/\$\(|@\(|@\{|&&|\|\||\[[^\]]*\]|[|;{}()=,\n\r]|[^\s|;{}()=,]+/g) ?? [];
  // What each open bracket is: a hashtable (keys come before `=`), or a block/pipeline.
  const stack: ('hash' | 'block')[] = [];
  let expectCommand = true;
  let hashKey = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const lower = t.toLowerCase();
    if (t === '@{') {
      stack.push('hash');
      hashKey = true;
      expectCommand = false;
      continue;
    }
    if (t === '{' || t === '(' || t === '$(' || t === '@(') {
      stack.push('block');
      expectCommand = true;
      continue;
    }
    if (t === '}' || t === ')') {
      stack.pop();
      expectCommand = false;
      continue;
    }
    const inHash = stack.at(-1) === 'hash';
    if (t === ';' || t === '\n' || t === '\r') {
      if (inHash) hashKey = true;
      else expectCommand = true;
      continue;
    }
    if (t === '|' || t === '&&' || t === '||' || t === '=' || t === ',') {
      // `a = b` and `x, (Get-Date)`: what follows may be a command.
      if (inHash && t === '=') hashKey = false;
      expectCommand = t !== ',';
      continue;
    }
    if (inHash && hashKey) continue; // a hashtable key
    if (!expectCommand) continue; // an argument or operator
    expectCommand = false;
    // A string in command position followed by another word is a program run by its path
    // (`"C:\x\uninstall.exe" /S`), not a value (the full review, S6).
    if ((t === "''" || t === '""') && i + 1 < tokens.length) {
      const after = tokens[i + 1]!;
      if (!/^([|;)},=\n\r]|-[a-z]+$|\+|\.)/i.test(after)) return false;
    }
    // Values, not commands: variables, types/casts, numbers, strings, operators like -not.
    if (/^[$[\d'"@!-]/.test(t)) {
      // `[math]::Round(...)` and `$x.Method()` were checked above; `$x = ...` continues as an assignment.
      continue;
    }
    if (t === '&' || t === '.' || t.startsWith('.') || /[\\/]/.test(t)) return false; // call operator, dot-sourcing, a script by path
    const next = (tokens[i + 1] ?? '').toLowerCase();
    if (lower === 'foreach-object' || lower === '%' || (lower === 'foreach' && next !== '(')) {
      // `% Delete` calls a method on every item; only a script block is read here.
      if (next !== '{' && next !== '-process') return false;
      continue;
    }
    if (PS_KEYWORDS.has(lower)) {
      expectCommand = lower !== 'in';
      continue;
    }
    if (PS_READ_CMDLET.test(lower) && !/^get-(credential|storedcredential)$/.test(lower)) continue;
    if (PS_READ_ALIASES.has(lower) || (GREEN_COMMANDS.has(lower) && !CHANGING_WORDS.has(lower))) continue;
    // An outside program: read-only only when it's asked to show something.
    const args: string[] = [];
    for (let j = i + 1; j < tokens.length && !/^([|;})\n\r]|&&|\|\|)$/.test(tokens[j]!); j++) args.push(unquote(tokens[j]!));
    if (isReadOnlyProgram(lower, args)) continue;
    return false;
  }
  return true;
}

/**
 * sed that only prints: no in-place edit (`-i`), no script file, and no command that
 * writes or runs something (`w`, `W`, `r`, `R`, `e`, or the `w`/`e` flags of `s`).
 */
export function isPrintOnlySed(args: string[]): boolean {
  const scripts: string[] = [];
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-e' || a === '--expression') scripts.push(args[++i] ?? '');
    else if (/^--expression=/.test(a)) scripts.push(a.slice(13));
    else if (/^-[a-zA-Z]*[if]|^--(in-place|file)/.test(a)) return false;
    else if (/^-/.test(a)) continue;
    else if (scripts.length === 0 && !positional) {
      scripts.push(a);
      positional = true;
    }
  }
  if (scripts.length === 0) return false;
  return scripts.every((script) => {
    let flagsOk = true;
    const rest = script
      // s/a/b/flags and y/abc/xyz/ (any delimiter): keep only the flags.
      .replace(/([sy])([^\w\s\\])((?:\\.|(?!\2).)*)\2((?:\\.|(?!\2).)*)\2([a-zA-Z0-9]*)/g, (_m, _c, _d, _a, _b, flags: string) => {
        if (/[we]/.test(flags)) flagsOk = false;
        return ';';
      })
      // /regex/ addresses
      .replace(/\/(?:\\.|[^/])*\//g, '');
    return flagsOk && /^[\s\d,$;!{}pdnqgPDNhHxG=~+-]*$/.test(rest);
  });
}

/** gh commands that only look: listing and viewing, auth status, GET-only `gh api`. */
function isReadOnlyGh(args: string[]): boolean {
  const [group = '', action = ''] = args;
  if (group === '--version' || (group === 'auth' && action === 'status')) return true;
  if (group === 'search') return true;
  if (group === 'api') return !args.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)/.test(a));
  return /^(repo|pr|issue|release|run|workflow|gist|label|cache|ruleset)$/.test(group) && /^(list|view|status|diff|checks)$/.test(action);
}

export function isGreenSegment(segment: string): boolean {
  const ws = words(segment).map(unquote);
  const first = (ws[0] ?? '').toLowerCase();
  if (first === 'git') {
    const sub = (ws[1] ?? '').toLowerCase();
    if (!GREEN_GIT.has(sub) || /\s-(d|D|m|M)\b|--delete|set-url|\b(add|remove|rename|prune|set-head|set-branches|update)\b/.test(segment))
      return false;
    // `git diff --output=f` writes a file.
    if (/\s--output\b/.test(segment)) return false;
    // `git config` only reads with --list/--get…; `git config key value` sets.
    if (sub === 'config')
      return (
        /\s(-l|--list|--get(-all|-regexp|-urlmatch)?)\b/.test(segment) &&
        !/\s--(add|unset\S*|replace-all|edit|rename-section|remove-section)\b|\s-e\b/.test(segment)
      );
    // `git branch x` / `git tag x` make one: only listing is reading.
    if (sub === 'branch' || sub === 'tag')
      return (
        ws.slice(2).every((w) => w.startsWith('-')) &&
        !(sub === 'branch' ? /\s-(c|C|f|u)\b/ : /\s-(a|s|u|f|e)\b/).test(segment) &&
        !/--(copy|force|annotate|sign|edit|set-upstream\S*|unset-upstream)/.test(segment)
      );
    return true;
  }
  // Read-only programs with options that write a file or run another program.
  if (first === 'sort') return !/\s(-o\S*|--output\S*)/.test(segment);
  if (first === 'uniq') return ws.slice(1).filter((w) => !w.startsWith('-')).length <= 1;
  if (first === 'rg') return !/\s--pre(-glob)?\b/.test(segment);
  if (first === 'tree') return !/\s-o\b/.test(segment);
  if (first === 'ss') return !/\s(-K|--kill)\b/.test(segment);
  if (first === 'hostname') return ws.slice(1).every((w) => w.startsWith('-') && !/^(-F|--file)$/.test(w));
  if (first === 'nvidia-smi')
    return !/\s-(pl|r|ac|lgc|pm|rac)\b|--(power-limit|gpu-reset|applications-clocks|lock-gpu-clocks)/i.test(segment);
  if (first === 'ipconfig') return !/\/(release|renew)/i.test(segment);
  if (first === 'find') return !/-(delete|exec|execdir|ok|fprint|fls)/.test(segment);
  // Logs: reading only (`--vacuum-*`, `--rotate`, `--flush` delete or move them).
  if (first === 'journalctl') return !/--(vacuum|rotate|flush|relinquish|sync|setup-keys|update-catalog)/.test(segment);
  // `ip addr`, `ip route`: showing only, never `add`/`del`/`set`/`flush`.
  if (first === 'ip')
    return (
      /^(-\S+\s+)*(a|addr|address|r|route|l|link|n|neigh)\b/.test(ws.slice(1).join(' ')) &&
      !/\b(add|del|delete|set|flush|change|replace|append)\b/.test(segment)
    );
  // Printing lines (`sed -n '5,20p' file`, `sed 's/a/b/g' file`), never editing in place or writing files.
  if (first === 'sed') return isPrintOnlySed(ws.slice(1));
  // awk programs that only print: no shell calls, pipes, redirections or program files.
  if (first === 'awk' || first === 'gawk')
    return !/\s(-i|--inplace|-f|--file)\b|\bsystem\s*\(|getline|[|>]/.test(
      ` ${ws
        .slice(1)
        .filter((w) => !/^-F/.test(w))
        .join(' ')}`,
    );
  if (first === 'date') return !/\s(-s|--set)\b/.test(segment);
  if (first === 'gh') return isReadOnlyGh(ws.slice(1));
  if (/^get-[a-z]+$/.test(first)) return !/get-(credential|storedcredential)/.test(first);
  return GREEN_COMMANDS.has(first);
}
