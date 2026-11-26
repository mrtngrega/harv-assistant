import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Commands Harv runs on the user's own other computers (the Windows debloat chat, 2026-11-22):
// every case here is a real command from that chat, with the names and addresses swapped.
const onWindows = process.platform === 'win32';
const windowsIt = it.runIf(onWindows);
const home = mkdtempSync(join(tmpdir(), 'harv-remote-'));
vi.stubEnv('HARV_HOME', home);
vi.stubEnv('HARV_TEMP', mkdtempSync(join(tmpdir(), 'harv-remote-scratch-')));
writeFileSync(join(home, 'settings.json'), JSON.stringify({ myComputers: ['laptopwin', 'laptopfed'] }));
const { classifyCommand, isSending } = await import('./classify.ts');
const { splitRemote, onlyReachesOut } = await import('./remote.ts');
const { isMyComputer, setPeers, hostOf, parsePeers } = await import('./myComputers.ts');
const { scriptsRun } = await import('./classify.ts');
setPeers(
  new Map([
    ['laptopwin', ['laptopwin.tailnet.ts.net', 'laptopwin', 'desktop-x1', '100.64.0.5']],
    ['laptopfed', ['laptopfed.tailnet.ts.net', 'laptopfed', 'fedora', '100.64.0.6']],
  ]),
);
afterAll(() => rmSync(home, { recursive: true, force: true }));

const WIN = 'User@100.64.0.5';
const FED = 'user@100.64.0.6';
const ws = join(home, 'workspace', 'laptopwin');
mkdirSync(ws, { recursive: true });
const cleanup = join(ws, 'cleanup.ps1');
writeFileSync(cleanup, "$dl = 'C:\\Windows\\Setup\\Scripts\\debloat.log'\nRemove-AppxPackage -Package x\n");
const ps = { shell: 'powershell' as const };
const sends = (command: string) => isSending('PowerShell', { command });

describe('my other computers', () => {
  it('knows them by name, tailnet name and address, and nothing else on the tailnet', () => {
    expect(isMyComputer(WIN)).toBe(true);
    expect(isMyComputer('laptopfed')).toBe(true);
    expect(isMyComputer('user@laptopwin.tailnet.ts.net:C:/x')).toBe(true);
    expect(isMyComputer('someone@100.64.0.9')).toBe(false);
    expect(isMyComputer('officepc')).toBe(false);
    expect(hostOf('someone@100.64.0.5:C:/Users/x.ps1')).toBe('100.64.0.5');
  });

  it("reads Tailscale's peers", () => {
    const peers = parsePeers(
      JSON.stringify({
        Peer: { a: { HostName: 'DESKTOP-X1', DNSName: 'laptopwin.tailnet.ts.net.', TailscaleIPs: ['100.64.0.5', 'fd7a::5'] } },
      }),
    );
    expect(peers.get('laptopwin')).toEqual(expect.arrayContaining(['100.64.0.5', 'fd7a::5', 'laptopwin.tailnet.ts.net']));
  });
});

describe('commands that run on another computer', () => {
  it('splits what runs there from what runs here', () => {
    const cmd = `$cmd = @'\nGet-Content C:\\Windows\\Setup\\Scripts\\debloat.log\n'@\nssh -o BatchMode=yes ${WIN} $cmd`;
    const { local, remote } = splitRemote(cmd);
    expect(local).not.toMatch(/Windows/);
    expect(remote[0]).toMatchObject({ host: WIN });
    expect(remote[0]!.text).toMatch(/debloat\.log/);
    expect(onlyReachesOut(local)).toBe(true);
    // A loop with retries, and ssh inside `if ($?) { … }`.
    const loop = `for ($i = 1; $i -le 4; $i++) { ssh -o ConnectTimeout=30 ${WIN} $cmd; if ($LASTEXITCODE -ne 255) { break } }`;
    expect(splitRemote(`$cmd = @'\nGet-Content C:\\Windows\\x.log\n'@\n${loop}`).remote[0]!.text).toMatch(/x\.log/);
    expect(splitRemote(`scp a.ps1 "${WIN}:a.ps1"; if ($?) { ssh ${WIN} 'whoami' }`).remote[0]!.text).toBe('whoami');
  });

  it("doesn't count that computer's Windows folder as this one's", () => {
    const read = `ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${WIN} 'whoami; ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); Get-Content C:\\Windows\\Setup\\Scripts\\debloat.log -Tail 5'`;
    const v = classifyCommand(read, '', ps);
    expect(v.tier).not.toBe('blocked');
    expect(v.ask).toBeUndefined();
    // Part 1: reads, a restore point and BitLocker's status ("-MountPoint C:" once looked like a search of a whole drive).
    const part1 = `$cmd = @'\n$dl='C:\\Windows\\Setup\\Scripts\\debloat.log'; if (Test-Path $dl) { 'done: ' + [bool](Select-String -Path $dl -Pattern 'Harv debloat done' -Quiet) }; 'UTC: ' + (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation').RealTimeIsUniversal; try { 'BitLocker C: ' + (Get-BitLockerVolume -MountPoint C: -ErrorAction Stop).ProtectionStatus } catch { 'n/a' }; Checkpoint-Computer -Description 'Before Harv cleanup' -RestorePointType MODIFY_SETTINGS\n'@\nssh -o BatchMode=yes ${WIN} $cmd`;
    const p1 = classifyCommand(part1, '', ps);
    expect(p1.tier).toBe('red');
    expect(p1.ask).toBeUndefined();
  });

  it('reads there are reads; Fedora too', () => {
    expect(
      classifyCommand(`ssh -o BatchMode=yes -o ConnectTimeout=15 ${FED} 'ls /boot | grep -i rescue; cat /etc/machine-id'`, '', ps).tier,
    ).toBe('green');
    expect(classifyCommand(`ssh ${FED} 'uname -r; rpm -q kernel-core'`).tier).toBe('green');
  });

  it('asks there for what it asks here (a registry write there used to run unasked), and says where', () => {
    const reg = `$cmd = @'\nfunction Set-HarvReg($p,$n,$v){ New-ItemProperty $p -Name $n -Value $v -PropertyType DWord -Force | Out-Null }; Set-HarvReg 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection' 'AllowTelemetry' 0\n'@\nssh -o BatchMode=yes ${WIN} $cmd`;
    const v = classifyCommand(reg, '', ps);
    expect(v.ask).toMatch(/^On User@100\.64\.0\.5: .*registry/);
    expect(v.remote).toBe(WIN);
    const apps = `$cmd = @'\nGet-AppxPackage -AllUsers Microsoft.YourPhone | Remove-AppxPackage -AllUsers\n'@\nfor ($i = 1; $i -le 4; $i++) { ssh -o BatchMode=yes ${WIN} $cmd; if ($LASTEXITCODE -ne 255) { break } }`;
    expect(classifyCommand(apps, '', ps)).toMatchObject({ remote: WIN, ask: expect.stringMatching(/install/i) });
  });

  it('keeps the hard stops there', () => {
    expect(classifyCommand(`ssh ${FED} 'cat ~/.ssh/id_ed25519'`).tier).toBe('blocked');
    expect(classifyCommand(`ssh ${FED} 'rm -rf / --no-preserve-root'`).tier).toBe('blocked');
    expect(classifyCommand(`ssh ${FED} 'export ANTHROPIC_API_KEY=x'`).tier).toBe('blocked');
  });

  it('still judges what runs here', () => {
    const v = classifyCommand(`Remove-Item C:\\Windows\\Temp\\x.log; ssh ${WIN} whoami`, '', ps);
    if (onWindows) expect(v.ask).toMatch(/Windows folder/);
    expect(v.tier).toBe('red');
  });
});

describe('scripts copied, moved or sent are files, not runs', () => {
  windowsIt('a rename of a script in the workspace runs', () => {
    const v = classifyCommand(`Move-Item "${cleanup}" "${join(ws, 'harv-cleanup.ps1')}"`, '', ps);
    expect(v.ask).toBeUndefined();
    expect(v.reason).toMatch(/Moves, renames or copies/);
  });

  it('Taildrop and scp to my computer run, unread and unsent', () => {
    const drop = `tailscale file cp "${cleanup}" laptopwin:`;
    expect(classifyCommand(drop, '', ps).ask).toBeUndefined();
    expect(sends(drop)).toBe(false);
    expect(sends(`tailscale file cp "${cleanup}" officepc:`)).toBe(true);
    for (const scp of [
      `scp -o BatchMode=yes "${cleanup}" "${WIN}:C:/Users/User/harv-cleanup.ps1"`,
      `scp -o BatchMode=yes "${cleanup}" "${WIN}:harv-cleanup.ps1"`,
    ]) {
      const v = classifyCommand(scp, '', ps);
      expect(v.tier).not.toBe('blocked');
      expect(v.ask).toBeUndefined();
      expect(sends(scp)).toBe(false);
    }
    expect(sends(`scp "${cleanup}" "someone@100.64.0.9:x.ps1"`)).toBe(true);
  });

  it('ssh\'s -o isn\'t an output file ("write it first")', () => {
    const v = classifyCommand(
      `ssh -o BatchMode=yes ${WIN} 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\User\\Downloads\\harv-cleanup.ps1'`,
      '',
      ps,
    );
    expect(v.tier).not.toBe('blocked');
  });

  it('a script fed to my computer is read as running there, and is no sending', () => {
    const inv = join(ws, 'inventory.sh');
    writeFileSync(
      inv,
      "#!/bin/bash\ndnf repoquery --userinstalled --qf '%{name}\\n' | grep -vE '^(kernel|passwd|shadow)' | sort -u\nflatpak list --app\n",
    );
    const cmd = `ssh -o BatchMode=yes -o ConnectTimeout=15 ${FED} 'bash -s' < "${inv}"`;
    expect(classifyCommand(cmd).ask).toBeUndefined();
    expect(isSending('Bash', { command: cmd })).toBe(false);
    expect(isSending('Bash', { command: `ssh someone@100.64.0.9 'bash -s' < "${inv}"` })).toBe(true);
    expect(isSending('Bash', { command: `cat "${inv}" | ssh someone@100.64.0.9` })).toBe(true);
  });

  it('a script that really runs is still read first', () => {
    expect(scriptsRun(`powershell -NoProfile -File "${cleanup}"`, ws)).toContain(cleanup);
    expect(scriptsRun(`Start-Process powershell -ArgumentList '-File "${cleanup}"'`, ws)).toContain(cleanup);
    expect(scriptsRun(`Copy-Item "${cleanup}" "${join(ws, 'b.ps1')}"`, ws)).toEqual([]);
  });
});

// Cases that didn't happen in the chat: the same rules for other programs, hosts and shells.
describe('the same rules, in general', () => {
  const sh = join(ws, 'job.sh');
  writeFileSync(sh, '#!/bin/bash\nsystemctl --user restart thing\n');

  it('a quoted name is a file for any program that takes files, a script for anything that runs it', () => {
    for (const cmd of [
      `git add "${cleanup}"`,
      `7z a out.zip "${cleanup}"`,
      `Compress-Archive -Path "${cleanup}" -DestinationPath out.zip`,
      `Get-FileHash "${cleanup}"`,
      `tar -czf out.tgz "${sh}"`,
      `rsync -av "${sh}" "laptopfed:/tmp/"`,
      `zip out.zip "${sh}"`,
    ])
      expect(scriptsRun(cmd, ws)).toEqual([]);
    for (const cmd of [
      `bash -c "${sh}"`,
      `nohup "${sh}"`,
      `timeout 60 "${sh}"`,
      `cmd /c "${join(ws, 'x.bat')}"`,
      `& "${cleanup}"`,
      `"${sh}"`,
    ]) {
      writeFileSync(join(ws, 'x.bat'), 'echo hi');
      expect(scriptsRun(cmd, ws).length).toBeGreaterThan(0);
    }
  });

  it('any ssh form: options with values, plink, a heredoc, a Linux path there', () => {
    const forms = [
      `ssh -p 2222 -i key -o BatchMode=yes ${FED} 'cat /etc/fstab'`,
      `plink -batch ${FED} "cat /etc/os-release"`,
      `ssh ${FED} <<'EOF'\ncat /etc/fstab\nls /boot\nEOF`,
    ];
    for (const cmd of forms) {
      const v = classifyCommand(cmd);
      expect(v.tier).toBe('green');
      expect(v.ask).toBeUndefined();
    }
    // A change in a system folder there is judged by the ask list, not as this PC's system folder.
    const conf = classifyCommand(`ssh ${FED} 'systemctl --user restart pipewire'`);
    expect(conf.reason).toMatch(/^On user@100\.64\.0\.6/);
  });

  it('sending: only my own computers are mine, whatever the tool', () => {
    expect(sends(`rsync -av "${sh}" laptopfed:/tmp/`)).toBe(false);
    expect(sends(`rsync -av "${sh}" stranger.example.com:/tmp/`)).toBe(true);
    expect(sends(`scp "${sh}" user@laptopwin.tailnet.ts.net:`)).toBe(false);
    expect(sends(`ssh ${FED} 'bash -s' < "${sh}"`)).toBe(false);
    expect(sends(`ssh -p 2222 stranger@203.0.113.7 'bash -s' < "${sh}"`)).toBe(true);
  });

  it('a hard stop is one wherever it runs', () => {
    expect(classifyCommand(`plink ${FED} "cat ~/.ssh/id_ed25519"`).tier).toBe('blocked');
    expect(classifyCommand(`ssh -p 2222 stranger@203.0.113.7 'rm -rf ~'`).tier).toBe('blocked');
    expect(classifyCommand(`ssh ${WIN} "Format-Volume -DriveLetter C"`, '', ps).tier).not.toBe('green');
  });
});
