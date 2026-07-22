[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\MixdogAcceptance'),
  [string]$ProjectPath
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
  $ProjectPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
}
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
$desktopDir = (Get-Location).Path
$distDir = Join-Path $desktopDir 'dist'
$artifact = Join-Path $distDir 'mixdog-desktop-win-x64.exe'
$temporaryLog = Join-Path $distDir "acceptance-running-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')).log"
$steps = [Collections.Generic.List[object]]::new()
$acceptanceStarted = [DateTime]::UtcNow
$userDataPath = Join-Path $env:USERPROFILE '.mixdog'
$userDataExistedBefore = Test-Path -LiteralPath $userDataPath
$legacyKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\5343bdcc-87a7-52f8-80e7-87b62e476a38'
$legacyPaths = @(
  'C:\Program Files\Mixdog',
  $legacyKey,
  'C:\Users\Public\Desktop\Mixdog.lnk',
  'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Mixdog.lnk'
)
$legacyBefore = @($legacyPaths | ForEach-Object { [bool](Test-Path -LiteralPath $_) })

New-Item -ItemType Directory -Path $distDir -Force | Out-Null
Start-Transcript -Path $temporaryLog -Force | Out-Null

function Invoke-AcceptanceStep {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Command,
    [Parameter(Mandatory)][scriptblock]$Action
  )
  Write-Host "COMMAND[$Name]=$Command"
  $watch = [Diagnostics.Stopwatch]::StartNew()
  try {
    $result = & $Action
    $watch.Stop()
    $record = [ordered]@{
      name = $Name
      command = $Command
      seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
      outcome = 'passed'
      result = $result
    }
    $steps.Add([pscustomobject]$record)
    Write-Host "STEP[$Name]=passed; SECONDS=$($record.seconds)"
    return $result
  } catch {
    $watch.Stop()
    $steps.Add([pscustomobject][ordered]@{
      name = $Name
      command = $Command
      seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
      outcome = 'failed'
      error = $_.Exception.Message
    })
    Write-Host "STEP[$Name]=failed; SECONDS=$([Math]::Round($watch.Elapsed.TotalSeconds, 3)); ERROR=$($_.Exception.Message)"
    throw
  }
}

function Invoke-CheckedNative {
  param([string]$File, [string[]]$Arguments, [string]$LogPath)
  $output = & $File @Arguments 2>&1
  $output | ForEach-Object { Write-Host $_ }
  if ($LogPath) { $output | Set-Content -LiteralPath $LogPath -Encoding UTF8 }
  if ($LASTEXITCODE -ne 0) { throw "$File exited with $LASTEXITCODE" }
}

function Get-Sha256 {
  param([Parameter(Mandatory)][string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Invoke-OptionalWindowEvidence {
  param([int]$TimeoutSeconds = 15)
  $electron = Join-Path $desktopDir 'node_modules\electron\dist\electron.exe'
  $png = Join-Path $distDir 'acceptance-window.png'
  $captureId = [Guid]::NewGuid().ToString()
  $process = Start-Process -FilePath $electron -ArgumentList @(
    (Join-Path $desktopDir 'out\main\capture-window.js'), $png, $captureId
  ) -PassThru
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Optional window evidence exceeded its ${TimeoutSeconds}s timeout."
  }
  if ($process.ExitCode -ne 0) { throw "Optional window evidence exited with $($process.ExitCode)." }
  return [ordered]@{ png = $png; json = (Join-Path $distDir 'acceptance-window.json') }
}

try {
  $environment = [ordered]@{
    timestampUtc = $acceptanceStarted.ToString('o')
    computerName = $env:COMPUTERNAME
    userName = $env:USERNAME
    os = [Environment]::OSVersion.VersionString
    architecture = $env:PROCESSOR_ARCHITECTURE
    powershell = $PSVersionTable.PSVersion.ToString()
    node = (& node.exe --version)
    npm = (& npm.cmd --version)
    electronBuilder = (& npx.cmd electron-builder --version)
    desktopDir = $desktopDir
    projectPath = $ProjectPath
    installDir = $InstallDir
  }

  if (-not $SkipBuild) {
    Invoke-AcceptanceStep 'renderer-regression' 'npm run verify:renderer' {
      Invoke-CheckedNative -File 'npm.cmd' -Arguments @('run', 'verify:renderer')
      return 'renderer tests, DOM verification, and strict renderer typecheck passed'
    } | Out-Null
    Invoke-AcceptanceStep 'staging' 'npm run prepare:runtime' {
      Invoke-CheckedNative -File 'npm.cmd' -Arguments @('run', 'prepare:runtime')
      $native = @(Get-ChildItem '.runtime\runtime.asar.unpacked' -Recurse -File)
      return [ordered]@{ nativeFiles = $native.Count; nativeBytes = ($native | Measure-Object Length -Sum).Sum }
    } | Out-Null
    Invoke-AcceptanceStep 'integrated-build' 'npm run build' {
      Invoke-CheckedNative -File 'npm.cmd' -Arguments @('run', 'build')
      return 'node/web typechecks and Electron main/preload/renderer build passed'
    } | Out-Null
    Invoke-AcceptanceStep 'branding-assets' 'npm run brand:win' {
      Invoke-CheckedNative -File 'npm.cmd' -Arguments @('run', 'brand:win')
      return 'Mixdog PNG and ICO assets generated and validated'
    } | Out-Null
    Invoke-AcceptanceStep 'installer-build' 'npx electron-builder --win --x64' {
      Invoke-CheckedNative -File 'npx.cmd' -Arguments @('electron-builder', '--win', '--x64') `
        -LogPath (Join-Path $distDir 'acceptance-build.log')
      return 'Branded NSIS x64 build passed'
    } | Out-Null
    Invoke-AcceptanceStep 'packaging-tests' 'npm run test:packaging' {
      Invoke-CheckedNative -File 'npm.cmd' -Arguments @('run', 'test:packaging') `
        -LogPath (Join-Path $distDir 'acceptance-packaging-test.log')
      return '10 NSIS/config/acceptance/migration/archive/sidecar tests passed'
    } | Out-Null
  }

  if (-not (Test-Path -LiteralPath $artifact)) { throw "Installer artifact missing: $artifact" }
  $artifactItem = Get-Item -LiteralPath $artifact
  $artifactHash = Get-Sha256 -Path $artifact
  Write-Output "ARTIFACT=$artifact"
  Write-Output "ARTIFACT_BYTES=$($artifactItem.Length)"
  Write-Output "ARTIFACT_SHA256=$artifactHash"

  if (Test-Path -LiteralPath $InstallDir) { throw "Acceptance install directory already exists: $InstallDir" }
  Invoke-AcceptanceStep 'install' "`"$artifact`" /S /currentuser /acceptLegacyMigration /D=$InstallDir" {
    $process = Start-Process -FilePath $artifact -ArgumentList @(
      '/S', '/currentuser', '/acceptLegacyMigration', "/D=$InstallDir"
    ) -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)" }
    $installedNative = @(Get-ChildItem (Join-Path $InstallDir 'resources\runtime.asar.unpacked') -Recurse -File)
    $result = [ordered]@{
      exitCode = $process.ExitCode
      installedFiles = @(Get-ChildItem $InstallDir -Recurse -File).Count
      nativeFiles = $installedNative.Count
      nativeBytes = ($installedNative | Measure-Object Length -Sum).Sum
    }
    $result | ConvertTo-Json | Set-Content (Join-Path $distDir 'acceptance-install.log') -Encoding UTF8
    return $result
  } | Out-Null

  $legacyAfterInstall = @($legacyPaths | ForEach-Object { [bool](Test-Path -LiteralPath $_) })
  for ($i = 0; $i -lt $legacyPaths.Count; $i += 1) {
    if (-not $legacyBefore[$i] -and $legacyAfterInstall[$i]) {
      throw "Installer created legacy all-users residue: $($legacyPaths[$i])"
    }
  }
  if ($userDataExistedBefore -and -not (Test-Path -LiteralPath $userDataPath)) {
    throw "$userDataPath was removed during migration."
  }

  $installedExe = Join-Path $InstallDir 'Mixdog.exe'
  Invoke-AcceptanceStep 'native-resolution' 'ELECTRON_RUN_AS_NODE=1 Mixdog.exe --input-type=module -e <sharp PNG probe>' {
    $archive = (Join-Path $InstallDir 'resources\runtime.asar').Replace('\', '/')
    $probeScript = "const sharp=(await import('file:///$archive/node_modules/sharp/lib/index.js')).default; const r=await sharp({create:{width:1,height:1,channels:4,background:'#fff'}}).png().toBuffer({resolveWithObject:true}); console.log(JSON.stringify(r.info));"
    $probeOutput = Join-Path $distDir 'acceptance-native-probe.stdout'
    $probeError = Join-Path $distDir 'acceptance-native-probe.stderr'
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
      $process = Start-Process -FilePath $installedExe -ArgumentList @(
        '--input-type=module', '-e', "`"$probeScript`""
      ) -Wait -PassThru -RedirectStandardOutput $probeOutput -RedirectStandardError $probeError
      if ($process.ExitCode -ne 0) {
        throw "Native resolution exited with $($process.ExitCode): $(Get-Content $probeError -Raw)"
      }
      $result = Get-Content $probeOutput -Raw | ConvertFrom-Json
      $result | ConvertTo-Json | Set-Content (Join-Path $distDir 'acceptance-native-resolution.log') -Encoding UTF8
      return $result
    } finally {
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
  } | Out-Null

  # Base CDP port. A force-killed Electron can leave a ghost LISTEN socket
  # (dead owner PID) that blocks bind() until reboot — probe upward for a
  # port with no listener instead of failing on the fixed one.
  $port = 9337
  while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $port += 1 }
  $debugUserDataDir = Join-Path $distDir 'acceptance-cdp-user-data'
  # A previous failed run can leave the packaged app alive holding the CDP
  # port and the debug user-data single-instance lock; clear it first.
  Get-Process Mixdog -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Remove-Item -LiteralPath $debugUserDataDir -Recurse -Force -ErrorAction SilentlyContinue
  $launchWatch = [Diagnostics.Stopwatch]::StartNew()
  # Redirect the packaged app's console output: a GUI-subsystem Electron child
  # otherwise inherits this console's handles and its updater/main logs bleed
  # into the operator's terminal (over the TUI running in the same window).
  $appProcess = Start-Process -FilePath $installedExe -ArgumentList @(
    "--remote-debugging-port=$port", "--user-data-dir=$debugUserDataDir"
  ) -PassThru -RedirectStandardOutput (Join-Path $distDir 'acceptance-app.stdout') `
    -RedirectStandardError (Join-Path $distDir 'acceptance-app.stderr')
  # Cache the process handle NOW: without it a process that exits before any
  # WaitForExit call reports ExitCode $null (the app-exit step then read
  # "exited with <empty>" and failed a healthy shutdown).
  $null = $appProcess.Handle
  # First launch of a freshly signed build gets a one-time Defender/SmartScreen
  # scan of the 190MB package; allow well past the scan before failing.
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  $target = $null
  do {
    Start-Sleep -Milliseconds 100
    try {
      $targets = (New-Object Net.WebClient).DownloadString("http://127.0.0.1:$port/json/list") |
        ConvertFrom-Json
      $target = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
    } catch {}
  } while (-not $target -and [DateTime]::UtcNow -lt $deadline)
  if (-not $target) {
    $state = if ($appProcess.HasExited) { "exit code $($appProcess.ExitCode)" } else { 'still running' }
    throw "Packaged renderer/preload CDP target did not appear on port $port; app was $state."
  }
  $preloadSeconds = [Math]::Round($launchWatch.Elapsed.TotalSeconds, 3)
  $fullE2e = Invoke-AcceptanceStep 'full-tui-desktop-e2e' "node --import tsx scripts/cdp-e2e.mjs `"$($target.webSocketDebuggerUrl)`" `"$ProjectPath`"" {
    $json = & node --import tsx 'scripts/cdp-e2e.mjs' $target.webSocketDebuggerUrl $ProjectPath
    if ($LASTEXITCODE -ne 0) { throw "Full TUI desktop E2E exited with $LASTEXITCODE" }
    $value = $json | ConvertFrom-Json
    if (
      $value.mode -ne 'direct-user-environment' -or
      $value.inventory.tuiCommands -ne 30 -or
      $value.inventory.desktopCommands -ne 30 -or
      $value.inventory.settingsItems -ne 19 -or
      $value.inventory.settingsCategories -ne 14 -or
      $value.capabilityFailures.Count -ne 0 -or
      $value.renderer.exceptions.Count -ne 0
    ) {
      throw "Full TUI desktop E2E coverage failed: $json"
    }
    $value | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $distDir 'acceptance-tui-e2e.log') -Encoding UTF8
    return $value
  }
  # Keep the legacy smoke last: it intentionally disposes the EngineHost and
  # clears its state subscribers as part of shutdown verification.
  $smoke = Invoke-AcceptanceStep 'project-chat-approval-routing' "node scripts/cdp-smoke.mjs `"$($target.webSocketDebuggerUrl)`" `"$ProjectPath`"" {
    $json = & node 'scripts/cdp-smoke.mjs' $target.webSocketDebuggerUrl $ProjectPath
    if ($LASTEXITCODE -ne 0) { throw "CDP smoke exited with $LASTEXITCODE" }
    $value = $json | ConvertFrom-Json
    if (
      -not $value.bridge -or
      -not $value.projectStarted -or
      -not $value.chatSubmitted -or
      -not $value.snapshotAvailable -or
      -not $value.chrome.titlebar -or
      -not $value.chrome.windowTitle -or
      -not $value.chrome.sidebarToggle -or
      -not $value.chrome.newTask
    ) {
      throw "Packaged bridge/runtime smoke failed: $json"
    }
    $value | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $distDir 'acceptance-launch-smoke.log') -Encoding UTF8
    return $value
  }
  $exitResult = Invoke-AcceptanceStep 'app-exit' 'CloseMainWindow; wait up to 15 seconds' {
    if (-not $appProcess.HasExited) {
      [void]$appProcess.CloseMainWindow()
      if (-not $appProcess.WaitForExit(15000)) { throw 'Packaged app did not exit cleanly.' }
    }
    if ($appProcess.ExitCode -ne 0) { throw "Packaged app exited with $($appProcess.ExitCode)" }
    return [ordered]@{ exitCode = $appProcess.ExitCode }
  }

  Invoke-AcceptanceStep 'uninstall' "`"$InstallDir\Uninstall Mixdog.exe`" /S" {
    $uninstaller = Join-Path $InstallDir 'Uninstall Mixdog.exe'
    $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Uninstaller exited with $($process.ExitCode)" }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ((Test-Path -LiteralPath $InstallDir) -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 100
    }
    if (Test-Path -LiteralPath $InstallDir) { throw "Residual install directory remains: $InstallDir" }
    $result = [ordered]@{ exitCode = $process.ExitCode; residualInstallDirectory = $false }
    $result | ConvertTo-Json | Set-Content (Join-Path $distDir 'acceptance-uninstall.log') -Encoding UTF8
    return $result
  } | Out-Null

  # This evidence is optional and deliberately last: it cannot delay the
  # installer build, installation, packaged bridge/runtime smoke, or uninstall.
  $windowWatch = [Diagnostics.Stopwatch]::StartNew()
  try {
    $windowResult = Invoke-OptionalWindowEvidence -TimeoutSeconds 15
    $windowWatch.Stop()
    $steps.Add([pscustomobject][ordered]@{
      name = 'window-evidence'; command = 'electron capture-window.js (15 second timeout)'
      seconds = [Math]::Round($windowWatch.Elapsed.TotalSeconds, 3)
      outcome = 'passed'; result = $windowResult
    })
  } catch {
    $windowWatch.Stop()
    $steps.Add([pscustomobject][ordered]@{
      name = 'window-evidence'; command = 'electron capture-window.js (15 second timeout)'
      seconds = [Math]::Round($windowWatch.Elapsed.TotalSeconds, 3)
      outcome = 'optional-timeout'; error = $_.Exception.Message
    })
    Write-Warning $_.Exception.Message
  }

  $report = [ordered]@{
    schema = 1
    accepted = $true
    startedUtc = $acceptanceStarted.ToString('o')
    completedUtc = [DateTime]::UtcNow.ToString('o')
    environment = $environment
    artifact = [ordered]@{
      path = $artifactItem.FullName
      bytes = $artifactItem.Length
      sha256 = $artifactHash
    }
    legacy = [ordered]@{
      paths = $legacyPaths
      existedBefore = $legacyBefore
      remainsAfterInstall = $legacyAfterInstall
      userDataPath = $userDataPath
      userDataExistedBefore = $userDataExistedBefore
      userDataExistsAfter = (Test-Path -LiteralPath $userDataPath)
    }
    preloadSeconds = $preloadSeconds
    steps = $steps
    zeroResidualInstallDirectory = -not (Test-Path -LiteralPath $InstallDir)
  }
  $prefix = $artifactHash.Substring(0, 16).ToLowerInvariant()
  $reportPath = Join-Path $distDir "acceptance-$prefix.json"
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-Output "ACCEPTANCE_REPORT=$reportPath"
  Write-Output 'ACCEPTED=true'
} finally {
  if (Get-Variable appProcess -ErrorAction SilentlyContinue) {
    if ($appProcess -and -not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue }
  }
  if (Get-Variable debugUserDataDir -ErrorAction SilentlyContinue) {
    Remove-Item -LiteralPath $debugUserDataDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $InstallDir) {
    $cleanupUninstaller = Join-Path $InstallDir 'Uninstall Mixdog.exe'
    if (Test-Path -LiteralPath $cleanupUninstaller) {
      try {
        $cleanup = Start-Process -FilePath $cleanupUninstaller -ArgumentList '/S' -Wait -PassThru
        if ($cleanup.ExitCode -eq 0) {
          $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(15)
          while ((Test-Path -LiteralPath $InstallDir) -and [DateTime]::UtcNow -lt $cleanupDeadline) {
            Start-Sleep -Milliseconds 100
          }
        }
      } catch {
        Write-Warning "Acceptance cleanup uninstall failed: $($_.Exception.Message)"
      }
    }
  }
  Stop-Transcript | Out-Null
  if (Get-Variable artifactHash -ErrorAction SilentlyContinue) {
    $finalLog = Join-Path $distDir "acceptance-$($artifactHash.Substring(0, 16).ToLowerInvariant()).log"
    Move-Item -LiteralPath $temporaryLog -Destination $finalLog -Force
  }
}
