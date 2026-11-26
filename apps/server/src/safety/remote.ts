import { splitCommand, splitHeredocs, unquote, words } from './shell.ts';

/**
 * Commands that run on another computer (`ssh host 'cmd'`, `$cmd = @'…'@; ssh host $cmd`,
 * `ssh host <<EOF … EOF`), told apart from what runs here. Their paths are that computer's
 * (`C:\Windows\…\debloat.log` on the notebook is not this PC's Windows folder: the Windows debloat
 * chat, 2026-11-22), so the gate judges the two apart. scp/rsync `host:path` targets are the other
 * computer's too.
 */
export interface RemotePart {
  /** The host as written (`user@host`). */
  host: string;
  /** What runs there. */
  text: string;
  /** A local file fed to it (`ssh host 'bash -s' < x.sh`): a script that runs there. */
  input?: string;
}

/** ssh options that take a value (`-o X`, `-p 22`, `-i key`…). */
const SSH_VALUE_OPTS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));

const isSsh = (word: string) => /(^|[\\/])(ssh|plink)(\.exe)?$/i.test(unquote(word));
const isCopier = (word: string) => /(^|[\\/])(scp|rsync|pscp|sftp)(\.exe)?$/i.test(unquote(word));
/** A redirect after the remote command runs here (`ssh host 'bash -s' < x.sh`, `2>&1`). */
const REDIRECT = /^(\d?>>?|<|\d?>&\d|&>)/;

/** Words in front of a program that only wrap it (`&`, `sudo`, `if ($?) {`, a loop's `$i++) {`). */
const WRAPPER = /^(&|sudo|doas|env|if|elseif|else|for|foreach|while|try|\{|\()$|^[{(]|[{)]$/i;

/** Where a segment's program is, past what wraps it, or -1. */
export function programAt(ws: string[]): number {
  let i = 0;
  while (i < ws.length && WRAPPER.test(unquote(ws[i]!)) && !isSsh(ws[i]!) && !isCopier(ws[i]!)) i++;
  return i < ws.length ? i : -1;
}

/** Where the host is in an ssh segment's words (after the options), or -1. */
function hostIndex(ws: string[], from: number): number {
  for (let i = from; i < ws.length; i++) {
    const w = unquote(ws[i]!);
    if (w === '--') return i + 1 < ws.length ? i + 1 : -1;
    if (/^-[A-Za-z]/.test(w)) {
      // `-o X`, but `-oX` and `-p22` carry their value.
      if (w.length === 2 && SSH_VALUE_OPTS.has(w[1]!)) i++;
      continue;
    }
    return i;
  }
  return -1;
}

/** A scp/rsync target on another computer (`host:path`, `user@host:path`; not `C:\…`). */
export const remoteTarget = (w: string) => /^[^\s:\\/]{2,}:/.test(unquote(w)) && !/^[a-z]:[\\/]/i.test(unquote(w));

export function splitRemote(command: string): { local: string; remote: RemotePart[] } {
  const remote: RemotePart[] = [];
  let local = command;
  // PowerShell here-strings kept in a variable that ssh gets (`$cmd = @'…'@` then `ssh host $cmd` or `$cmd | ssh host …`).
  const hereVars = new Map<string, string>();
  for (const m of command.matchAll(/\$(\w+)\s*=\s*@(['"])\r?\n([\s\S]*?)\r?\n\2@/g)) hereVars.set(m[1]!.toLowerCase(), m[3]!);
  // ssh heredocs (`ssh host <<'EOF'`): their text runs there.
  const sshBodies = /<</.test(command) ? splitHeredocs(command).bodies.filter((b) => isSsh(b.runner)) : [];
  const masked = command.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "@''@");
  const segments = splitCommand(sshBodies.length ? splitHeredocs(masked).shell : masked);
  let bodyAt = 0;
  segments.forEach((segment, k) => {
    const ws = words(segment);
    const i = programAt(ws);
    if (i < 0) return;
    if (isCopier(ws[i]!)) {
      // Only the host is kept for the other computer's paths (`host:` alone names no file here).
      const kept = ws.map((w, j) => (j > i && remoteTarget(w) ? `${unquote(w).split(':')[0]}:` : w)).join(' ');
      if (kept !== ws.join(' ')) local = local.replace(segment, kept);
      return;
    }
    if (!isSsh(ws[i]!)) return;
    const at = hostIndex(ws, i + 1);
    if (at < 0) return;
    const host = unquote(ws[at]!);
    const rest = ws.slice(at + 1);
    // The block's closing brace (`if ($?) { ssh host x }`) is this shell's.
    const close = rest.findIndex((w, j) => /^[})]+$/.test(w) && rest.slice(j).every((x) => /^[})]+$/.test(x)));
    const stop = rest.findIndex((w, j) => REDIRECT.test(w) || j === close);
    const run = stop < 0 ? rest : rest.slice(0, stop);
    let redirects = stop < 0 ? [] : rest.slice(stop);
    // `< x.sh` (or `<x.sh`): the file's text runs there.
    let input: string | undefined;
    const from = redirects.findIndex((w) => /^</.test(w));
    if (from >= 0) {
      const attached = redirects[from]!.slice(1);
      input = unquote(attached || (redirects[from + 1] ?? ''));
      redirects = redirects.filter((_, j) => j !== from && (attached || j !== from + 1));
    }
    const texts: string[] = [];
    if (run.length === 1) texts.push(unquote(run[0]!));
    else if (run.length > 1) texts.push(run.join(' '));
    for (const w of run) {
      const v = /^\$\{?(\w+)\}?$/.exec(unquote(w));
      if (v && hereVars.has(v[1]!.toLowerCase())) texts.push(hereVars.get(v[1]!.toLowerCase())!);
    }
    // `$cmd | ssh host …`: the variable piped in.
    const piped = /^\$\{?(\w+)\}?$/.exec(unquote((k > 0 ? words(segments[k - 1]!) : []).join(' ').trim()));
    if (piped && hereVars.has(piped[1]!.toLowerCase())) texts.push(hereVars.get(piped[1]!.toLowerCase())!);
    // splitHeredocs takes the `<<'EOF'` out of the shell text: look for it after this line in the command as written.
    const fedHeredoc = new RegExp(`${segment.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<<`).test(command);
    if (sshBodies[bodyAt] && fedHeredoc) texts.push(sshBodies[bodyAt++]!.text);
    const kept = [...ws.slice(0, at + 1), ...redirects].join(' ');
    local = local.replace(segment, kept);
    remote.push({ host, text: texts.filter((t) => t.trim()).join('\n'), ...(input ? { input } : {}) });
  });
  // What ssh got through a variable or a heredoc doesn't run here either.
  for (const part of remote) {
    for (const body of hereVars.values()) if (part.text.includes(body)) local = local.replace(body, '');
    for (const b of sshBodies) if (part.text.includes(b.text)) local = local.replace(b.text, '');
  }
  return { local, remote };
}

/**
 * Whether what runs here only reaches the other computer: ssh lines, the here-string handed to
 * them, `if ($?) {`-style glue. Then the other computer's commands decide the verdict.
 */
export function onlyReachesOut(local: string): boolean {
  let masked = local.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "@''@");
  if (/<</.test(masked)) masked = splitHeredocs(masked).shell;
  return splitCommand(masked).every((segment) => {
    const s = segment
      .trim()
      .replace(/^[({]+|[)}]+$/g, '')
      .trim();
    if (!s || /^if\s*\(\s*\$\?\s*\)$/i.test(s) || /^\$\w+\s*=\s*@(['"])\1@$/.test(s)) return true;
    const ws = words(s);
    const i = programAt(ws);
    return i >= 0 && isSsh(ws[i]!);
  });
}

/** The host an ssh segment reaches, or null when it isn't ssh. */
export function sshHost(segment: string): string | null {
  const ws = words(segment);
  const i = programAt(ws);
  if (i < 0 || !isSsh(ws[i]!)) return null;
  const at = hostIndex(ws, i + 1);
  return at < 0 ? null : unquote(ws[at]!);
}

/** Whether a segment runs ssh, scp, sftp or rsync (whose `-o Option=value` is no output file). */
export function runsSsh(segment: string): boolean {
  const ws = words(segment);
  const i = programAt(ws);
  return i >= 0 && (isSsh(ws[i]!) || isCopier(ws[i]!));
}
