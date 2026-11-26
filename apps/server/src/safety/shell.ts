import { existsSync, statSync } from 'node:fs';
import { fullPath, isInside, isTempDir, WORKSPACE } from './paths.ts';
import { type ClassifyContext } from './base.ts';

/** Quoted strings in a script: where the paths and shell commands of Python or JavaScript code are. */
const quotedStrings = (text: string) => [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2] ?? '');

/** Words and strings of a script that look like paths (a folder, `~`, a dot file, a file name). */
const looksLikePath = (s: string) =>
  // A name is needed: a lone "/" or the "/255" of a division isn't a path.
  /[a-z]/i.test(s) && !/\s{2}|[\n<>|]/.test(s) && (/[\\/]/.test(s) || /^[~.]/.test(s) || /^[\w.-]+\.\w+$/.test(s));

export const scriptPaths = (text: string) =>
  [...quotedStrings(text), ...text.split(/[\s"'`(),;=]+/).filter((w) => /[\\/]/.test(w))].filter(looksLikePath);

/** Commands that only look a program up, print or search text: a blocked name in them runs nothing (`command -v sfdisk`). */
const INERT_START =
  /^(command\s+-v\b|which\b|where\.exe\b|whereis\b|type\b|man\b|apropos\b|get-command\b|gcm\b|get-help\b|echo\b|printf\b|write-host\b|write-output\b|grep\b|egrep\b|fgrep\b|rg\b|findstr\b|select-string\b|sls\b)/i;

const COMMENT_START = /^(#|rem\b|::)/i;

/** A command substitution: it runs even inside an echo (`echo $(sfdisk -l)`). PowerShell's `r`n escapes aren't one. */
const SUBSTITUTION = /\$\(|<\(|`(?![rnt0abfv`'"$\s])/;

export const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;

/**
 * The parts of a command that run something. Lookups, prints, searches and comments are left
 * out (unless they run a substitution); quoted strings are read the same way, since they may be
 * commands for another shell (`ssh host 'command -v sfdisk'`). The Win11 install chat was blocked
 * for checking that sfdisk was installed (2026-11-09).
 */
export function runningParts(text: string, depth = 0): string {
  const out: string[] = [];
  for (const segment of splitCommand(text)) {
    const start = segment.replace(/^[({\s]+/, '').replace(/^(sudo|doas)\s+(-\S+\s+)*/i, '');
    if (COMMENT_START.test(start)) continue;
    if (INERT_START.test(start) && !SUBSTITUTION.test(segment)) continue;
    out.push(
      depth < 3
        ? segment.replace(QUOTED, (q, at: number) =>
            isTextArgument(start, segment.slice(0, at)) && !SUBSTITUTION.test(q)
              ? q.charAt(0).repeat(2)
              : q[0] + runningParts(q.slice(1, -1), depth + 1) + q[0],
          )
        : segment,
    );
  }
  return out.join('\n');
}

/** `pkill -f <pattern>`: matches the whole command line, so a pattern from its arguments picks out one start. */
const PKILL_FULL = /^pkill\s+((-\w*f\w*|-\d+|-[A-Z]+|--signal\s+\S+)\s+)+(["']?)([^"'\s]+)\3$/;
/** `kill $(pgrep -f <pattern>)`, the same by another road. */
const KILL_PGREP = /^kill\s+(-\S+\s+)*\$\(\s*pgrep\s+(-\w+\s+)*-\w*f\w*\s+(-\w+\s+)*(["']?)([^"'\s)]+)\4\s*\)$/;
/** PowerShell's `pkill -f`: a pipeline that keeps processes by their command line, then stops them. */
const PS_BY_COMMAND_LINE = /CommandLine\s+-(like|match|clike|cmatch)\s+(["'])\*?([^"'*]+?)\*?\2/i;
const PS_STOP = /^(stop-process|spps)(\s+-force)?$|^(foreach-object|%)\s*\{\s*\$_\.kill\(\s*\)\s*\}$|^invoke-cimmethod\b[^\n]*terminate/i;
const STARTED_IN_BACKGROUND = /&\s*$|^(\$\w+\s*=\s*)?(nohup|setsid|start-process|saps)\b/i;
/** A line without the PowerShell variable it's assigned to (`$p = Start-Process …`). */
const unassigned = (line: string) => line.trim().replace(/^\$\w+\s*=\s*/, '');

/**
 * The arguments of a start line, without its program: what a kill pattern may name. `Start-Process x
 * -ArgumentList '…'` gives only the argument list (its program path would match the user's own windows).
 */
export function startArguments(line: string): string {
  const b = unassigned(line);
  if (/^(start-process|saps)\b/i.test(b)) {
    const args = /\s-(argumentlist|args)\s+([\s\S]*)$/i.exec(b);
    return args ? args[2]! : '';
  }
  return b.replace(/^(nohup|setsid)\s+(-\S+\s+)*/i, '').replace(/^("[^"]*"|'[^']*'|\S+)/, '');
}

/** The lines of a command that start a program Harv keeps running (to remember for later kills). */
export function startedLines(running: string, wholeCommandInBackground = false): string[] {
  return running
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && (wholeCommandInBackground || STARTED_IN_BACKGROUND.test(l)))
    .filter((l) => startArguments(l).trim().length > 0);
}

/**
 * PowerShell stopping the very process it started in this command: `$p = Start-Process … -PassThru`, then
 * `Stop-Process -Id $p.Id`, `$p | Stop-Process` or `$p.Kill()`.
 */
function ownVariable(line: string, before: string[]): boolean {
  const prev = before.at(-1)?.trim() ?? '';
  const name =
    /^(?:stop-process|spps)\s+(?:-force\s+)?-id\s+\$(\w+)\.id(?:\s+-force)?$/i.exec(line)?.[1] ??
    /^\$(\w+)\.kill\(\s*\)$/i.exec(line)?.[1] ??
    (PS_STOP.test(line) ? /^\$(\w+)$/.exec(prev)?.[1] : undefined);
  if (!name) return false;
  const start = new RegExp(`^\\$${name}\\s*=\\s*(start-process|saps)\\b.*-passthru`, 'i');
  return before.some((b) => start.test(b.trim()));
}

const SCRIPT_FILE = /\.(sh|bash|py|js|mjs|cjs|ts|mts|ps1|bat|cmd|rb|pl|jar)$/i;

/**
 * A kill pattern naming a script file that exists in the project, the workspace or the temp folder: only
 * runs of that script match it, and those are the job's own, wherever they started (2026-11-26, the car
 * launcher chat: `pkill -f "tools/unit-slim.sh"` stopping its own stuck test runs was held). A script file
 * only: a folder or a document in the project would also match the user's editor that has it open.
 */
function jobsOwnScript(target: string, project?: string): boolean {
  if (!SCRIPT_FILE.test(target) || !/[/\\]/.test(target) || /[*?[]/.test(target)) return false;
  const full = fullPath(target, project ?? WORKSPACE);
  if (!existsSync(full)) return false;
  return (project !== undefined && isInside(full, project)) || isInside(full, WORKSPACE) || isTempDir(full);
}

/** A kill pattern specific enough to pick out one start: a path, `x=y` or a port, never a bare name. */
const specific = (target: string) => target.length >= 6 && /[/\\=]|:\d{3,5}\b/.test(target);

/**
 * Of a command's running text: the kills that stop only a program Harv started himself left out: started
 * in the background earlier in the same command, or in an earlier step of this chat (`started`, kept by
 * the gate). His own program is his to stop (persona rule 17 asks only for programs that aren't his); the
 * ShopNotes chat (2026-11-23) held a test run because it closed its own headless Chrome at the end. The
 * kill must name the start by a specific argument (`pkill -f`, `kill $(pgrep -f …)`, PowerShell's
 * `Where-Object CommandLine -like … | Stop-Process`), never by program name, which would also hit the
 * user's own windows of it.
 */
export function dropOwnKills(running: string, started: readonly string[] = [], project?: string): string {
  const lines = running.split('\n');
  const own = (target: string, before: string[]) =>
    specific(target) &&
    ([...before.filter((b) => STARTED_IN_BACKGROUND.test(b.trim())), ...started].some((b) => startArguments(b).includes(target)) ||
      jobsOwnScript(target, project));
  const drop = new Set<number>();
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const pk = PKILL_FULL.exec(line);
    const pg = KILL_PGREP.exec(line);
    if (pk && /-\w*f/.test(pk[1]!)) {
      if (own(pk[4]!, lines.slice(0, i))) drop.add(i);
    } else if (pg) {
      if (own(pg[5]!, lines.slice(0, i))) drop.add(i);
    } else if (ownVariable(line, lines.slice(0, i))) {
      drop.add(i);
    } else if (PS_STOP.test(line) && i > 0) {
      const filter = PS_BY_COMMAND_LINE.exec(lines[i - 1]!);
      if (filter && own(filter[3]!, lines.slice(0, i - 1))) drop.add(i);
    }
  });
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

/** Flags whose value is words for people (a commit message, a title, a note), never a command. */
const TEXT_FLAG =
  /(^|\s)(--(message|msg|title|body|subject|description|notes?|comment|reason|summary)(=|\s+)|-m\s*|-(value|inputobject|message)\s+)$/i;
/** The same as short flags of the git-server tools (`gh pr create -t "…" -b "…"`, `glab mr create -d "…"`). */
const FORGE_TEXT_FLAG = /(^|\s)-[tbd]\s*$/;
const FORGES = /^(gh|glab|hub|tea)(\.exe)?\s/i;
/** Programs that only show or log the words they're given. */
const TEXT_PROGRAMS = /^(notify-send|logger|kdialog|zenity|wall|espeak|espeak-ng|say|figlet|toilet|msg)(\.exe)?\s/i;

/**
 * A quoted argument that is text for people, not a command: the gate read commit messages as commands
 * and held `git commit -m "… pkill …"` as stopping programs (the ShopNotes chat, 2026-11-23).
 */
function isTextArgument(start: string, before: string): boolean {
  if (TEXT_PROGRAMS.test(start)) return true;
  if (TEXT_FLAG.test(before)) return true;
  return FORGES.test(start) && FORGE_TEXT_FLAG.test(before);
}

/** PowerShell here-strings are text unless something runs them. */
const RUNS_TEXT = /\biex\b|invoke-expression|scriptblock\]::create|-encodedcommand|\|\s*(powershell|pwsh)(\.exe)?\b/i;

export const maskHereStrings = (command: string) =>
  RUNS_TEXT.test(command) ? command : command.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "@''@");

/** Interpreters whose heredoc or file is their own language: only the commands it starts count. */
export const CODE_RUNNERS = new Set(['python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'wscript']);

/** Of a heredoc or script: the text that runs as commands. */
export const commandsIn = (runner: string, text: string) =>
  DATA_RUNNERS.has(runner)
    ? ''
    : CODE_RUNNERS.has(runner)
      ? PROCESS_API.test(text)
        ? quotedStrings(text).join('\n')
        : ''
      : runningParts(text);

/** A command's text as it will run: data heredocs, here-strings, lookups and prints left out. */
export function runningText(command: string, ctx: ClassifyContext = {}): string {
  if (ctx.shell === 'powershell') return runningParts(maskHereStrings(command));
  const { shell, bodies } = splitHeredocs(command);
  return [runningParts(maskHereStrings(shell)), ...bodies.map((b) => commandsIn(b.runner, b.text))].join('\n');
}

export const EXECUTABLE = /\.(exe|bat|cmd|ps1|vbs|js|jse|wsf|msi|scr|com|lnk|reg|py|sh)$/i;

/** The parts of a command chain: `a && b; c | d` → [a, b, c, d]. Separators inside quotes (`-match 'a|b'`) don't split. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = '';
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (/[;|\n\r]/.test(ch) || (ch === '&' && command[i + 1] === '&')) {
      if (command[i + 1] === ch) i++;
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export interface Heredoc {
  /** The command that reads it (`python3`, `cat`): code for an interpreter, data for cat/tee. */
  runner: string;
  text: string;
}

/**
 * A bash command's heredocs (`python3 - <<'EOF' … EOF`) taken apart from its shell lines.
 * The body is a script or data, not commands for the shell, so reading its words as
 * commands made every script red. Found the way bash does: only outside quotes.
 */
export function splitHeredocs(command: string): { shell: string; bodies: Heredoc[] } {
  let shell = '';
  const bodies: Heredoc[] = [];
  const pending: { tag: string; dash: boolean; runner: string }[] = [];
  let quote = '';
  let lineStart = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') {
        shell += ch + (command[++i] ?? '');
        continue;
      }
      if (ch === quote) quote = '';
      shell += ch;
      continue;
    }
    if (ch === '\\') {
      shell += ch + (command[++i] ?? '');
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      shell += ch;
      continue;
    }
    const op = ch === '<' && command[i - 1] !== '<' ? /^<<(-?)[ \t]*(['"]?)([A-Za-z_][\w-]*)\2/.exec(command.slice(i)) : null;
    if (op) {
      const [whole, dash, , tag] = op;
      const before = splitCommand(shell.slice(lineStart)).at(-1) ?? '';
      pending.push({ tag: tag!, dash: dash === '-', runner: (words(before)[0] ?? '').toLowerCase() });
      shell += ' ';
      i += whole.length - 1;
      continue;
    }
    if (ch === '\n' && pending.length > 0) {
      const piped = pipedInto(shell.slice(lineStart));
      shell += '\n';
      let pos = i + 1;
      for (const { tag, dash, runner: own } of pending.splice(0)) {
        // `cat <<'EOF' | bash`: the text isn't data, it runs.
        const runner = piped && DATA_RUNNERS.has(own) ? piped : own;
        const body: string[] = [];
        while (pos <= command.length) {
          const end = command.indexOf('\n', pos);
          const line = command.slice(pos, end === -1 ? command.length : end).replace(/\r$/, '');
          pos = end === -1 ? command.length + 1 : end + 1;
          if ((dash ? line.replace(/^\t+/, '') : line) === tag) break;
          body.push(line);
        }
        bodies.push({ runner, text: body.join('\n') });
      }
      i = pos - 1; // the loop's i++ lands on the line after the last terminator
      lineStart = shell.length;
      continue;
    }
    if (ch === '\n') lineStart = shell.length + 1;
    shell += ch;
  }
  return { shell, bodies };
}

/** Programs that run what they're given on stdin. */
const STDIN_RUNNERS =
  /^(bash|sh|zsh|dash|ksh|fish|ssh|pwsh|powershell|cmd|xargs|source|eval|python3?|py|node|deno|bun|ruby|perl|php)(\.exe)?$/;

/** The program a line pipes into when it runs its input (`… | bash`, `… | sudo sh`, `… | ssh host`). */
function pipedInto(line: string): string | null {
  const parts = line.split('|').slice(1);
  for (const part of parts.reverse()) {
    const ws = words(part.trim()).map((w) => unquote(w).toLowerCase());
    const program = ws[0] === 'sudo' || ws[0] === 'doas' ? ws.find((w, i) => i > 0 && !w.startsWith('-')) : ws[0];
    if (program && STDIN_RUNNERS.test(program)) return program.replace(/\.exe$/, '');
  }
  return null;
}

/** Commands whose heredoc is data they print or save, not code they run. */
// git, gh and glab take a heredoc only as data (`git commit -F -`, a PR body, a patch), never as commands.
export const DATA_RUNNERS = new Set(['cat', 'tee', 'git', 'gh', 'glab']);

/** A heredoc whose text runs as commands: a shell, ssh, pwsh, anything that isn't data or a code interpreter. */
export const runsAsShell = (runner: string) => !DATA_RUNNERS.has(runner) && !CODE_RUNNERS.has(runner);

/** Code that starts other programs (or edits the registry): only then can its strings be shell commands. */
export const PROCESS_API =
  /\b(subprocess|os\.(system|popen|exec\w*|spawn\w*)|popen|child_process|start-process|invoke-expression|iex|winreg)\b|\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(|shell\s*=\s*True/i;

/**
 * Code of a heredoc as text the shell rules can look at (commandsIn): the commands of a shell
 * script or of anything else that reads its input as commands (`ssh host <<EOF`, `pwsh`), the
 * strings of code that starts programs. A script that doesn't (Python editing a file, with `sc`
 * or `rm` somewhere in its strings) can't run anything. Audit S2: an ssh heredoc used to count
 * as code, so `sudo dnf install` inside was green in a project.
 */
export const codeOf = (bodies: Heredoc[]) =>
  bodies
    .map((b) =>
      // A program's argument list (`subprocess.run(['git', 'push', '--force'])`) reads as one command.
      CODE_RUNNERS.has(b.runner) ? (PROCESS_API.test(b.text) ? quotedStrings(b.text).join(' ') : '') : commandsIn(b.runner, b.text),
    )
    .join('\n');

/** Deleting from inside a script (Python, Node, PowerShell). */
export const DELETE_API =
  /\b(os\.(remove|unlink|rmdir|removedirs)|shutil\.rmtree|rmtree|unlinkSync|rmSync|rmdirSync|fs\.(rm|unlink|rmdir)|remove-item)\b|\.unlink\(/i;

/**
 * Inline code (`python -c "…"`, `node -e "…"`) that only reads: no writing, deleting, moving, starting
 * programs, SQL that changes a database, or code built at runtime. Its words aren't changing words,
 * so reading a session log with a `python -c` doesn't count as changing it (2026-11-21: a held read).
 * Any doubt counts as changing.
 */
const CODE_CHANGES =
  /\b(shutil\.\w+|os\.(rename|replace|mkdir|makedirs|chmod|chown|truncate|link|symlink|utime)|write_(text|bytes)|truncate|executescript|commit|eval|compile|__import__|importlib|ctypes|socket|urllib|requests|http|fetch)\b|\b(appendFile|rename|copyFile|copyfile|copytree|mkdir|rm|chmod|symlink|link|cp|utimes)\w*\s*\(|(?<!std(out|err)\.)\bwrite\w*\s*\(|\bopen\([^)]*,\s*(mode\s*=\s*)?['"][^'"]*[wax+]|\.open\(\s*['"][^'"]*[wax+]|\b(insert\s+(or\s+\w+\s+)?into|update\s+\w+\s+set|delete\s+from|drop\s+\w+|alter\s+table|create\s+\w+|replace\s+into|vacuum|attach\s+database|pragma\s+\w+\s*=)/i;
const INLINE_FLAG: Record<string, RegExp> = {
  python: /^-\w*c$/,
  python3: /^-\w*c$/,
  py: /^-\w*c$/,
  node: /^(-e|--eval|-p|--print)$/,
};
export function inertInlineCode(words: string[], hides: RegExp): boolean {
  const runner = (words[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  const flag = INLINE_FLAG[runner];
  if (!flag) return false;
  const at = words.findIndex((w, i) => i > 0 && flag.test(w));
  // Only flags before the code (`python -I -c`), so no script file runs alongside it.
  if (at < 0 || words.slice(1, at).some((w) => !w.startsWith('-')) || words[at + 1] === undefined) return false;
  const code = words[at + 1]!;
  return !(DELETE_API.test(code) || PROCESS_API.test(code) || CODE_CHANGES.test(code) || hides.test(code) || hidesCode(code) !== null);
}

// ── Code the gate can't read (the full review, S7) ─────────────────────────

const FETCHER = /^(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)$/i;
/** Programs that run the code piped into them (with no file or module of their own to run). */
const STDIN_CODE = /^(sh|bash|zsh|dash|ksh|iex|invoke-expression|pwsh|powershell|python3?|py|node|ruby|perl|php|source|\.)$/i;
const SETUP_EVAL =
  /\beval\s+["']?\$\(\s*(ssh-agent|fnm|pyenv|rbenv|nodenv|goenv|direnv|brew|conda|starship|zoxide|mise|minikube|dircolors|keychain|opam|luarocks)\b/i;
const DECODER =
  /\bbase64\s+(-d|-D|--decode)\b|\bopenssl\s+(base64|enc)\b[^|;&\n]*\s-d\b|\bcertutil\b[^|;&\n]*-decode|\bxxd\s+-r\b|frombase64string|\batob\(|buffer\.from\([^)]*base64|b64decode|bytes\.fromhex|zlib\.decompress|marshal\.loads/i;
const RUNS_BUILT = /\beval\b|\bexec\s*\(|\biex\b|invoke-expression|scriptblock\]::create|\b(sh|bash)\s+-c\b/i;
/** PowerShell's encoded flag in any short form (-e, -ec, -en, -enc … -EncodedCommand), followed by base64. */
const ENCODED_FLAG =
  /\b(powershell|pwsh)(\.exe)?\b[^|;&\n]*\s-(ec|e|en|enc|enco|encod|encode|encoded|encodedc\w*)\s+["']?[A-Za-z0-9+/]{8,}={0,2}/i;
const FETCH_SUBST =
  /\b(bash|sh|zsh|source|\.)\s+<\(\s*(curl|wget)\b|\b(sh|bash|zsh)\s+-c\s+["']?\$\(\s*(curl|wget)\b|\beval\s+["']?\$\(\s*(curl|wget)\b|\b(iex|invoke-expression)\s*\(*\s*(iwr|irm|invoke-webrequest|invoke-restmethod|\(?\s*new-object\s+(system\.)?net\.webclient)/i;

/** A part's program, without sudo, `&`, quotes or `.exe`. */
const programOf = (segment: string) => {
  const ws = words(segment).map((w) => unquote(w).toLowerCase());
  let i = 0;
  while (i < ws.length && /^(sudo|doas|&)$/.test(ws[i]!)) i++;
  while (i < ws.length && ws[i]!.startsWith('-') && i > 0) i++;
  return { program: (ws[i] ?? '').replace(/\.exe$/, ''), rest: ws.slice(i + 1) };
};

/**
 * Why the gate can't read what this command runs, or null: `fetched` = downloaded and run in one go
 * (`curl … | bash`, `irm … | iex`, `bash <(curl …)`); `encoded` = packed or built at runtime
 * (`powershell -enc …`, `… | base64 -d | sh`, `eval "$CMD"`). Shell set-up evals (`eval "$(ssh-agent -s)"`) are fine.
 */
export function hidesCode(text: string, running = text): { kind: 'fetched' | 'encoded'; why: string } | null {
  if (FETCH_SUBST.test(running)) return { kind: 'fetched', why: 'It downloads code and runs it unread.' };
  for (const line of text.split(/\r?\n/)) {
    // Pipes, part by part (quotes respected: `echo "curl x | bash"` only prints). Each part is
    // marked with the separator before it: `|` = it reads the previous part's output.
    const parts: string[] = [];
    let current = '';
    let quote = '';
    let sep = ';';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '|' || ch === ';' || ch === '&') {
        parts.push(`${sep}${current}`);
        sep = ch === '|' && line[i + 1] !== '|' && line[i - 1] !== '|' ? '|' : ';';
        current = '';
        continue;
      }
      current += ch;
    }
    parts.push(`${sep}${current}`);
    let fetched = false;
    let decoded = false;
    for (const raw of parts) {
      const piped = raw.startsWith('|');
      const segment = raw.slice(1).trim();
      if (!segment) continue;
      const { program, rest } = programOf(segment);
      const runsStdin = STDIN_CODE.test(program) && rest.every((w) => w.startsWith('-') && !/^-(m|c|e|f|file|command)$/i.test(w));
      if (piped && runsStdin && fetched) return { kind: 'fetched', why: 'It downloads code and runs it unread.' };
      if (piped && runsStdin && decoded) return { kind: 'encoded', why: 'It decodes hidden code and runs it.' };
      if (!piped) {
        fetched = false;
        decoded = false;
      }
      if (FETCHER.test(program) || /downloadstring|urlopen|requests\.get/i.test(segment)) fetched = true;
      if (DECODER.test(segment)) decoded = true;
    }
  }
  if (ENCODED_FLAG.test(running)) return { kind: 'encoded', why: 'It runs an encoded command.' };
  if (DECODER.test(running) && RUNS_BUILT.test(running)) return { kind: 'encoded', why: 'It decodes hidden code and runs it.' };
  const evals = running.replace(SETUP_EVAL, '');
  if (/\beval\s+["']?(\$\(|\$\{?\w|`)/i.test(evals) || /\b(iex|invoke-expression)\s+\$\w/i.test(evals))
    return { kind: 'encoded', why: 'It runs code built at runtime.' };
  return null;
}

// ── Read-only programs and PowerShell pipelines ────────────────────────────

export const words = (segment: string) => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

export const unquote = (w: string) => w.replace(/^["']|["']$/g, '');

/** A copy's destination (`cp a b`, `Copy-Item a -Destination b`); undefined when it isn't a plain copy or can't be told. */
export function copyDestination(segment: string): string | undefined {
  const [verb, ...rest] = words(segment).map(unquote);
  if (!verb || !/^(cp|copy|copy-item|cpi)$/i.test(verb)) return undefined;
  if (rest.some((w) => /^(-t|--target-directory)(=|$)/i.test(w))) return undefined;
  const named = rest.findIndex((w) => /^-destination$/i.test(w));
  if (named >= 0) return rest[named + 1];
  const args = rest.filter((w) => !w.startsWith('-'));
  return args.length >= 2 ? args.at(-1) : undefined;
}

/** Literal paths a command mentions that exist on disk (what a backup should cover). */
export function pathsInCommand(command: string, cwd = WORKSPACE): string[] {
  const out = new Set<string>();
  for (const segment of splitCommand(command)) {
    for (const word of words(segment).slice(1).map(unquote)) {
      if (!word || word.startsWith('-') || /^\/[a-z?]$/i.test(word) || /[*?$`]/.test(word) || /^https?:/i.test(word)) continue;
      // One look on disk: a bare word ("notes") counts only when such a file is there, like a path.
      const path = fullPath(word, cwd);
      if (existsSync(path)) out.add(path);
    }
  }
  return [...out];
}

/** Programs that can change a whole folder at once: delete, move or rename it, mirror into it, reset it. */
const FOLDER_CHANGERS =
  /^(rm|rmdir|rd|del|erase|remove-item|ri|mv|move|move-item|mi|ren|rename|rename-item|rni|robocopy|xcopy|rsync|shred|git)$/i;

/**
 * What a backup really needs of an action's targets. Folders in the temp folder are scratch. A folder is copied
 * whole only when a shell command can change it as a whole (`rm -r x`, `mv x y`, `robocopy … x /mir`,
 * `git clean` in it): looking into one, or making something inside it, copied all of it before (the
 * whole Projects folder for a "check the repo", a 142 MB Temp folder for a listing). What a command
 * creates there is still noted (a path that doesn't exist yet), so Undo removes it.
 */
export function backupTargets(targets: string[], command?: string, cwd = WORKSPACE): string[] {
  const segments = command ? splitCommand(command).map((s) => words(s).map(unquote)) : [];
  return targets.filter((target) => {
    if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) return true;
    // A folder in the temp folder is scratch (a file there may still be worth an Undo).
    if (isTempDir(target)) return false;
    if (command === undefined) return true;
    const full = fullPath(target, cwd).toLowerCase();
    return segments.some(
      (ws) =>
        FOLDER_CHANGERS.test((ws[0] ?? '').replace(/\.exe$/i, '')) &&
        (ws[0]!.toLowerCase() !== 'git' || /^(clean|reset|checkout|restore|stash|rm|mv)$/i.test(ws[1] ?? '')) &&
        ws.slice(1).some((w) => !w.startsWith('-') && fullPath(w, cwd).toLowerCase() === full),
    );
  });
}

/** Start-Process's own options (anything else after -ArgumentList belongs to the program). */
export const START_OPTION =
  /^-(wait|nonewwindow|passthru|windowstyle|workingdirectory|verb|filepath|redirect\w*|loaduserprofile|usenewenvironment|environment|credential)$/i;

/** A program in the Windows folder named by its full path (`C:\Windows\System32\control.exe`). */
export const WINDOWS_PROGRAM =
  /^(?:[a-z]:|%windir%|%systemroot%|\$env:(?:windir|systemroot))[\\/]+(?:windows[\\/]+)?(?:(?:system32|syswow64)[\\/]+)?([\w.-]+\.(?:exe|com|cpl|msc))$/i;
