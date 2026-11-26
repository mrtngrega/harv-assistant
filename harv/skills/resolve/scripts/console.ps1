# Types one line into DaVinci Resolve's Console (Workspace > Console, F6) and presses Enter.
# Used by resolve.mjs to start Harv's bridge: free Resolve runs scripts only from there.
# The line comes base64 (UTF-8) so no shell or SendKeys quoting can change it.
# Nothing is clicked or typed unless Resolve's window is really in front: NOT_FRONT otherwise (the full
# review, R15: keys went to whatever window had the focus). -CheckOnly brings it forward and only reports.
param([Parameter(Mandatory = $true)][string]$LineB64, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$line = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($LineB64))

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ResolveWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static List<KeyValuePair<IntPtr, string>> Of(uint pid) {
    var found = new List<KeyValuePair<IntPtr, string>>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var s = new StringBuilder(256); GetWindowText(h, s, 256);
        found.Add(new KeyValuePair<IntPtr, string>(h, s.ToString()));
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
Add-Type -AssemblyName System.Windows.Forms
[ResolveWin]::SetProcessDPIAware() | Out-Null

$proc = Get-Process Resolve -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output 'NO_RESOLVE'; exit 2 }

# Brings a window to the front and checks it got there (Windows may refuse; an Alt tap usually lets it).
function Bring-Front($h) {
  if ([ResolveWin]::IsIconic($h)) { [ResolveWin]::ShowWindow($h, 9) | Out-Null }
  [ResolveWin]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 300
  if ([ResolveWin]::GetForegroundWindow() -eq $h) { return $true }
  [ResolveWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [ResolveWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [ResolveWin]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 300
  return ([ResolveWin]::GetForegroundWindow() -eq $h)
}
function Still-Front($h) { return ([ResolveWin]::GetForegroundWindow() -eq $h) }

function Console-Window { [ResolveWin]::Of($proc.Id) | Where-Object { $_.Value -eq 'Resolve' } | Select-Object -First 1 }

$console = Console-Window
if (-not $console) {
  $wins = [ResolveWin]::Of($proc.Id)
  $main = $wins | Where-Object { $_.Value -like 'DaVinci Resolve*' } | Select-Object -First 1
  # The Project Manager alone (no project open yet): it has no Console.
  if (-not $main -and ($wins | Where-Object { $_.Value -eq 'Project Manager' })) { Write-Output 'PROJECT_MANAGER'; exit 5 }
  if (-not $main) { Write-Output 'NO_WINDOW'; exit 3 }
  if (-not (Bring-Front $main.Key)) { Write-Output 'NOT_FRONT'; exit 6 }
  if ($CheckOnly) { Write-Output 'FRONT'; exit 0 }
  [System.Windows.Forms.SendKeys]::SendWait('{F6}')
  for ($i = 0; $i -lt 20 -and -not $console; $i++) { Start-Sleep -Milliseconds 150; $console = Console-Window }
  if (-not $console) { Write-Output 'NO_CONSOLE'; exit 4 }
}
if (-not (Bring-Front $console.Key)) { Write-Output 'NOT_FRONT'; exit 6 }
if ($CheckOnly) { Write-Output 'FRONT'; exit 0 }

# Click into the input line at the bottom of the Console, then put the mouse back.
if (-not (Still-Front $console.Key)) { Write-Output 'NOT_FRONT'; exit 6 }
$r = New-Object ResolveWin+RECT
[ResolveWin]::GetWindowRect($console.Key, [ref]$r) | Out-Null
$back = New-Object ResolveWin+POINT
[ResolveWin]::GetCursorPos([ref]$back) | Out-Null
[ResolveWin]::SetCursorPos([int](($r.L + $r.R) / 2), $r.B - 20) | Out-Null
[ResolveWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[ResolveWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
[ResolveWin]::SetCursorPos($back.X, $back.Y) | Out-Null
Start-Sleep -Milliseconds 200

$keys = ($line.ToCharArray() | ForEach-Object {
    if ('+^%~(){}[]'.Contains([string]$_)) { '{' + $_ + '}' } else { [string]$_ }
  }) -join ''
# The user may have switched windows meanwhile: never type into anything else.
if (-not (Still-Front $console.Key)) { Write-Output 'NOT_FRONT'; exit 6 }
[System.Windows.Forms.SendKeys]::SendWait($keys + '{ENTER}')
Write-Output 'TYPED'
