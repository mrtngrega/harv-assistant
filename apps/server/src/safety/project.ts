import { statSync } from 'node:fs';
import { fullPath, isInside, isProgramDir, isSystemDir, isTempDir, WORKSPACE } from './paths.ts';
import { LINUX_INSTALL, LINUX_SYSTEM, type Rule, type Verdict, matches, verdict } from './base.ts';
import { scriptSends, sendsData } from './sending.ts';
import { isClaudeMemory } from './sensitive.ts';
import { DATA_RUNNERS, DELETE_API, codeOf, runsAsShell, scriptPaths, splitCommand, splitHeredocs, unquote, words } from './shell.ts';

/**
 * `pip install` for the whole PC: a bare `pip` / `python -m pip`, or one in a system folder.
 * A venv's own pip (`.venv/bin/pip`, `/tmp/carvenv/bin/python -m pip`) only fills that venv.
 */
export function installsPythonPackages(text: string): boolean {
  return splitCommand(text).some((segment) => {
    const ws = words(segment).map(unquote);
    const at = ws.findIndex((w) => !/^\w+=/.test(w) && !/^(sudo|env|time|nice)$/i.test(w));
    const program = ws[at] ?? '';
    const name = program
      .split(/[\\/]/)
      .at(-1)!
      .toLowerCase()
      .replace(/\.exe$/, '');
    const args = ws.slice(at + 1);
    const pipArgs = /^pip3?(\.\d+)?$/.test(name)
      ? args
      : /^(python3?(\.\d+)?|py)$/.test(name) && args[0] === '-m' && /^pip3?$/.test(args[1] ?? '')
        ? args.slice(2)
        : null;
    if (!pipArgs?.some((a) => /^(install|uninstall)$/i.test(a))) return false;
    if (/^sudo$/i.test(ws[0] ?? '') || !/[\\/]/.test(program)) return true;
    const where = fullPath(program);
    return isSystemDir(where) || isProgramDir(where);
  });
}

/** Still asked first inside a project. */
const PROJECT_RED: [Rule, string][] = [
  // A normal push runs (the user wants work pushed without asking); rewriting or deleting remote history asks.
  [/\bgit\s+push\b[^|;&\n]*(\s(-f|-d)\b|--force|--delete|--mirror|\s\+\S|\s:\S)/i, 'Rewrites or deletes history on the git remote.'],
  [
    /\b(npm|pnpm|yarn|bun)\s+(i|install|add|uninstall|remove|rm)\b[^|;&\n]*(\s-g\b|--global\b)/i,
    'Installs or removes software for the whole PC.',
  ],
  [/\b(winget|choco|scoop|msiexec)\b|\b(install|uninstall)-(module|package|script)\b/i, 'Installs or removes software for the whole PC.'],
  [installsPythonPackages, 'Installs or removes Python packages for the whole PC.'],
  [LINUX_INSTALL, 'Installs or removes software for the whole PC.'],
  [/(?<![\w.-])(taskkill|kill|pkill|killall|stop-process|spps)\b/i, 'Stops running programs.'],
  [/(?<![\w.-])reg\b(?!\s+(query|export)\b)|\bregedit\b|-itemproperty\b|\bhk(lm|cu|cr|u|cc):?\\/i, 'Changes the Windows registry.'],
  [/\b(netsh|sc|bcdedit|powercfg|schtasks|setx|set-service|set-executionpolicy|shutdown|reboot|poweroff)\b/i, 'Changes system settings.'],
  [LINUX_SYSTEM, 'Changes system settings.'],
  [/\b(runas|sudo|pkexec)\b|-verb\s+runas/i, 'Runs as administrator.'],
  [sendsData, 'Sends data over the network.'],
  [scriptSends, 'Sends data over the network (from a script).'],
  // `curl … | sh` runs whatever the server sends; `curl … | python3 -c '…'` only parses it with code from the command.
  [
    /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(sudo\s+)?((sh|bash|zsh|iex|invoke-expression|pwsh|powershell)\b(?!\s+-c\b)|(python3?|node|ruby|perl)(\s+-)?\s*($|[|;&\n]))/i,
    'Runs a script straight from the internet.',
  ],
  [
    /\badb\b[^|;&\n]*\s(install|uninstall|push|reboot|root|remount|disable-verity|sideload|shell\s+(rm|pm\s+(uninstall|clear|disable\S*|install)|settings\s+put|setprop|reboot|am\s+force-stop|wipe|svc))\b/i,
    'Changes the connected Android device.',
  ],
];

/** Things whose effect Harv can't see from the command line: substitutions, variables in paths, nested shells. (`~/` is fine: `fullPath` resolves it.) */
const OPAQUE =
  /\$\(|`|\binvoke-expression\b|\biex\b|-encodedcommand|\s-enc\s|\$env:|%\w+%|\b(powershell|pwsh)(\.exe)?\s|\bcmd(\.exe)?\s+\/[ck]\b|\b(bash|sh)\s+-c\b|\|\s*(sh|bash|powershell|pwsh)\b/i;

/**
 * Every word of a command that looks like a path, resolved where it runs (existing or
 * not): a `cd` moves the base for what follows and counts as a place the command works in.
 */
export function pathLikeWords(command: string, cwd: string): string[] {
  const out: string[] = [];
  let base = cwd;
  for (const segment of splitCommand(command)) {
    const ws = words(segment).map(unquote);
    if (/^(cd|chdir|set-location|sl|pushd)$/i.test(ws[0] ?? '')) {
      const target = ws.slice(1).find((w) => !w.startsWith('-'));
      if (target && target !== '-') {
        base = fullPath(target, base);
        out.push(base);
      }
      continue;
    }
    for (const raw of ws.slice(1)) {
      const word = raw.replace(/^-{1,2}[\w-]+[=:]/, '').replace(/^\d?>+&?/, '');
      if (!word || /:\/\//.test(word) || /\s/.test(word) || word.startsWith('-') || /^(\/dev\/null|\$null|nul)$/i.test(word)) continue;
      if (!/[\\/]/.test(word) && !word.startsWith('..') && !/^[a-z]:/i.test(word) && word !== '~') continue;
      out.push(fullPath(word, base));
    }
  }
  return out;
}

const DELETES = /\b(rm|rmdir|rd|del|erase|remove-item|ri|unlink|shred)\b|\s-delete\b/i;

/** Backed up before a project command that works outside the folder: small files only (a big folder named as a source isn't worth copying). */
const MAX_PROJECT_BACKUP = 10 * 1024 * 1024;

const smallFile = (p: string) => {
  const st = statSync(p, { throwIfNoEntry: false });
  return st?.isFile() === true && st.size <= MAX_PROJECT_BACKUP;
};

/**
 * A command in a project chat. Only the risky kinds ask (the user's choice, 2026-10-25):
 * dev work runs, inside the folder or outside it (outside, it's logged and the small
 * files it names are backed up first); deletes inside the project are backed up. Null
 * means it deletes outside the project or somewhere Harv can't tell, and the normal rules
 * decide (red). The temp folder is scratch space.
 */
export function classifyInProject(command: string, summary: string, project: string, existing: string[] = []): Verdict | null {
  const { shell, bodies } = splitHeredocs(command);
  const code = bodies.filter((b) => !DATA_RUNNERS.has(b.runner));
  const scriptText = codeOf(bodies);
  const risky = PROJECT_RED.find(([rule]) => matches(rule, shell) || (scriptText !== '' && matches(rule, scriptText)));
  if (risky)
    return verdict(
      'red',
      risky[1],
      summary,
      existing.filter((p) => isInside(p, project)),
    );
  const free = (p: string) => isInside(p, project) || isTempDir(p) || isInside(p, WORKSPACE) || isClaudeMemory(p);
  const scriptTargets = code.flatMap((b) =>
    runsAsShell(b.runner) ? pathLikeWords(b.text, project) : scriptPaths(b.text).map((p) => fullPath(p, project)),
  );
  const targets = [...pathLikeWords(shell, project), ...scriptTargets, ...existing];
  const outside = targets.filter((p) => !free(p));
  const opaque = OPAQUE.test(shell);

  const deletes = DELETES.test(shell) || code.some((b) => DELETE_API.test(b.text) || (runsAsShell(b.runner) && DELETES.test(b.text)));
  if (deletes) {
    // What a variable or a substitution deletes can't be checked, so it asks.
    // Only the deleting part counts: `for f in a b; do sed … $f.json` next to a `git rm` is fine.
    const deleting = splitCommand(shell).filter((segment) => DELETES.test(segment));
    if (outside.length > 0 || opaque || deleting.some((segment) => /\$(?!null\b)\{?\w/i.test(segment))) return null;
    return verdict(
      'yellow',
      'Deletes files in the project or the temp folder (backed up first, Undo brings them back).',
      summary,
      existing,
    );
  }
  // Installed programs' folders ask as before.
  if (outside.some(isProgramDir)) return null;
  if (outside.length === 0 && !opaque) return verdict('green', 'A normal command inside the project folder.', summary);
  const backups = [...new Set(outside)].filter((p) => !isSystemDir(p) && smallFile(p)).slice(0, 20);
  return verdict(
    'yellow',
    'Project work that also touches files outside the folder (logged; small files it names are backed up).',
    summary,
    backups,
  );
}

/**
 * A command working in a file or folder the user attached to the chat: trusted like a project
 * folder (the user's wish, 2026-10-26: "I give it to him willingly"), except there's no git to
 * undo with, so what runs there is yellow (logged, the files it names backed up first, Undo)
 * instead of green. The risky kinds still ask; deleting outside it is judged as usual (null).
 */
export function classifyInAttached(command: string, summary: string, root: string, existing: string[] = []): Verdict | null {
  const v = classifyInProject(command, summary, root, existing);
  if (!v || v.tier === 'red') return v;
  const inside = existing.filter((p) => isInside(p, root) && smallFile(p)).slice(0, 20);
  if (v.tier === 'green')
    return verdict('yellow', 'Works in what you attached (logged; the files it names are backed up).', summary, inside);
  if (DELETES.test(command))
    return verdict('yellow', 'Deletes inside what you attached (backed up first, Undo brings it back).', summary, v.targets);
  return verdict(
    'yellow',
    'Works in what you attached and touches files outside it (logged; small files it names are backed up).',
    summary,
    v.targets,
  );
}
