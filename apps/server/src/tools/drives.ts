import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { IS_WINDOWS } from '../platform.ts';

// Harv's list_drives / format_drive tools (the user's wish, 2026-11-09: "format drives, for example
// a USB stick"; docs/PLAN.md §4). Shell format commands stay blocked; this is the one way in, and
// it only ever touches a drive on the USB bus that isn't the boot or system disk. The gate always
// shows a card for it (the one action card left), and the drive is checked again right before formatting.

const run = promisify(execFile);

export interface Volume {
  /** "G" on Windows, "/dev/sdb1" on Linux. */
  id: string;
  size: number;
  label?: string;
  fs?: string;
  free?: number;
  mounts?: string[];
}

export interface Disk {
  /** The Windows disk number, or the Linux device ("/dev/sdb"). */
  id: string;
  name: string;
  size: number;
  usb: boolean;
  /** Windows booted from it or keeps its system files there, or Linux has /, /boot or /home on it. */
  system: boolean;
  volumes: Volume[];
}

export const FILESYSTEMS = ['exfat', 'fat32', 'ntfs', 'ext4'] as const;
export type FileSystem = (typeof FILESYSTEMS)[number];

export interface FormatRequest {
  /** A drive letter ("G", "G:"), "disk 4", or a Linux device ("/dev/sdb1"). */
  drive: string;
  filesystem?: FileSystem;
  label?: string;
  /** Erase the whole disk (every partition) and make one volume of it. */
  whole?: boolean;
  /** The disk's name as list_drives gave it: shown on the card, and it must still match. */
  disk_name: string;
}

export interface Target {
  disk: Disk;
  /** The volume to format; none when the whole disk is erased. */
  volume?: Volume;
  whole: boolean;
  filesystem: FileSystem;
  label: string;
}

const gb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(bytes >= 1e11 ? 0 : 1)} GB` : `${Math.round(bytes / 1e6)} MB`);

export function describeDisk(d: Disk): string {
  const vols = d.volumes.map((v) => {
    const name = /^[A-Z]$/.test(v.id) ? `${v.id}:` : v.id;
    const what = [v.label && `"${v.label}"`, v.fs, gb(v.size), v.free !== undefined && `${gb(v.free)} free`].filter(Boolean).join(', ');
    return `${name} (${what})`;
  });
  const id = /^\d+$/.test(d.id) ? `disk ${d.id}` : d.id;
  return `${id}: ${d.name}, ${gb(d.size)}${vols.length ? `; ${vols.join('; ')}` : '; no volumes'}`;
}

/** Finds what a request points at and refuses anything that isn't a USB data drive. */
export function pickTarget(disks: Disk[], req: FormatRequest, linux = !IS_WINDOWS): Target | string {
  const raw = req.drive.trim();
  const letter = /^([a-z]):?\\?$/i.exec(raw)?.[1]?.toUpperCase();
  const diskNo = /^disk\s*(\d+)$/i.exec(raw)?.[1];
  let disk: Disk | undefined;
  let volume: Volume | undefined;
  if (letter) {
    disk = disks.find((d) => d.volumes.some((v) => v.id === letter));
    volume = disk?.volumes.find((v) => v.id === letter);
  } else if (diskNo) disk = disks.find((d) => d.id === diskNo);
  else if (raw.startsWith('/dev/')) {
    disk = disks.find((d) => d.id === raw || d.volumes.some((v) => v.id === raw));
    volume = disk?.volumes.find((v) => v.id === raw);
  }
  if (!disk) return `No drive "${raw}" was found. Use list_drives to see the USB drives.`;
  if (!disk.usb)
    return `${describeDisk(disk)} isn't a USB drive. Harv only formats USB drives (sticks, external disks); internal drives stay blocked.`;
  if (disk.system) return `${describeDisk(disk)} holds the running system, so it's never formatted.`;
  if (disk.name.trim().toLowerCase() !== req.disk_name.trim().toLowerCase())
    return `"${raw}" is on ${describeDisk(disk)}, not "${req.disk_name}": nothing was changed. Check list_drives and ask the user again.`;
  const whole = req.whole === true || !volume;
  if (whole && linux) return 'Erasing a whole disk (all its partitions) is Windows-only for now; on Linux, name one partition (/dev/sdX1).';
  const filesystem = req.filesystem ?? 'exfat';
  if (filesystem === 'ext4' && !linux) return 'ext4 is a Linux file system; Windows formats exFAT, FAT32 or NTFS.';
  const size = volume && !whole ? volume.size : disk.size;
  if (filesystem === 'fat32' && size > 32 * 2 ** 30 && !linux) return 'Windows formats FAT32 only up to 32 GB; use exFAT for this drive.';
  const label = (req.label ?? 'USB').trim();
  const max = filesystem === 'ntfs' ? 32 : 11;
  if (!/^[\w .-]*$/.test(label) || label.length > max)
    return `The label can be up to ${max} letters, digits, spaces, dots, dashes or underscores.`;
  return { disk, volume: whole ? undefined : volume, whole, filesystem, label };
}

/** The approval card's line: exactly what gets erased. */
export function describeTarget(t: Target): string {
  const what = t.whole
    ? `the WHOLE ${describeDisk(t.disk)}`
    : `${/^[A-Z]$/.test(t.volume!.id) ? `${t.volume!.id}:` : t.volume!.id} on ${describeDisk(t.disk)}`;
  return `Erase everything on ${what}, and format it ${t.filesystem.toUpperCase()}${t.label ? ` "${t.label}"` : ''}.`;
}

// ── Windows ─────────────────────────────────────────────────────────────────

const WIN_LIST = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$disks = @(Get-Disk | ForEach-Object {
  $n = $_.Number
  [pscustomobject]@{ id = [string]$n; name = [string]$_.FriendlyName; size = [double]$_.Size; usb = ($_.BusType -eq 'USB'); system = [bool]($_.IsBoot -or $_.IsSystem)
    volumes = @(Get-Partition -DiskNumber $n | Where-Object DriveLetter | ForEach-Object {
      $v = Get-Volume -DriveLetter $_.DriveLetter
      [pscustomobject]@{ id = [string]$_.DriveLetter; size = [double]$_.Size; label = [string]$v.FileSystemLabel; fs = [string]$v.FileSystem; free = [double]$v.SizeRemaining }
    }) }
})
ConvertTo-Json -Depth 4 -Compress -InputObject $disks`;

// Runs elevated (one UAC prompt): checks the disk once more (same name and size, still USB, not
// boot/system) and only then formats. Writes "ok" or "error: …" to the result file.
const WIN_FORMAT = `param([string]$ParamFile, [string]$OutFile)
$ErrorActionPreference = 'Stop'
try {
  $p = Get-Content -Raw -LiteralPath $ParamFile | ConvertFrom-Json
  $disk = Get-Disk -Number $p.disk
  if ($disk.BusType -ne 'USB' -or $disk.IsBoot -or $disk.IsSystem -or $disk.FriendlyName -ne $p.name -or [double]$disk.Size -ne [double]$p.size) {
    throw "Disk $($p.disk) is no longer the USB drive that was approved; nothing was changed."
  }
  $fs = @{ exfat = 'exFAT'; fat32 = 'FAT32'; ntfs = 'NTFS' }[$p.fs]
  if ($p.whole) {
    if ($disk.IsOffline) { Set-Disk -Number $p.disk -IsOffline $false }
    if ($disk.IsReadOnly) { Set-Disk -Number $p.disk -IsReadOnly $false }
    if ($disk.PartitionStyle -ne 'RAW') { Clear-Disk -Number $p.disk -RemoveData -RemoveOEM -Confirm:$false }
    $style = if ([double]$disk.Size -gt 2TB) { 'GPT' } else { 'MBR' }
    Initialize-Disk -Number $p.disk -PartitionStyle $style
    $part = New-Partition -DiskNumber $p.disk -UseMaximumSize -AssignDriveLetter
    Format-Volume -Partition $part -FileSystem $fs -NewFileSystemLabel $p.label -Confirm:$false -Force | Out-Null
    "ok $($part.DriveLetter)" | Set-Content -LiteralPath $OutFile
  } else {
    $part = Get-Partition -DriveLetter $p.letter
    if ($part.DiskNumber -ne $p.disk) { throw "$($p.letter): is no longer on disk $($p.disk); nothing was changed." }
    Format-Volume -DriveLetter $p.letter -FileSystem $fs -NewFileSystemLabel $p.label -Confirm:$false -Force | Out-Null
    "ok $($p.letter)" | Set-Content -LiteralPath $OutFile
  }
} catch {
  "error: $($_.Exception.Message)" | Set-Content -LiteralPath $OutFile
}`;

async function windowsDisks(): Promise<Disk[]> {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_LIST], {
    windowsHide: true,
    timeout: 60_000,
  });
  const list = JSON.parse(stdout.trim() || '[]') as Disk[];
  return list.map((d) => ({ ...d, volumes: (d.volumes ?? []).map((v) => ({ ...v, label: v.label || undefined, fs: v.fs || undefined })) }));
}

async function windowsFormat(t: Target): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'harv-format-'));
  try {
    const script = join(dir, 'format.ps1');
    const params = join(dir, 'params.json');
    const out = join(dir, 'result.txt');
    writeFileSync(script, WIN_FORMAT);
    writeFileSync(
      params,
      JSON.stringify({
        disk: Number(t.disk.id),
        name: t.disk.name,
        size: t.disk.size,
        letter: t.volume?.id,
        whole: t.whole,
        fs: t.filesystem,
        label: t.label,
      }),
    );
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, params, out]
      .map((a) => `'"${a.replace(/'/g, "''")}"'`)
      .join(',');
    try {
      await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList ${args}`,
        ],
        { windowsHide: true, timeout: 15 * 60_000 },
      );
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr ?? (err as Error).message);
      if (/cancel/i.test(msg)) return 'The Windows admin prompt was declined, so nothing was formatted.';
      return `Formatting couldn't start: ${msg.trim().split('\n')[0]}`;
    }
    let result = '';
    try {
      result = readFileSync(out, 'utf8').trim();
    } catch {
      return "The admin prompt was closed or the format didn't run; nothing was reported back. Check the drive with list_drives.";
    }
    if (result.startsWith('ok')) {
      const letter = result.split(' ')[1];
      return `Done: formatted ${t.filesystem.toUpperCase()}${t.label ? ` "${t.label}"` : ''}${letter ? `, now ${letter}:` : ''}.`;
    }
    return `Formatting failed: ${result.replace(/^error:\s*/, '')}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Linux ───────────────────────────────────────────────────────────────────

interface LsblkDev {
  name: string;
  path: string;
  size: number | string;
  tran?: string | null;
  type: string;
  model?: string | null;
  label?: string | null;
  fstype?: string | null;
  fsavail?: number | string | null;
  mountpoints?: (string | null)[];
  children?: LsblkDev[];
}

const SYSTEM_MOUNTS = /^\/(boot(\/efi)?|home|usr|var)?$/;

/** lsblk -J -b output → disks. */
export function parseLsblk(json: string): Disk[] {
  const { blockdevices = [] } = JSON.parse(json) as { blockdevices?: LsblkDev[] };
  const mountsOf = (d: LsblkDev): string[] => [
    ...(d.mountpoints ?? []).filter((m): m is string => !!m),
    ...(d.children ?? []).flatMap(mountsOf),
  ];
  return blockdevices
    .filter((d) => d.type === 'disk')
    .map((d) => ({
      id: d.path,
      name: (d.model ?? d.name).trim(),
      size: Number(d.size),
      usb: d.tran === 'usb',
      system: mountsOf(d).some((m) => SYSTEM_MOUNTS.test(m)),
      volumes: (d.children ?? [])
        .filter((c) => c.type === 'part')
        .map((c) => ({
          id: c.path,
          size: Number(c.size),
          label: c.label ?? undefined,
          fs: c.fstype ?? undefined,
          free: c.fsavail == null ? undefined : Number(c.fsavail),
          mounts: mountsOf(c),
        })),
    }));
}

async function linuxDisks(): Promise<Disk[]> {
  const { stdout } = await run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,SIZE,TRAN,TYPE,MODEL,LABEL,FSTYPE,FSAVAIL,MOUNTPOINTS'], {
    timeout: 30_000,
  });
  return parseLsblk(stdout);
}

async function linuxFormat(t: Target): Promise<string> {
  const dev = t.volume!.id;
  const fresh = (await linuxDisks()).find((d) => d.id === t.disk.id);
  // The name too, as on Windows: two sticks of the same size swapped in between would pass (the full review, D22).
  if (!fresh?.usb || fresh.system || fresh.size !== t.disk.size || fresh.name !== t.disk.name || !fresh.volumes.some((v) => v.id === dev))
    return `${dev} is no longer the USB drive that was approved; nothing was changed.`;
  for (const m of fresh.volumes.find((v) => v.id === dev)?.mounts ?? []) {
    if (m) await run('udisksctl', ['unmount', '-b', dev], { timeout: 60_000 }).catch(() => undefined);
  }
  const type = { exfat: 'exfat', fat32: 'vfat', ntfs: 'ntfs', ext4: 'ext4' }[t.filesystem];
  const object = `/org/freedesktop/UDisks2/block_devices/${dev.replace('/dev/', '')}`;
  try {
    await run(
      'gdbus',
      [
        'call',
        '--system',
        '--dest',
        'org.freedesktop.UDisks2',
        '--object-path',
        object,
        '--timeout',
        '900',
        '--method',
        'org.freedesktop.UDisks2.Block.Format',
        type,
        `{'label': <'${t.label}'>, 'update-partition-type': <true>}`,
      ],
      { timeout: 15 * 60_000 },
    );
    return `Done: formatted ${dev} ${t.filesystem.toUpperCase()}${t.label ? ` "${t.label}"` : ''}.`;
  } catch (err) {
    return `Formatting failed: ${
      String((err as { stderr?: string }).stderr ?? (err as Error).message)
        .trim()
        .split('\n')[0]
    }`;
  }
}

/** The card's summary, from the call alone (the gate can't look at the drives). */
export function formatSummary(input: Record<string, unknown>): string {
  const drive = String(input.drive ?? '?');
  const fs = String(input.filesystem ?? 'exfat').toUpperCase();
  const label = typeof input.label === 'string' && input.label ? ` "${input.label}"` : '';
  const where = input.whole === true ? `the WHOLE disk of ${drive}` : drive;
  return `ERASE ${where} (${String(input.disk_name ?? 'unnamed drive')}) and format it ${fs}${label}`;
}

// ── The tools ───────────────────────────────────────────────────────────────

export const listDisks = (): Promise<Disk[]> => (IS_WINDOWS ? windowsDisks() : linuxDisks());

export async function listDrives(): Promise<string> {
  const disks = await listDisks();
  const usb = disks.filter((d) => d.usb && !d.system);
  if (!usb.length) return 'No USB drives are connected.';
  return ['USB drives (the only ones format_drive may touch):', ...usb.map((d) => `- ${describeDisk(d)}`)].join('\n');
}

export async function formatDrive(req: FormatRequest): Promise<string> {
  const target = pickTarget(await listDisks(), req);
  if (typeof target === 'string') return target;
  return IS_WINDOWS ? windowsFormat(target) : linuxFormat(target);
}
