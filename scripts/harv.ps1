<#
  Start, stop or restart Harv (the server and the dashboard), safely.

    powershell -ExecutionPolicy Bypass -File scripts\harv.ps1 start     # or: stop, restart

  start    Starts Harv hidden if it isn't running (no auto-restart, so Harv can edit its own
           code). It opens the dashboard in the browser only with -Browser: the user uses the app.
  stop     Asks Harv to shut down cleanly (saves terminals, closes the database),
           then ends whatever is left on its ports. Never touches other programs.
  restart  stop, then start.

  The desktop shortcuts run this. Logs go to ~/.harv/logs/harv.log.
#>
param(
  [ValidateSet('start', 'stop', 'restart')]
  [string]$Action = 'start',
  # Seconds to wait first (the dashboard's Restart button uses this while the old Harv shuts down).
  [int]$Delay = 0,
  # Open the dashboard in the browser after starting (off by default since 2026-11-09: the user uses
  # only the app, and a restart from a dev session kept opening browser tabs).
  [switch]$Browser,
  # Accepted for older callers (the app, the server); not opening the browser is the default now.
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$HarvHome = if ($env:HARV_HOME) { $env:HARV_HOME } else { Join-Path $env:USERPROFILE '.harv' }
$Logs = Join-Path $HarvHome 'logs'
$PidFile = Join-Path $HarvHome 'harv.pid'
$Dashboard = 'http://127.0.0.1:4316'
$Server = 'http://127.0.0.1:4317'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

function Get-PortPids([int[]]$Ports) {
  $lines = netstat -ano | Select-String -Pattern 'LISTENING'
  $pids = foreach ($line in $lines) {
    $parts = ($line.ToString().Trim() -split '\s+')
    foreach ($port in $Ports) {
      if ($parts[1] -match ":$port$") { $parts[-1] }
    }
  }
  $pids | Where-Object { $_ -and $_ -ne '0' } | Sort-Object -Unique
}

function Test-Url([string]$Url) {
  try {
    Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 2 -Headers @{ Origin = $Dashboard } | Out-Null
    return $true
  } catch {
    return $false
  }
}

# Harv's own processes only (the full review, D21): Windows reuses process ids, so an old harv.pid can
# name any program by now, and another project's dev server can sit on a port while Harv is down.
# Harv's are the cmd running "npm run harv" and the node processes started from this repo.
function Test-HarvProcess([string]$Id) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction SilentlyContinue
  if (-not $proc -or -not $proc.CommandLine) { return $false }
  $line = $proc.CommandLine
  return $line.Contains('npm run harv') -or $line.ToLowerInvariant().Contains($Repo.ToLowerInvariant())
}

# taskkill through cmd: in Windows PowerShell its "not found" messages would otherwise stop the script.
function Stop-Tree([string]$Id) {
  if (-not (Test-HarvProcess $Id)) {
    $name = (Get-Process -Id $Id -ErrorAction SilentlyContinue).ProcessName
    if ($name) { Write-Log "left process $Id ($name) alone: it isn't Harv's" }
    return
  }
  cmd.exe /c "taskkill /PID $Id /T /F >nul 2>&1"
}

function Stop-Harv {
  # A clean shutdown first: Harv saves terminals and layout and closes its database.
  if (Get-PortPids 4317) {
    try {
      Invoke-WebRequest "$Server/api/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 5 -Headers @{ Origin = $Dashboard } | Out-Null
    } catch {}
    for ($i = 0; $i -lt 24 -and (Get-PortPids 4317); $i++) { Start-Sleep -Milliseconds 250 }
  }
  # Then whatever is left: the process tree this script started, and anything still on Harv's ports.
  if (Test-Path $PidFile) {
    $old = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($old) { Stop-Tree $old }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
  foreach ($p in (Get-PortPids 4317, 4316)) { Stop-Tree $p }
  for ($i = 0; $i -lt 20 -and (Get-PortPids 4317, 4316); $i++) { Start-Sleep -Milliseconds 250 }
}

function Start-Harv {
  $serverUp = Test-Url "$Server/api/health"
  $webUp = Test-Url $Dashboard
  if ($serverUp -and $webUp) {
    if ($Browser) { Start-Process $Dashboard }
    Write-Host 'Harv is already running.'
    return
  }
  # Half running (or a stuck old process on the ports): clear it first.
  if (Get-PortPids 4317, 4316) { Stop-Harv }

  $log = Join-Path $Logs 'harv.log'
  if (Test-Path $log) { Move-Item $log (Join-Path $Logs 'harv.previous.log') -Force }
  # Twice: a start that quits at once can be a passing hiccup (2026-10-31: npm briefly couldn't find
  # concurrently right after a restart, and Harv stayed down until started by hand).
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npm run harv >> `"$log`" 2>&1" -WorkingDirectory $Repo -WindowStyle Hidden -PassThru
    Set-Content -Path $PidFile -Value $proc.Id
    for ($i = 0; $i -lt 180; $i++) {
      if ((Test-Url "$Server/api/health") -and (Test-Url $Dashboard)) {
        if ($Browser) { Start-Process $Dashboard }
        Write-Host 'Harv is running.'
        return
      }
      if ($proc.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not $proc.HasExited) { break }
    Write-Log "start attempt $attempt quit at once"
    if (Get-PortPids 4317, 4316) { Stop-Harv }
    Start-Sleep -Seconds 3
  }
  Write-Log "didn't start (see harv.log)"
  Write-Host "Harv didn't start. See $log"
  Start-Process notepad.exe $log
  exit 1
}

function Write-Log([string]$Text) {
  Add-Content -Path (Join-Path $Logs 'harv-script.log') -Value "$(Get-Date -Format 's') [$PID] $Text"
}

Write-Log "$Action (delay $Delay)"
trap { Write-Log "failed: $_"; break }
if ($Delay -gt 0) { Start-Sleep -Seconds $Delay }
switch ($Action) {
  'start' { Start-Harv }
  'stop' { Stop-Harv; Write-Host 'Harv is stopped.' }
  'restart' { Stop-Harv; Write-Log 'stopped, starting'; Start-Harv }
}
Write-Log "$Action done"
