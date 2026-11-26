import { describe, expect, it } from 'vitest';
import { describeTarget, formatSummary, parseLsblk, pickTarget, type Disk, type Target } from './drives.ts';

const disks: Disk[] = [
  { id: '2', name: 'WD Blue SN580 1TB', size: 1e12, usb: false, system: true, volumes: [{ id: 'C', size: 1e12, fs: 'NTFS' }] },
  { id: '0', name: 'ST500LT012', size: 5e11, usb: false, system: false, volumes: [{ id: 'E', size: 5e11, fs: 'NTFS' }] },
  {
    id: '4',
    name: 'USB SanDisk 3.2Gen1',
    size: 61.5e9,
    usb: true,
    system: false,
    volumes: [{ id: 'G', size: 17e9, fs: 'NTFS', label: 'WIN' }],
  },
  { id: '7', name: 'Boot Stick', size: 32e9, usb: true, system: true, volumes: [] },
];
const name = 'USB SanDisk 3.2Gen1';

describe('format_drive picks only USB data drives', () => {
  it('formats a USB volume by its letter, exFAT by default', () => {
    const t = pickTarget(disks, { drive: 'g:', disk_name: name }, false) as Target;
    expect(t).toMatchObject({ whole: false, filesystem: 'exfat', label: 'USB', volume: { id: 'G' }, disk: { id: '4' } });
    expect(describeTarget(t)).toMatch(/^Erase everything on G: on disk 4: USB SanDisk/);
  });

  it('erases the whole disk when asked, or when it has no volume', () => {
    expect(pickTarget(disks, { drive: 'G', disk_name: name, whole: true }, false)).toMatchObject({ whole: true, volume: undefined });
    expect(pickTarget(disks, { drive: 'disk 4', disk_name: name }, false)).toMatchObject({ whole: true });
  });

  it('refuses internal, system and unknown drives', () => {
    expect(pickTarget(disks, { drive: 'C:', disk_name: 'WD Blue SN580 1TB' }, false)).toMatch(/isn't a USB drive/);
    expect(pickTarget(disks, { drive: 'E', disk_name: 'ST500LT012' }, false)).toMatch(/isn't a USB drive/);
    expect(pickTarget(disks, { drive: 'disk 7', disk_name: 'Boot Stick' }, false)).toMatch(/holds the running system/);
    expect(pickTarget(disks, { drive: 'Z:', disk_name: name }, false)).toMatch(/No drive "Z:"/);
    expect(pickTarget(disks, { drive: 'C:\\Windows', disk_name: name }, false)).toMatch(/No drive/);
  });

  it('refuses when the drive letter now belongs to another disk than the one named', () => {
    expect(pickTarget(disks, { drive: 'G', disk_name: 'ADATA SE880' }, false)).toMatch(/not "ADATA SE880"/);
  });

  it('checks the file system and label', () => {
    expect(pickTarget(disks, { drive: 'G', disk_name: name, filesystem: 'ext4' }, false)).toMatch(/Linux file system/);
    expect(pickTarget(disks, { drive: 'G', disk_name: name, filesystem: 'fat32', whole: true }, false)).toMatch(/up to 32 GB/);
    expect(pickTarget(disks, { drive: 'G', disk_name: name, filesystem: 'fat32' }, false)).toMatchObject({ filesystem: 'fat32' });
    expect(pickTarget(disks, { drive: 'G', disk_name: name, label: 'TOO LONG LABEL' }, false)).toMatch(/up to 11/);
    expect(pickTarget(disks, { drive: 'G', disk_name: name, label: "x'; rm" }, false)).toMatch(/letters, digits/);
    expect(pickTarget(disks, { drive: 'G', disk_name: name, label: 'Movies 2026', filesystem: 'ntfs' }, false)).toMatchObject({
      label: 'Movies 2026',
    });
  });

  it('names the drive on the approval card', () => {
    expect(formatSummary({ drive: 'G:', disk_name: name, label: 'CAR' })).toBe(`ERASE G: (${name}) and format it EXFAT "CAR"`);
    expect(formatSummary({ drive: 'disk 4', disk_name: name, whole: true, filesystem: 'ntfs' })).toMatch(/^ERASE the WHOLE disk of disk 4/);
  });
});

describe('format_drive on Linux', () => {
  const lsblk = JSON.stringify({
    blockdevices: [
      {
        name: 'nvme0n1',
        path: '/dev/nvme0n1',
        size: 512e9,
        tran: 'nvme',
        type: 'disk',
        model: 'Samsung',
        children: [
          { name: 'nvme0n1p1', path: '/dev/nvme0n1p1', size: 1e9, type: 'part', fstype: 'vfat', mountpoints: ['/boot/efi'] },
          { name: 'nvme0n1p2', path: '/dev/nvme0n1p2', size: 5e11, type: 'part', fstype: 'btrfs', mountpoints: ['/home', '/'] },
        ],
      },
      {
        name: 'sdb',
        path: '/dev/sdb',
        size: 32e9,
        tran: 'usb',
        type: 'disk',
        model: 'Cruzer Blade ',
        children: [
          {
            name: 'sdb1',
            path: '/dev/sdb1',
            size: 32e9,
            type: 'part',
            fstype: 'vfat',
            label: 'STICK',
            fsavail: 1e9,
            mountpoints: ['/run/media/u/STICK'],
          },
        ],
      },
      {
        name: 'sdc',
        path: '/dev/sdc',
        size: 64e9,
        tran: 'usb',
        type: 'disk',
        model: 'Live',
        children: [{ name: 'sdc1', path: '/dev/sdc1', size: 64e9, type: 'part', mountpoints: ['/'] }],
      },
    ],
  });
  const linux = parseLsblk(lsblk);

  it('reads lsblk and marks the system disks', () => {
    expect(linux.map((d) => [d.id, d.usb, d.system])).toEqual([
      ['/dev/nvme0n1', false, true],
      ['/dev/sdb', true, false],
      ['/dev/sdc', true, true],
    ]);
    expect(linux[1]).toMatchObject({
      name: 'Cruzer Blade',
      volumes: [{ id: '/dev/sdb1', label: 'STICK', mounts: ['/run/media/u/STICK'] }],
    });
  });

  it('formats a USB partition, never a whole disk or a system one', () => {
    expect(pickTarget(linux, { drive: '/dev/sdb1', disk_name: 'Cruzer Blade', filesystem: 'ext4' }, true)).toMatchObject({
      filesystem: 'ext4',
      volume: { id: '/dev/sdb1' },
    });
    expect(pickTarget(linux, { drive: '/dev/sdb', disk_name: 'Cruzer Blade' }, true)).toMatch(/Windows-only/);
    expect(pickTarget(linux, { drive: '/dev/sdc1', disk_name: 'Live' }, true)).toMatch(/running system/);
    expect(pickTarget(linux, { drive: '/dev/nvme0n1p2', disk_name: 'Samsung' }, true)).toMatch(/isn't a USB drive/);
  });
});
