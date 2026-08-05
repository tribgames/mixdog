<#
  Dev update loop for the INSTALLED desktop build.

  Production updates are electron-updater over the GitHub feed and only run in a
  packaged app, so a change in this working tree could never be pushed through
  the real update path locally. This script closes that gap in two modes:

    (default)     build -> stop app -> stop BACKEND DAEMON -> silent reinstall
                  -> relaunch. The daemon stop is the point: a dev rebuild keeps
                  the same version, so the version-skew drain in
                  engine-daemon-client.mjs never fires and a fresh install would
                  otherwise attach to the still-running OLD backend.

    -ViaUpdater   build a version-bumped artifact, serve dist over 127.0.0.1 and
                  let the app's own updater (check -> download -> ready ->
                  install -> relaunch) perform the swap. Same code the release
                  build runs, pointed at this working tree.

  -DryRun prints the resolved plan and current process/daemon state and changes
  nothing — every other mode stops the running app and its backend.
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$ViaUpdater,
  [switch]$NoLaunch,
  [switch]$KeepDaemon,
  [switch]$DryRun,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\mixdog-desktop'),
  [string]$Version = '',
  [int]$FeedPort = 9357
)

$ErrorActionPreference = 'Stop'
$desktopDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $desktopDir '..\..')).Path
$distDir = Join-Path $desktopDir 'dist'
$installer = Join-Path $distDir 'mixdog-desktop-win-x64.exe'
$installedExe = Join-Path $InstallDir 'Mixdog.exe'
$runtimeRoot = if ($env:MIXDOG_RUNTIME_ROOT) { $env:MIXDOG_RUNTIME_ROOT } else { Join-Path $env:TEMP 'mixdog' }
$engineDiscovery = Join-Path $runtimeRoot 'engine-daemon.json'

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }

function Get-AppProcess {
  # The desktop MAIN process only: Chromium children carry --type=, and the
  # backend/memory forks run the same exe with a script argument.
  return @(Get-CimInstance Win32_Process -Filter "Name='Mixdog.exe'" | Where-Object {
    $_.ExecutablePath -eq $installedExe -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '\.mjs'
  })
}

function Get-BackendProcess {
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'backend-daemon\.mjs' -or $_.CommandLine -match 'runtime\\memory\\index\.mjs'
  })
}

function Get-DaemonRecord {
  if (-not (Test-Path -LiteralPath $engineDiscovery)) { return $null }
  try { return (Get-Content -LiteralPath $engineDiscovery -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-InstalledVersion {
  if (-not (Test-Path -LiteralPath $installedExe)) { return '' }
  return [string](Get-Item -LiteralPath $installedExe).VersionInfo.ProductVersion
}

function Get-NextDevVersion {
  $manifest = Get-Content -LiteralPath (Join-Path $desktopDir 'package.json') -Raw | ConvertFrom-Json
  $parts = ([string]$manifest.version).Split('.')
  return "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
}

function Stop-MixdogApp {
  # @() at every call site: PowerShell unrolls a single-element return value,
  # and a lone CimInstance has no usable .Count.
  $apps = @(Get-AppProcess)
  if (-not $apps.Count) { Write-Host '    app is not running'; return }
  foreach ($app in $apps) {
    Write-Host "    closing Mixdog.exe pid=$($app.ProcessId)"
    $process = Get-Process -Id $app.ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    [void]$process.CloseMainWindow()
    if (-not $process.WaitForExit(15000)) {
      Write-Host "    forcing pid=$($app.ProcessId)"
      Stop-Process -Id $app.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Stop-Backend {
  # Same /shutdown the client's shutdownEngineDaemon() posts; the daemon owns
  # both front doors, so one call ends channels + engines + memory client.
  $record = Get-DaemonRecord
  if ($record -and $record.port -and $record.token) {
    try {
      Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($record.port)/shutdown" `
        -Headers @{ 'X-Mixdog-Daemon-Token' = [string]$record.token } -Body '{}' `
        -ContentType 'application/json' -TimeoutSec 5 | Out-Null
      Write-Host "    asked backend daemon pid=$($record.pid) to exit"
    } catch {
      Write-Host "    daemon /shutdown failed: $($_.Exception.Message)"
    }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (@(Get-BackendProcess).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  foreach ($process in @(Get-BackendProcess)) {
    Write-Host "    force stopping backend pid=$($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $engineDiscovery -Force -ErrorAction SilentlyContinue
}

function Wait-ForApp {
  param([int]$TimeoutSeconds = 30)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (@(Get-AppProcess).Count -gt 0) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Wait-ForFreshDaemon {
  param($Previous, [int]$TimeoutSeconds = 120)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $record = Get-DaemonRecord
    if ($record -and $record.pid -and (-not $Previous -or [int]$record.pid -ne [int]$Previous.pid)) { return $record }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Invoke-Build {
  param([string]$OverrideVersion)
  Push-Location $desktopDir
  try {
    if ([string]::IsNullOrWhiteSpace($OverrideVersion)) {
      & npm.cmd run build:win
      if ($LASTEXITCODE -ne 0) { throw "build:win exited with $LASTEXITCODE" }
      return
    }
    # Same steps as build:win, with the version the local feed will advertise.
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "build exited with $LASTEXITCODE" }
    & npm.cmd run prepare:runtime -- --platform=win32 --arch=x64
    if ($LASTEXITCODE -ne 0) { throw "prepare:runtime exited with $LASTEXITCODE" }
    & npm.cmd run brand:win
    if ($LASTEXITCODE -ne 0) { throw "brand:win exited with $LASTEXITCODE" }
    & npx.cmd electron-builder --win --x64 --publish never "-c.extraMetadata.version=$OverrideVersion"
    if ($LASTEXITCODE -ne 0) { throw "electron-builder exited with $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

$appBefore = @(Get-AppProcess)
$daemonBefore = Get-DaemonRecord
$backendBefore = @(Get-BackendProcess)
$installedBefore = Get-InstalledVersion
$targetVersion = if ($ViaUpdater) {
  if ([string]::IsNullOrWhiteSpace($Version)) { Get-NextDevVersion } else { $Version }
} else { $Version }

Write-Host ''
Write-Host "mode            : $(if ($ViaUpdater) { 'via updater (local feed)' } else { 'reinstall' })"
Write-Host "repo root       : $repoRoot"
Write-Host "install dir     : $InstallDir"
Write-Host "installer       : $installer$(if (Test-Path -LiteralPath $installer) { '' } else { '  (missing - will be built)' })"
Write-Host "runtime root    : $runtimeRoot"
Write-Host "installed now   : $(if ($installedBefore) { $installedBefore } else { '(not installed)' })"
if ($targetVersion) { Write-Host "target version  : $targetVersion" }
Write-Host "app pid(s)      : $(if ($appBefore.Count) { ($appBefore.ProcessId -join ', ') } else { '(none)' })"
Write-Host "backend pid(s)  : $(if ($backendBefore.Count) { ($backendBefore.ProcessId -join ', ') } else { '(none)' })"
Write-Host "daemon record   : $(if ($daemonBefore) { "pid=$($daemonBefore.pid) port=$($daemonBefore.port)" } else { '(none)' })"
Write-Host ''

if ($DryRun) {
  Write-Host 'dry run - nothing was stopped, built, or installed.' -ForegroundColor Yellow
  exit 0
}

if (-not (Test-Path -LiteralPath $InstallDir)) {
  throw "No installed build at $InstallDir. Install one first (npm run build:win, then run the installer)."
}

if (-not $SkipBuild) {
  Write-Step 'building the installer from the dev root'
  Invoke-Build $targetVersion
}
if (-not (Test-Path -LiteralPath $installer)) { throw "Installer artifact missing: $installer" }

if ($ViaUpdater) {
  Write-Step "serving $distDir on http://127.0.0.1:$FeedPort"
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $feed = Start-Process -FilePath $node -ArgumentList @(
    (Join-Path $PSScriptRoot 'dev-update-feed.mjs'), "--dir=$distDir", "--port=$FeedPort"
  ) -PassThru -WindowStyle Hidden
  try {
    Write-Step 'restarting the installed app against the dev feed'
    Stop-MixdogApp
    if (-not $KeepDaemon) { Stop-Backend }
    $env:MIXDOG_UPDATER_DEV_FEED = "http://127.0.0.1:$FeedPort"
    $env:MIXDOG_UPDATER_DEV_AUTO_INSTALL = '1'
    Start-Process -FilePath $installedExe | Out-Null
    Write-Step "waiting for the app's own updater to install $targetVersion"
    $deadline = [DateTime]::UtcNow.AddMinutes(6)
    while ((Get-InstalledVersion) -ne $targetVersion -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Seconds 2
    }
    if ((Get-InstalledVersion) -ne $targetVersion) {
      throw "The updater did not install $targetVersion (installed: $(Get-InstalledVersion))."
    }
  } finally {
    if ($feed -and -not $feed.HasExited) { Stop-Process -Id $feed.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item Env:MIXDOG_UPDATER_DEV_FEED -ErrorAction SilentlyContinue
    Remove-Item Env:MIXDOG_UPDATER_DEV_AUTO_INSTALL -ErrorAction SilentlyContinue
  }
} else {
  Write-Step 'stopping the installed app'
  Stop-MixdogApp
  if (-not $KeepDaemon) {
    Write-Step 'stopping the backend daemon (a same-version rebuild never drains it on its own)'
    Stop-Backend
  }
  Write-Step 'reinstalling'
  $install = Start-Process -FilePath $installer -ArgumentList @('/S', '/currentuser', "/D=$InstallDir") -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installer exited with $($install.ExitCode)" }
  # A one-click NSIS install relaunches the app itself; only start it when it
  # did not, so a single-instance lock never turns into a second window.
  if (-not (Wait-ForApp -TimeoutSeconds 20) -and -not $NoLaunch) {
    Write-Step 'starting the installed app'
    Start-Process -FilePath $installedExe | Out-Null
  }
}

if ($NoLaunch) {
  Write-Step 'stopping the app again (-NoLaunch)'
  Stop-MixdogApp
  if (-not $KeepDaemon) { Stop-Backend }
} else {
  Write-Step 'waiting for a fresh backend daemon'
  $daemonAfter = Wait-ForFreshDaemon -Previous $daemonBefore
}

$appAfter = @(Get-AppProcess)
Write-Host ''
Write-Host 'result' -ForegroundColor Green
Write-Host "  installed version : $installedBefore -> $(Get-InstalledVersion)"
Write-Host "  app pid(s)        : $(if ($appAfter.Count) { ($appAfter.ProcessId -join ', ') } else { '(none)' })"
Write-Host "  backend daemon    : $(if ($daemonBefore) { "pid=$($daemonBefore.pid)" } else { '(none)' }) -> $(if ($daemonAfter) { "pid=$($daemonAfter.pid) port=$($daemonAfter.port)" } elseif ($NoLaunch) { '(stopped)' } else { '(did not appear)' })"
if (-not $NoLaunch -and -not $daemonAfter -and -not $KeepDaemon) {
  throw 'The backend daemon did not come back up — check channels-worker-standalone.log.'
}
