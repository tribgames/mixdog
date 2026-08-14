<#
  Dev update loop for the INSTALLED desktop build.

  Production updates are electron-updater over the GitHub feed and only run in a
  packaged app, so a change in this working tree could never be pushed through
  the real update path locally. This script closes that gap in two modes:

    (default)     build -> stop app -> stop daemon -> silent reinstall
                  -> relaunch. The daemon stop is the point: a dev rebuild keeps
                  the same version, so the version-skew drain in
                  session-client.mjs never fires and a fresh install would
                  otherwise attach to the still-running old session daemon.

    -ViaUpdater   build a version-bumped artifact, serve dist over 127.0.0.1 and
                  let the app's own updater (check -> download -> ready ->
                  install -> relaunch) perform the swap. Same code the release
                  build runs, pointed at this working tree.

    -FastDirect   build only win-unpacked, then atomically swap it into the
                  installed location. Preserves the registered uninstaller,
                  rolls back on a failed relaunch, and skips NSIS compression.

  -DryRun prints the resolved plan and current process/daemon state and changes
  nothing — every other mode stops the running app and its session daemon.
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$ViaUpdater,
  [switch]$FastDirect,
  [switch]$FastDirectWorker,
  [switch]$NoLaunch,
  [switch]$KeepDaemon,
  [switch]$DryRun,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\mixdog-desktop'),
  [string]$Version = '',
  [string]$ReceiptPath = '',
  [int]$FeedPort = 9357
)

$ErrorActionPreference = 'Stop'
$desktopDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $desktopDir '..\..')).Path
$distDir = Join-Path $desktopDir 'dist'
$installer = Join-Path $distDir 'mixdog-desktop-win-x64.exe'
$unpackedDir = Join-Path $distDir 'win-unpacked'
$installedExe = Join-Path $InstallDir 'Mixdog.exe'
$runtimeRoot = if ($env:MIXDOG_RUNTIME_ROOT) { $env:MIXDOG_RUNTIME_ROOT } else { Join-Path $env:TEMP 'mixdog' }
$daemonDiscovery = Join-Path $runtimeRoot 'daemon.json'
$mixdogDataDir = if ($env:MIXDOG_DATA_DIR) { $env:MIXDOG_DATA_DIR } else { Join-Path $env:USERPROFILE '.mixdog\data' }
$tokenManifest = Join-Path $repoRoot 'native\mixdog-token\Cargo.toml'
$tokenBuild = Join-Path $repoRoot 'native\mixdog-token\target\release\mixdog_token.dll'

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }

function Write-FastDirectReceipt {
  param(
    [string]$Status,
    [string]$Detail = ''
  )
  if ([string]::IsNullOrWhiteSpace($ReceiptPath)) { return }
  $parent = Split-Path -Parent $ReceiptPath
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = "$ReceiptPath.$PID.tmp"
  [ordered]@{
    status = $Status
    detail = $Detail
    pid = $PID
    at = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $ReceiptPath -Force
}

function Start-FastDirectWorker {
  if ([string]::IsNullOrWhiteSpace($ReceiptPath)) {
    throw 'FastDirect worker receipt path is required.'
  }
  $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
  $scriptPath = $PSCommandPath
  $quote = {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
  }
  $workerCommand = "& $(& $quote $scriptPath) -FastDirect -FastDirectWorker -SkipBuild" `
    + " -InstallDir $(& $quote $InstallDir) -Version $(& $quote $targetVersion)" `
    + " -ReceiptPath $(& $quote $ReceiptPath)" `
    + $(if ($NoLaunch) { ' -NoLaunch' } else { '' })
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($workerCommand))
  $commandLine = "`"$pwsh`" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $encoded"
  # WMI owns the deployment worker, not Mixdog's shell process tree. Stopping
  # the app/daemon therefore cannot kill the worker before the directory swap.
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $commandLine
  }
  if ([int]$created.ReturnValue -ne 0 -or [int]$created.ProcessId -le 0) {
    throw "Failed to start detached fast deploy worker (WMI return $($created.ReturnValue))."
  }
  Write-FastDirectReceipt -Status 'launched' -Detail "workerPid=$($created.ProcessId)"
  return [int]$created.ProcessId
}

function Start-DetachedMixdogApp {
  if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) {
    throw "Installed app is missing: $installedExe"
  }
  # Explorer performs the GUI launch outside the deployment worker's console
  # and process tree. Closing that shell can no longer close the new app.
  Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') `
    -ArgumentList @($installedExe) | Out-Null
}

function Install-LocalTokenAddon {
  if (-not (Test-Path -LiteralPath $tokenBuild -PathType Leaf)) {
    throw "Local token addon is missing: $tokenBuild"
  }
  $cargo = Get-Content -LiteralPath $tokenManifest -Raw
  $versionMatch = [regex]::Match($cargo, '(?m)^version\s*=\s*"(\d+\.\d+\.\d+)"\s*$')
  if (-not $versionMatch.Success) { throw "Token version is missing: $tokenManifest" }
  $version = $versionMatch.Groups[1].Value
  $tokenDir = Join-Path $mixdogDataDir 'token-bin'
  $fileName = "mixdog-token-$version.node"
  $destination = Join-Path $tokenDir $fileName
  New-Item -ItemType Directory -Path $tokenDir -Force | Out-Null
  Copy-Item -LiteralPath $tokenBuild -Destination $destination -Force
  $sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifestPath = Join-Path $tokenDir 'manifest.json'
  $temporary = "$manifestPath.$PID.tmp"
  [ordered]@{
    version = $version
    assets = [ordered]@{
      'win32-x64' = [ordered]@{
        url = "https://github.com/tribgames/mixdog/releases/download/token-v$version/mixdog-token-win32-x64.node"
        sha256 = $sha256
      }
    }
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $manifestPath -Force
  Get-ChildItem -LiteralPath $tokenDir -Filter 'mixdog-token-*' |
    Where-Object Name -ne $fileName |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

function Get-AppProcess {
  # The desktop MAIN process only: Chromium children carry --type=, and the
  # Daemon/memory forks run the same exe with a script argument.
  return @(Get-CimInstance Win32_Process -Filter "Name='Mixdog.exe'" | Where-Object {
    $_.ExecutablePath -eq $installedExe `
      -and $_.CommandLine -notmatch '--type=' `
      -and $_.CommandLine -notmatch '--eval' `
      -and $_.CommandLine -notmatch '\.mjs'
  })
}

function Get-InstalledMixdogProcess {
  return @(Get-CimInstance Win32_Process -Filter "Name='Mixdog.exe'" | Where-Object {
    $_.ExecutablePath -eq $installedExe
  })
}

function Stop-InstalledMixdogProcess {
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (@(Get-InstalledMixdogProcess).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  foreach ($process in @(Get-InstalledMixdogProcess)) {
    Write-Host "    force stopping installed Mixdog child pid=$($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (@(Get-InstalledMixdogProcess).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  $remaining = @(Get-InstalledMixdogProcess)
  if ($remaining.Count) {
    throw "Installed Mixdog processes still hold the deployment directory: $($remaining.ProcessId -join ', ')"
  }
}

function Get-DaemonProcess {
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'daemon\.mjs' -or $_.CommandLine -match 'runtime\\memory\\index\.mjs'
  })
}

function Get-DaemonRecord {
  if (-not (Test-Path -LiteralPath $daemonDiscovery)) { return $null }
  try {
    $record = Get-Content -LiteralPath $daemonDiscovery -Raw | ConvertFrom-Json
    return [pscustomobject]@{
      pid = $record.pid
      port = $record.endpoints.session.port
      token = $record.endpoints.session.token
    }
  } catch { return $null }
}

function Get-InstalledVersion {
  if (-not (Test-Path -LiteralPath $installedExe)) { return '' }
  return [string](Get-Item -LiteralPath $installedExe).VersionInfo.ProductVersion
}

function Get-NextDevVersion {
  $manifest = Get-Content -LiteralPath (Join-Path $desktopDir 'package.json') -Raw | ConvertFrom-Json
  $baseVersion = [Version]([string]$manifest.version)
  $installedVersionText = Get-InstalledVersion
  if (-not [string]::IsNullOrWhiteSpace($installedVersionText)) {
    $installedVersion = [Version]$installedVersionText
    if ($installedVersion -gt $baseVersion) { $baseVersion = $installedVersion }
  }
  return "$($baseVersion.Major).$($baseVersion.Minor).$($baseVersion.Build + 1)"
}

function Get-InstalledSemVer {
  $text = Get-InstalledVersion
  if ([string]::IsNullOrWhiteSpace($text)) { return '' }
  $value = [Version]$text
  return "$($value.Major).$($value.Minor).$($value.Build)"
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

function Stop-Daemon {
  # Same /shutdown the client's shutdownDaemon() posts; the daemon owns
  # both front doors, so one call ends channels + sessions + memory client.
  $record = Get-DaemonRecord
  if ($record -and $record.port -and $record.token) {
    try {
      Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($record.port)/shutdown" `
        -Headers @{ 'X-Mixdog-Daemon-Token' = [string]$record.token } -Body '{}' `
        -ContentType 'application/json' -TimeoutSec 5 | Out-Null
      Write-Host "    asked daemon pid=$($record.pid) to exit"
    } catch {
      Write-Host "    daemon /shutdown failed: $($_.Exception.Message)"
    }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (@(Get-DaemonProcess).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  foreach ($process in @(Get-DaemonProcess)) {
    Write-Host "    force stopping daemon pid=$($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $daemonDiscovery -Force -ErrorAction SilentlyContinue
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

function Wait-ForVisibleAppWindow {
  param([int]$TimeoutSeconds = 30)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($app in @(Get-AppProcess)) {
      $process = Get-Process -Id $app.ProcessId -ErrorAction SilentlyContinue
      if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) { return $true }
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Wait-ForFreshDaemon {
  param(
    $Previous,
    [int]$TimeoutSeconds = 120,
    [string]$RelaunchExe = '',
    [switch]$DetachedRelaunch
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $relaunchAttempts = 0
  $nextRelaunchAt = [DateTime]::UtcNow.AddSeconds(2)
  while ([DateTime]::UtcNow -lt $deadline) {
    $record = Get-DaemonRecord
    if ($record -and $record.pid -and (-not $Previous -or [int]$record.pid -ne [int]$Previous.pid)) { return $record }
    # A one-click NSIS install can briefly launch the app while its own
    # single-instance mutex is still being released, then that launch exits
    # before the daemon publishes discovery. Recover in the same command
    # instead of waiting out the full daemon timeout with no desktop process.
    if (
      $RelaunchExe `
        -and $relaunchAttempts -lt 2 `
        -and [DateTime]::UtcNow -ge $nextRelaunchAt `
        -and @(Get-AppProcess).Count -eq 0
    ) {
      $relaunchAttempts += 1
      Write-Step "desktop exited before daemon readiness; relaunching (attempt $relaunchAttempts)"
      if ($DetachedRelaunch) {
        Start-DetachedMixdogApp
      } else {
        Start-Process -FilePath $RelaunchExe | Out-Null
      }
      $nextRelaunchAt = [DateTime]::UtcNow.AddSeconds(15)
    }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Invoke-Build {
  param(
    [string]$OverrideVersion,
    [switch]$DirectoryOnly
  )
  Push-Location $desktopDir
  try {
    if ($DirectoryOnly) {
      # Fast local deployment still includes every current Desktop/runtime
      # source file, but intentionally omits the release-only typecheck and
      # NSIS compression stages.
      & node (Join-Path $repoRoot 'scripts\build-token-addon.mjs') --build --release
      if ($LASTEXITCODE -ne 0) { throw "mixdog-token addon build exited with $LASTEXITCODE" }
      & npx.cmd electron-vite build
      if ($LASTEXITCODE -ne 0) { throw "electron-vite build exited with $LASTEXITCODE" }
      & node scripts/build-daemon.mjs
      if ($LASTEXITCODE -ne 0) { throw "build-daemon exited with $LASTEXITCODE" }
      & npm.cmd run prepare:runtime -- --platform=win32 --arch=x64
      if ($LASTEXITCODE -ne 0) { throw "prepare:runtime exited with $LASTEXITCODE" }
      & npm.cmd run brand:win
      if ($LASTEXITCODE -ne 0) { throw "brand:win exited with $LASTEXITCODE" }
      & npx.cmd electron-builder --dir --win --x64 --publish never "-c.extraMetadata.version=$OverrideVersion"
      if ($LASTEXITCODE -ne 0) { throw "electron-builder --dir exited with $LASTEXITCODE" }
      return
    }
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
    & npm.cmd run verify:update-metadata
    if ($LASTEXITCODE -ne 0) { throw "verify:update-metadata exited with $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

function Install-UnpackedBuild {
  if (-not (Test-Path -LiteralPath (Join-Path $unpackedDir 'Mixdog.exe') -PathType Leaf)) {
    throw "Unpacked desktop artifact missing: $unpackedDir"
  }
  $installParent = Split-Path -Parent $InstallDir
  $installLeaf = Split-Path -Leaf $InstallDir
  $backupDir = Join-Path $installParent ".$installLeaf.fast-backup-$PID"
  if (Test-Path -LiteralPath $backupDir) {
    throw "Fast deploy backup path already exists: $backupDir"
  }
  $sourceExe = Join-Path $unpackedDir 'Mixdog.exe'
  $sourceResources = Join-Path $unpackedDir 'resources'
  $installedResources = Join-Path $InstallDir 'resources'
  $sourceUpdateMetadata = Join-Path $sourceResources 'app-update.yml'
  $installedUpdateMetadata = Join-Path $installedResources 'app-update.yml'
  if (-not (Test-Path -LiteralPath $sourceUpdateMetadata -PathType Leaf) -and
      (Test-Path -LiteralPath $installedUpdateMetadata -PathType Leaf)) {
    Copy-Item -LiteralPath $installedUpdateMetadata -Destination $sourceUpdateMetadata -Force
  }
  & node (Join-Path $PSScriptRoot 'verify-update-metadata.mjs') "--dist=$distDir"
  if ($LASTEXITCODE -ne 0) { throw "verify-update-metadata exited with $LASTEXITCODE" }
  $backupExe = Join-Path $backupDir 'Mixdog.exe'
  $backupResources = Join-Path $backupDir 'resources'
  $resourcesReplaced = $false
  $exeReplaced = $false
  function Move-WithRetry {
    param(
      [string]$Source,
      [string]$Destination,
      [string]$Stage
    )
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      try {
        Move-Item -LiteralPath $Source -Destination $Destination -ErrorAction Stop
        return
      } catch {
        if ([DateTime]::UtcNow -ge $deadline) {
          throw "$Stage failed: $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds 250
      }
    } while ($true)
  }
  try {
    New-Item -ItemType Directory -Path $backupDir -ErrorAction Stop | Out-Null
    # Only app-owned artifacts change during a source deploy. Leaving the
    # installation directory itself in place avoids locks on debug.log and
    # preserves the registered uninstaller and shortcuts.
    Move-WithRetry $installedResources $backupResources 'backup resources'
    Move-WithRetry $sourceResources $installedResources 'install resources'
    $resourcesReplaced = $true
    Move-WithRetry $installedExe $backupExe 'backup executable'
    Move-WithRetry $sourceExe $installedExe 'install executable'
    $exeReplaced = $true
    if (-not $NoLaunch) {
      Write-Step 'starting the fast-deployed app'
      Start-DetachedMixdogApp
      $fresh = Wait-ForFreshDaemon -Previous $daemonBefore -RelaunchExe $installedExe -DetachedRelaunch
      if (-not $fresh) { throw 'Fast-deployed Mixdog did not publish a fresh daemon.' }
      if (-not (Wait-ForVisibleAppWindow -TimeoutSeconds 30)) {
        throw 'Fast-deployed Mixdog did not open a visible application window.'
      }
      $script:daemonAfter = $fresh
    }
    Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction Stop
  } catch {
    $failure = $_
    if ($resourcesReplaced -or $exeReplaced) {
      Write-Step 'fast deploy failed; restoring the previous installation'
      Stop-MixdogApp
      Stop-Daemon
      Stop-InstalledMixdogProcess
      if ($exeReplaced -and (Test-Path -LiteralPath $backupExe -PathType Leaf)) {
        Remove-Item -LiteralPath $installedExe -Force -ErrorAction SilentlyContinue
        Move-WithRetry $backupExe $installedExe 'restore executable'
      }
      if ($resourcesReplaced -and (Test-Path -LiteralPath $backupResources -PathType Container)) {
        Remove-Item -LiteralPath $installedResources -Recurse -Force -ErrorAction SilentlyContinue
        Move-WithRetry $backupResources $installedResources 'restore resources'
      }
    }
    Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
    if (-not $NoLaunch -and (Test-Path -LiteralPath $installedExe -PathType Leaf)) {
      Start-DetachedMixdogApp
    }
    throw $failure
  }
}

$appBefore = @(Get-AppProcess)
$daemonBefore = Get-DaemonRecord
$daemonProcessesBefore = @(Get-DaemonProcess)
$installedBefore = Get-InstalledVersion
$targetVersion = if ($ViaUpdater) {
  if ([string]::IsNullOrWhiteSpace($Version)) { Get-NextDevVersion } else { $Version }
} elseif ($FastDirect) {
  if ([string]::IsNullOrWhiteSpace($Version)) { Get-InstalledSemVer } else { $Version }
} else { $Version }

if ($ViaUpdater -and $FastDirect) {
  throw 'ViaUpdater and FastDirect are mutually exclusive.'
}

Write-Host ''
Write-Host "mode            : $(if ($ViaUpdater) { 'via updater (local feed)' } elseif ($FastDirect) { 'fast direct' } else { 'reinstall' })"
Write-Host "repo root       : $repoRoot"
Write-Host "install dir     : $InstallDir"
Write-Host "installer       : $installer$(if (Test-Path -LiteralPath $installer) { '' } else { '  (missing - will be built)' })"
Write-Host "runtime root    : $runtimeRoot"
Write-Host "installed now   : $(if ($installedBefore) { $installedBefore } else { '(not installed)' })"
if ($targetVersion) { Write-Host "target version  : $targetVersion" }
Write-Host "app pid(s)      : $(if ($appBefore.Count) { ($appBefore.ProcessId -join ', ') } else { '(none)' })"
Write-Host "daemon pid(s)   : $(if ($daemonProcessesBefore.Count) { ($daemonProcessesBefore.ProcessId -join ', ') } else { '(none)' })"
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
  Write-Step $(if ($FastDirect) { 'building win-unpacked from the full dev root' } else { 'building the installer from the dev root' })
  Invoke-Build $targetVersion -DirectoryOnly:$FastDirect
}
if ($FastDirect) {
  if (-not (Test-Path -LiteralPath $unpackedDir)) { throw "Unpacked artifact missing: $unpackedDir" }
} elseif (-not (Test-Path -LiteralPath $installer)) {
  throw "Installer artifact missing: $installer"
}

if ($FastDirect -and -not $FastDirectWorker) {
  if ([string]::IsNullOrWhiteSpace($ReceiptPath)) {
    $ReceiptPath = Join-Path $env:USERPROFILE '.mixdog\data\dev-fast-deploy.json'
  }
  Remove-Item -LiteralPath $ReceiptPath -Force -ErrorAction SilentlyContinue
  $workerPid = Start-FastDirectWorker
  Write-Step "fast deploy handed to detached worker pid=$workerPid"
  Write-Host "receipt         : $ReceiptPath"
  exit 0
}

if ($ViaUpdater) {
  Write-Step "serving $distDir on http://127.0.0.1:$FeedPort"
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $feed = Start-Process -FilePath $node -ArgumentList @(
    (Join-Path $PSScriptRoot 'dev-update-feed.mjs'), "--dir=$distDir", "--port=$FeedPort"
  ) -PassThru -WindowStyle Hidden
  try {
    Write-Step 'restarting the installed app against the dev feed'
    Stop-MixdogApp
    if (-not $KeepDaemon) { Stop-Daemon }
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
} elseif ($FastDirect) {
  try {
    Write-FastDirectReceipt -Status 'worker-started'
    # Let the launching Mixdog shell return before this independent worker
    # terminates the app and daemon that owned it.
    Start-Sleep -Seconds 2
    Write-Step 'stopping the installed app'
    Stop-MixdogApp
    Write-Step 'stopping the session daemon'
    Stop-Daemon
    Write-Step 'waiting for every installed Mixdog process to release files'
    Stop-InstalledMixdogProcess
    Write-Step 'installing the in-process Mixdog token addon'
    Install-LocalTokenAddon
    Write-Step 'atomically replacing the installed directory'
    Install-UnpackedBuild
    Write-FastDirectReceipt -Status 'completed'
  } catch {
    Write-FastDirectReceipt -Status 'failed' -Detail $_.Exception.Message
    throw
  }
} else {
  Write-Step 'stopping the installed app'
  Stop-MixdogApp
  if (-not $KeepDaemon) {
    Write-Step 'stopping the session daemon (a same-version rebuild never drains it on its own)'
    Stop-Daemon
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
  if (-not $KeepDaemon) { Stop-Daemon }
} elseif (-not $FastDirect) {
  Write-Step 'waiting for a fresh session daemon'
  $daemonAfter = Wait-ForFreshDaemon -Previous $daemonBefore -RelaunchExe $installedExe
  if (-not (Wait-ForVisibleAppWindow -TimeoutSeconds 15)) {
    # A live background process is not a successful relaunch. Starting the exe
    # again either creates the missing app or activates the primary instance
    # through Electron's second-instance handler.
    Write-Step 'activating the installed app window'
    Start-Process -FilePath $installedExe | Out-Null
    if (-not (Wait-ForVisibleAppWindow -TimeoutSeconds 30)) {
      throw 'Mixdog restarted without a visible application window.'
    }
  }
}

$appAfter = @(Get-AppProcess)
Write-Host ''
Write-Host 'result' -ForegroundColor Green
Write-Host "  installed version : $installedBefore -> $(Get-InstalledVersion)"
Write-Host "  app pid(s)        : $(if ($appAfter.Count) { ($appAfter.ProcessId -join ', ') } else { '(none)' })"
Write-Host "  session daemon    : $(if ($daemonBefore) { "pid=$($daemonBefore.pid)" } else { '(none)' }) -> $(if ($daemonAfter) { "pid=$($daemonAfter.pid) port=$($daemonAfter.port)" } elseif ($NoLaunch) { '(stopped)' } else { '(did not appear)' })"
if (-not $NoLaunch -and -not $daemonAfter -and -not $KeepDaemon) {
  throw 'The session daemon did not come back up — check the daemon log.'
}
