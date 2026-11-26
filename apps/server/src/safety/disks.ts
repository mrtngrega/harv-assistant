import { listDisks, type Disk } from '../tools/drives.ts';

// Which disk a wiping command hits (the user's rule, 2026-11-11: wiping the system is a hard stop;
// any other disk is asked first). The safety check is synchronous, so it reads a cached list that
// the gate refreshes before it judges a disk command (listing disks takes a second or two).

let known: Disk[] | null = null;
let at = 0;
const FRESH_MS = 10_000;

/** The disks as last listed (null: never listed, or listing failed). */
export const knownDisks = (): Disk[] | null => known;

/** For tests: set the list by hand. */
export function setKnownDisks(disks: Disk[] | null): void {
  known = disks;
  at = disks ? Date.now() : 0;
}

/** Lists the disks again unless the list is a few seconds old. Never throws (a failure leaves null: then nothing is wiped). */
export async function refreshDisks(): Promise<void> {
  if (known && Date.now() - at < FRESH_MS) return;
  try {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 15_000));
    const list = await Promise.race([listDisks(), timeout]);
    known = list;
    at = list ? Date.now() : 0;
  } catch {
    known = null;
    at = 0;
  }
}

/** What a wiping command names: Windows drive letters and disk numbers, Linux devices. */
export function diskTargets(text: string): { letters: string[]; numbers: string[]; devices: string[]; opaque: boolean } {
  const letters = new Set<string>();
  const numbers = new Set<string>();
  const devices = new Set<string>();
  for (const m of text.matchAll(/\bformat(?:\.com)?\s+([a-z]):/gi)) letters.add(m[1]!.toUpperCase());
  for (const m of text.matchAll(/-DriveLetter\s+["']?([a-z])\b/gi)) letters.add(m[1]!.toUpperCase());
  for (const m of text.matchAll(/-(?:Disk)?Number\s+["']?(\d+)/gi)) numbers.add(m[1]!);
  // Raw devices on Windows: \\.\PhysicalDrive2 is disk 2, \\.\D: is drive D (the full review, S3).
  for (const m of text.matchAll(/\\\\\.\\PhysicalDrive(\d+)/gi)) numbers.add(m[1]!);
  for (const m of text.matchAll(/\\\\\.\\([a-z]):/gi)) letters.add(m[1]!.toUpperCase());
  for (const m of text.matchAll(/\bGet-Disk\s+(?:-Number\s+)?["']?(\d+)/gi)) numbers.add(m[1]!);
  for (const m of text.matchAll(/\/dev\/(sd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|vd[a-z]+\d*|hd[a-z]+\d*)\b/g))
    devices.add(`/dev/${m[1]}`);
  // diskpart reads its commands from a script or a pipe; variables and substitutions can't be seen.
  const opaque = /\bdiskpart\b|\$\(|`|\$\{?\w+\}?(?![:\w])/.test(text.replace(/\$env:\w+|\$true|\$false|\$null/gi, ''));
  return { letters: [...letters], numbers: [...numbers], devices: [...devices], opaque };
}

/** The disk a Linux device belongs to (`/dev/sdb1` → `/dev/sdb`, `/dev/nvme0n1p2` → `/dev/nvme0n1`). */
const diskOfDevice = (disks: Disk[], device: string) =>
  disks.find((d) => device === d.id || (device.startsWith(d.id) && /^p?\d+$/.test(device.slice(d.id.length))));

export type DiskJudgement = { kind: 'system' | 'unknown' } | { kind: 'other'; names: string[] };

/** Does a wiping command hit the system disk, another known disk, or one Harv can't tell? */
export function judgeDisks(text: string, disks: Disk[] | null = known): DiskJudgement {
  const t = diskTargets(text);
  if (!disks || t.opaque || t.letters.length + t.numbers.length + t.devices.length === 0) return { kind: 'unknown' };
  const hit: Disk[] = [];
  for (const letter of t.letters) {
    const d = disks.find((x) => x.volumes.some((v) => v.id.toUpperCase() === letter));
    if (!d) return { kind: 'unknown' };
    hit.push(d);
  }
  for (const n of t.numbers) {
    const d = disks.find((x) => x.id === n);
    if (!d) return { kind: 'unknown' };
    hit.push(d);
  }
  for (const dev of t.devices) {
    const d = diskOfDevice(disks, dev);
    if (!d) return { kind: 'unknown' };
    hit.push(d);
  }
  if (hit.some((d) => d.system)) return { kind: 'system' };
  return { kind: 'other', names: [...new Set(hit.map((d) => `${d.name} (${d.id})`))] };
}
