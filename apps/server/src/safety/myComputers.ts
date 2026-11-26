import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { IS_WINDOWS } from '../platform.ts';
import { loadSettings } from './paths.ts';

/** Runs the tailscale CLI (where it is on this OS) for the tailnet names of the user's computers. */
function run(args: string[]): Promise<string> {
  const win = 'C:/Program Files/Tailscale/tailscale.exe';
  const cli = IS_WINDOWS && existsSync(win) ? win : 'tailscale';
  return new Promise((resolve, reject) =>
    execFile(cli, args, { timeout: 8000, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out)))),
  );
}

/**
 * The user's own other computers (Settings › Safety › My other computers): SSH, scp and Taildrop to
 * them is the user's own work, not sending to someone (the user, 2026-11-22). Not everything on the
 * tailnet is theirs (a device shared to the account isn't), so only the names on the list count;
 * their tailnet addresses are learned from `tailscale status`.
 */

interface Peer {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
}

/** Every other name each listed computer goes by (its MagicDNS name, its addresses), by the listed name. */
let aliases = new Map<string, string[]>();

/** The names and addresses of each tailnet device, from `tailscale status --json`. */
export function parsePeers(raw: string): Map<string, string[]> {
  const s = JSON.parse(raw) as { Self?: Peer; Peer?: Record<string, Peer> };
  const out = new Map<string, string[]>();
  for (const p of Object.values(s.Peer ?? {})) {
    const dns = (p.DNSName ?? '').replace(/\.$/, '').toLowerCase();
    const short = dns.split('.')[0] ?? '';
    const names = [dns, short, (p.HostName ?? '').toLowerCase(), ...(p.TailscaleIPs ?? [])].filter(Boolean);
    for (const n of [short, (p.HostName ?? '').toLowerCase()].filter(Boolean)) out.set(n, names);
  }
  return out;
}

/** Learns the addresses again (on start and every few minutes; a failure keeps the last ones). */
export async function refreshMyComputers(): Promise<void> {
  try {
    aliases = parsePeers(await run(['status', '--json']));
  } catch {
    /* Tailscale down: the names alone still count. */
  }
}

let learnedAt = 0;

/** Before judging an ssh, scp or Taildrop command: the addresses, at most 5 minutes old (only with a list). */
export async function refreshIfStale(command: string): Promise<void> {
  if (Date.now() - learnedAt < 5 * 60_000 || !/\b(ssh|scp|sftp|rsync|tailscale)\b/i.test(command)) return;
  if (loadSettings().myComputers.length === 0) return;
  learnedAt = Date.now();
  await refreshMyComputers();
}

/** For tests. */
export const setPeers = (peers: Map<string, string[]>) => {
  aliases = peers;
};

/** The host part of `user@host`, `host:path`, `user@host:path` or `[v6]:path`, lower case. */
export function hostOf(target: string): string {
  let t = target.trim().replace(/^["']|["']$/g, '');
  t = t.replace(/^[^@\s]*@/, '');
  if (t.startsWith('[')) return t.slice(1, t.indexOf(']')).toLowerCase();
  return (t.split(':')[0] ?? '').toLowerCase();
}

/** Whether this host (a name, address or `user@host`) is one of the user's own computers. */
export function isMyComputer(target: string, list: string[] = loadSettings().myComputers): boolean {
  const host = hostOf(target);
  if (!host) return false;
  return list.some((name) => name === host || (aliases.get(name) ?? []).includes(host));
}
