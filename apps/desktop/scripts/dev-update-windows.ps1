<#
  Dev update loop for the INSTALLED desktop build.

  Production updates are electron-updater over the GitHub feed and only run in a
  packaged app, so a change in this working tree could never be pushed through
  the real update path locally. This script closes that gap in two modes:

    (default)     build -> stop app -> stop core -> silent reinstall
                  -> relaunch. The core stop is the point: a dev rebuild keeps
                  the same version, so a fresh install would otherwise attach
                  to the still-running old core. The stop is
                  `mixdogd ctl stop --when-idle --reason fastDeploy`: it waits
                  for the core to be idle and never kills it; -AbortRunning
                  lists the running work and aborts it after a typed ABORT.

    -ViaUpdater   build a version-bumped artifact, serve dist over 127.0.0.1 and
                  let the app's own updater (check -> download -> ready ->
                  install -> relaunch) perform the swap. Same code the release
                  build runs, pointed at this working tree.

    -FastDirect   fingerprint build inputs, rebuild only changed targets, then
                  atomically swap only affected installed artifacts: the
                  app shell (app.asar), the core (resources\core\mixdogd.exe)
                  and the package root the core reads
                  (resources\runtime.asar.unpacked\node_modules\mixdog).
                  Native, dependency or packaging changes, and any install
                  this script did not deploy last (a Node-core install
                  included), fall back to win-unpacked.

  The core is built with cargo (`cargo build --release -p mixdog-cli`, in the
  checkout that holds native\core) and staged by `stage-core.mjs --binary`;
  a local deploy ships no server-cores (the SSH install needs the release
  build's other platforms).

  -DryRun prints the resolved plan and current process/daemon state and changes
  nothing — every other mode stops the running app and its session daemon.
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$ViaUpdater,
    [switch]$FastDirect,
    [switch]$FastDirectWorker,
    # -ReuseBuild trusts a just-finished build:fast (out/ is fresh) and skips
    # the second electron-vite pass. -BuildOnly stops after staging so a
    # caller can overlap other work, then rerun with -SkipBuild.
    [switch]$ReuseBuild,
    [switch]$BuildOnly,
    [switch]$NoLaunch,
    [switch]$KeepDaemon,
    # Abort the work a busy core is running, after listing it and a typed
    # ABORT confirmation. Without it a deploy waits for the core to be idle.
    [switch]$AbortRunning,
    # How long the wait for an idle core may last before a core with nothing running is stopped by the confirmed abort.
    [int]$DrainLimitSeconds = 120,
    [switch]$DryRun,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\mixdog-desktop'),
    [string]$Version = '',
    [string]$ReceiptPath = '',
    [string]$FastPlanPath = '',
    [string]$FastStatePath = '',
    [string]$FastArtifactDir = '',
    # The checkout the core is built in; the detached worker (started through WMI, which passes no environment)
    # gets it here.
    [string]$CoreBuildRoot = '',
    # A mixdogd built ahead (see `dev-fast-direct.mjs --action=stamp-core-binary`): used instead of running cargo.
    [string]$CoreBinary = '',
    # Ends right before the detached worker would start and prints what it would do; changes nothing.
    [switch]$StopBeforeSwap,
    # A script the detached worker runs with nothing of the install running, right before a full replacement:
    # `-CoreExe <the staged mixdogd>` (a failure ends the deploy, the old app is started again), and `-Undo` when the
    # replacement fails after it ran. The switch from a 1.4.5 install uses it for the last backup and the data
    # conversion, so the new app starts on converted data and a failed swap leaves 1.4.5 its own data.
    [string]$BeforeSwapScript = '',
    [int]$FeedPort = 9357
)

$ErrorActionPreference = 'Stop'
trap {
    # Windows PowerShell can return exit 0 for an uncaught terminating error in
    # a -File script. FastDirect callers must never report a failed build/swap as
    # success, especially when the detached worker was never launched.
    if ($FastDirect -and -not [string]::IsNullOrWhiteSpace($ReceiptPath)) {
        try { Write-FastDirectReceipt -Status 'failed' -Detail $_.Exception.Message } catch {}
    }
    [Console]::Error.WriteLine(($_ | Out-String))
    exit 1
}
$desktopDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $desktopDir '..\..')).Path
$distDir = Join-Path $desktopDir 'dist'
$installer = Join-Path $distDir 'mixdog-desktop-win-x64.exe'
$unpackedDir = Join-Path $distDir 'win-unpacked'
$installedExe = Join-Path $InstallDir 'Mixdog.exe'
$runtimeRoot = if ($env:MIXDOG_RUNTIME_ROOT) { $env:MIXDOG_RUNTIME_ROOT } else { Join-Path $env:TEMP 'mixdog' }
$daemonDiscovery = Join-Path $runtimeRoot 'daemon.json'
# The installed core (electron-builder.yml extraResources): the binary that
# stops the running core through its control listener.
$coreExe = Join-Path $InstallDir 'resources\core\mixdogd.exe'
$fastDirectHelper = Join-Path $PSScriptRoot 'dev-fast-direct.mjs'
$fastRendererWatchHelper = Join-Path $PSScriptRoot 'dev-renderer-watch.mjs'
$fastRendererWatchState = Join-Path $desktopDir '.cache\dev-renderer-watch.json'
$fastRendererWatchLog = Join-Path $desktopDir '.cache\dev-renderer-watch.log'
$fastRendererWatchErrorLog = Join-Path $desktopDir '.cache\dev-renderer-watch.error.log'
if ([string]::IsNullOrWhiteSpace($FastPlanPath)) {
    $FastPlanPath = Join-Path $desktopDir '.cache\dev-fast-direct-plan.json'
}
if ([string]::IsNullOrWhiteSpace($FastStatePath)) {
    $FastStatePath = Join-Path $desktopDir '.cache\dev-fast-direct-state.json'
}
if ([string]::IsNullOrWhiteSpace($FastArtifactDir)) {
    $FastArtifactDir = Join-Path $desktopDir '.cache\dev-fast-direct-artifact'
}
if ($FastDirect -and -not $FastDirectWorker -and [string]::IsNullOrWhiteSpace($ReceiptPath)) {
    $ReceiptPath = Join-Path $env:USERPROFILE '.mixdog\data\dev-fast-deploy.json'
}

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }

function Assert-DesktopCoreArtifact {
    param([string]$ArtifactRoot)
    # What the app starts (local-core.ts) and what the core reads (core-layout.mjs).
    foreach ($relative in @(
            'resources\core\mixdogd.exe',
            'resources\core\js-runtime.json',
            'resources\runtime.asar.unpacked\node_modules\mixdog\package.json',
            'resources\runtime.asar.unpacked\node_modules\mixdog\src\ext-host\worker.mjs'
        )) {
        $artifact = Join-Path $ArtifactRoot $relative
        if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
            throw "Desktop artifact is missing $relative : $artifact"
        }
    }
    & node $fastDirectHelper --action=assert-prod-deps "--install-dir=$ArtifactRoot"
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop artifact app.asar is missing production dependencies: $(Join-Path $ArtifactRoot 'resources\app.asar')"
    }
}

function Write-FastDirectReceipt {
    param(
        [string]$Status,
        [string]$Detail = ''
    )
    if ([string]::IsNullOrWhiteSpace($ReceiptPath)) { return }
    $parent = Split-Path -Parent $ReceiptPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporary = "$ReceiptPath.$PID.tmp"
    $previous = $null
    if (Test-Path -LiteralPath $ReceiptPath -PathType Leaf) {
        try { $previous = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json } catch {}
    }
    $now = [DateTime]::UtcNow
    $startedAt = if ($previous -and $previous.startedAt) {
        [DateTime]::Parse([string]$previous.startedAt).ToUniversalTime()
    }
    elseif ($env:MIXDOG_FASTDIRECT_STARTED_AT) {
        [DateTime]::Parse([string]$env:MIXDOG_FASTDIRECT_STARTED_AT).ToUniversalTime()
    }
    else {
        $now
    }
    $timeline = @()
    if ($previous -and $previous.timeline) { $timeline += @($previous.timeline) }
    $timeline += [ordered]@{ status = $Status; at = $now.ToString('o'); pid = $PID }
    $snapshotTimings = $null
    if ($env:MIXDOG_FASTDIRECT_SNAPSHOT_TIMINGS) {
        try { $snapshotTimings = $env:MIXDOG_FASTDIRECT_SNAPSHOT_TIMINGS | ConvertFrom-Json } catch {}
    }
    $json = [ordered]@{
        status    = $Status
        detail    = $Detail
        pid       = $PID
        at        = $now.ToString('o')
        startedAt = $startedAt.ToString('o')
        elapsedMs = [math]::Round(($now - $startedAt).TotalMilliseconds)
        snapshot  = $snapshotTimings
        timeline  = $timeline
    } | ConvertTo-Json -Depth 6 -Compress
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $ReceiptPath -Force
}

function ConvertTo-PowerShellLiteral {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

# Both deploy modes hand the swap to the same kind of worker: a hidden pwsh
# re-running THIS script with mode switches. Only the argument tail and the
# wording differ, so the launch itself lives here once.
function Start-DetachedDeployWorker {
    param(
        [string]$ModeName,
        [string]$WorkerLabel,
        [string]$WorkerArguments
    )
    if ([string]::IsNullOrWhiteSpace($ReceiptPath)) {
        throw "$ModeName worker receipt path is required."
    }
    $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $workerCommand = "& $(ConvertTo-PowerShellLiteral $PSCommandPath)$WorkerArguments"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($workerCommand))
    $commandLine = "`"$pwsh`" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $encoded"
    # WMI owns the deployment worker, not Mixdog's shell process tree. Stopping
    # the app/daemon therefore cannot kill the worker before the swap it runs --
    # the installed directory for FastDirect.
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine
    }
    if ([int]$created.ReturnValue -ne 0 -or [int]$created.ProcessId -le 0) {
        throw "Failed to start detached $WorkerLabel worker (WMI return $($created.ReturnValue))."
    }
    Write-FastDirectReceipt -Status 'launched' -Detail "workerPid=$($created.ProcessId)"
    return [int]$created.ProcessId
}

function Start-FastDirectWorker {
    $workerArguments = " -FastDirect -FastDirectWorker -SkipBuild" `
        + " -InstallDir $(ConvertTo-PowerShellLiteral $InstallDir) -Version $(ConvertTo-PowerShellLiteral $targetVersion)" `
        + " -ReceiptPath $(ConvertTo-PowerShellLiteral $ReceiptPath)" `
        + " -FastPlanPath $(ConvertTo-PowerShellLiteral $FastPlanPath)" `
        + " -FastStatePath $(ConvertTo-PowerShellLiteral $FastStatePath)" `
        + " -FastArtifactDir $(ConvertTo-PowerShellLiteral $FastArtifactDir)" `
        + " -CoreBuildRoot $(ConvertTo-PowerShellLiteral $coreBuildRoot)" `
        + $(if ($CoreBinary) { " -CoreBinary $(ConvertTo-PowerShellLiteral $CoreBinary)" } else { '' }) `
        + $(if ($BeforeSwapScript) { " -BeforeSwapScript $(ConvertTo-PowerShellLiteral $BeforeSwapScript)" } else { '' }) `
        + " -DrainLimitSeconds $DrainLimitSeconds" `
        + $(if ($NoLaunch) { ' -NoLaunch' } else { '' })
    return Start-DetachedDeployWorker -ModeName 'FastDirect' -WorkerLabel 'fast deploy' `
        -WorkerArguments $workerArguments
}

# Windows stamps a shortcut's AppUserModelID onto the process it launches and
# every descendant inherits it. That identity — not the parent PID — is what
# Task Manager groups by, so a shortcut launch keeps the app, the daemon, the
# session worker and whisper folded into one Mixdog row. Starting Mixdog.exe
# directly drops it and scatters the node-mode children across the list.
$script:mixdogShortcutResolved = $false
$script:mixdogShortcutPath = ''
function Get-MixdogShortcutPath {
    if ($script:mixdogShortcutResolved) { return $script:mixdogShortcutPath }
    $script:mixdogShortcutResolved = $true
    $candidates = @(
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Mixdog.lnk'),
        (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Mixdog.lnk'),
        (Join-Path $env:PUBLIC 'Desktop\Mixdog.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mixdog.lnk')
    )
    $shell = $null
    try { $shell = New-Object -ComObject WScript.Shell } catch { return '' }
    try {
        $wanted = [System.IO.Path]::GetFullPath($installedExe)
        foreach ($candidate in $candidates) {
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            $target = ''
            try { $target = $shell.CreateShortcut($candidate).TargetPath } catch { continue }
            if ([string]::IsNullOrWhiteSpace($target)) { continue }
            # Only a shortcut pointing at THIS install carries the right identity; a
            # stale one from another install dir would launch the wrong build.
            if ([string]::Equals([System.IO.Path]::GetFullPath($target), $wanted, [StringComparison]::OrdinalIgnoreCase)) {
                $script:mixdogShortcutPath = $candidate
                break
            }
        }
    }
    catch {
        $script:mixdogShortcutPath = ''
    }
    finally {
        if ($shell) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
    }
    return $script:mixdogShortcutPath
}

function Start-InstalledMixdogApp {
    param([string]$Exe = '')
    if ([string]::IsNullOrWhiteSpace($Exe)) { $Exe = $installedExe }
    $shortcut = Get-MixdogShortcutPath
    # No shortcut (fresh dev box, uninstalled Start Menu entry) still has to
    # launch; it only loses the Task Manager grouping.
    if ($shortcut) { Start-Process -FilePath $shortcut | Out-Null }
    else { Start-Process -FilePath $Exe | Out-Null }
}

function Start-DetachedMixdogApp {
    if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) {
        throw "Installed app is missing: $installedExe"
    }
    # Explorer performs the GUI launch outside the deployment worker's console
    # and process tree. Closing that shell can no longer close the new app.
    $launchTarget = Get-MixdogShortcutPath
    if (-not $launchTarget) { $launchTarget = $installedExe }
    Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') `
        -ArgumentList @($launchTarget) | Out-Null
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

function Get-DaemonRecord {
    # The core's discovery file (LR section 4): the pid and the RPC port of a
    # serving core. Its owner is the only writer; this script only reads it.
    if (-not (Test-Path -LiteralPath $daemonDiscovery)) { return $null }
    try {
        $record = Get-Content -LiteralPath $daemonDiscovery -Raw | ConvertFrom-Json
        return [pscustomobject]@{
            pid         = $record.pid
            port        = $record.core.rpc.port
            # A 1.4.5 (Node) daemon publishes its session endpoint here instead.
            legacyPort  = $record.endpoints.session.port
            legacyToken = $record.endpoints.session.token
        }
    }
    catch { return $null }
}

function Get-DaemonProcess {
    $record = Get-DaemonRecord
    if (-not $record -or -not $record.pid) { return @() }
    return @(Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$record.pid)")
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

function Get-CoreRunningWork {
    $status = & $coreExe ctl status --json | ConvertFrom-Json
    return $status
}

# The user's own typed confirmation is the only authorization to abort work
# (LR section 5.4): the listing they see is the one the token is bound to.
function Confirm-AbortRunningWork {
    $status = Get-CoreRunningWork
    if (-not $status.drain -or @($status.running).Count -eq 0) { return }
    Write-Host '    running work that would be aborted:'
    foreach ($work in @($status.running)) { Write-Host "      $($work.kind): $($work.title)" }
    if ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive) {
        throw '-AbortRunning needs an interactive terminal for its confirmation; the core keeps draining and exits when idle.'
    }
    $typed = Read-Host '    type ABORT to stop the work listed above'
    if ($typed -ne 'ABORT') {
        throw 'Abort was not confirmed; the core keeps draining and exits when idle.'
    }
    & $coreExe ctl stop --abort --reason fastDeploy --confirm-token $status.drain.confirmToken --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "mixdogd ctl stop --abort exited with $LASTEXITCODE" }
}

function Invoke-LegacyDaemon {
    param($Record, [string]$Method, [string]$Path, $Body = $null)
    $arguments = @{
        Uri         = "http://127.0.0.1:$($Record.legacyPort)$Path"
        Method      = $Method
        Headers     = @{ 'x-mixdog-daemon-token' = [string]$Record.legacyToken }
        ContentType = 'application/json'
        TimeoutSec  = 30
    }
    if ($null -ne $Body) { $arguments.Body = ($Body | ConvertTo-Json -Compress) }
    return Invoke-RestMethod @arguments
}

# Non-forced /upgrade: the 1.4.5 daemon finishes its running work, then exits. Nothing here times the wait or kills
# it; -AbortRunning (typed ABORT) sends the forced form, as the new core's own wind-down does.
function Stop-LegacyDaemon {
    param($Record)
    $process = Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue
    if (-not $process) { Write-Host '    1.4.5 daemon already gone'; return }
    if (-not $Record.legacyPort -or -not $Record.legacyToken) {
        Write-Host "    daemon pid=$($Record.pid) publishes no session endpoint; it is left to the next core"
        return
    }
    $version = if ($targetVersion) { $targetVersion } else { '1.4.6' }
    $upgrade = @{ protocol = 1; revision = 7; version = $version }
    Invoke-LegacyDaemon $Record 'POST' '/upgrade' $upgrade | Out-Null
    Write-Host "    asked 1.4.5 daemon pid=$($Record.pid) to drain and exit"
    if ($AbortRunning) {
        $typed = Read-Host '    type ABORT to force the 1.4.5 daemon down, aborting its running work'
        if ($typed -ne 'ABORT') { throw 'Abort was not confirmed; the daemon keeps draining and exits when idle.' }
        $upgrade.force = $true
        Invoke-LegacyDaemon $Record 'POST' '/upgrade' $upgrade | Out-Null
    }
    $waited = 0
    while (-not $process.WaitForExit(10000)) {
        $waited += 10
        $health = try { Invoke-LegacyDaemon $Record 'GET' '/health' } catch { $null }
        $busy = if ($health) { $health.busySessions } else { '?' }
        Write-Host "    waiting for the 1.4.5 daemon to become idle ($waited s, busy: $busy)"
        Write-FastDirectReceipt -Status 'waiting-for-idle-core' -Detail "1.4.5 busy: $busy"
        if ($waited -ge $DrainLimitSeconds) {
            # Every session ends in this switch (the user was told): the daemon is ended by its pid, after the pid is
            # checked to be the installed app's executable running a daemon script, so a reused pid is never touched.
            $info = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Record.pid)"
            if (-not $info -or $info.ExecutablePath -ne $installedExe -or $info.CommandLine -notmatch 'daemon\.mjs') {
                throw "pid $($Record.pid) is not the 1.4.5 daemon ($($info.CommandLine)); it was not ended. Check daemon.json, end the daemon yourself, then rerun."
            }
            Write-Host "    the 1.4.5 daemon did not drain within $DrainLimitSeconds s; ending pid $($Record.pid). Work that was running: busy sessions $busy; $($health | ConvertTo-Json -Compress -Depth 3)"
            Stop-Process -Id ([int]$Record.pid) -Force
            if (-not $process.WaitForExit(30000)) {
                throw "The 1.4.5 daemon pid $($Record.pid) is still alive 30 s after it was ended. Run: Stop-Process -Id $($Record.pid) -Force (or taskkill /PID $($Record.pid) /F), then rerun."
            }
            return
        }
    }
}

function Stop-Daemon {
    # The one wind-down procedure (LR section 5): ask the core to stop once it
    # is idle, then wait for its OS process to exit. Nothing here kills the
    # core or times the wait; running work is listed, and only a typed
    # confirmation (-AbortRunning) aborts it.
    $record = Get-DaemonRecord
    if (-not $record -or -not $record.pid) { Write-Host '    no core running'; return }
    if (-not (Test-Path -LiteralPath $coreExe -PathType Leaf)) {
        # A 1.4.5 build has no mixdogd: its daemon is asked to drain through its own /upgrade route, the one call
        # the new core makes too (legacy_owner.rs), before anything force-stops the app's children.
        Stop-LegacyDaemon $record
        return
    }
    # The process handle is the core's identity: the wait ends with that
    # process, never with a later one that reused the pid.
    $process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if (-not $process) { Write-Host '    core process already gone'; return }
    & $coreExe ctl stop --when-idle --reason fastDeploy --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "mixdogd ctl stop exited with $LASTEXITCODE" }
    Write-Host "    asked core pid=$($record.pid) to stop when idle"
    if ($AbortRunning) { Confirm-AbortRunningWork }
    # The idle wait has a limit: a drain was seen staying `draining` for 15+ minutes with no client and no work.
    # At the limit a core with nothing running is stopped by the confirmed abort (`stop --abort` with the drain's
    # token from `ctl status`), which loses nothing; a core that is running work keeps draining (listed) unless
    # -AbortRunning, which asks for the typed ABORT above.
    $waited = 0
    $aborted = $false
    while (-not $process.WaitForExit(10000)) {
        $waited += 10
        if (-not (Get-DaemonRecord) -and $waited -ge 30) {
            # Seen on a profile copy: the drain ended and the core took its discovery file away, but its process
            # stayed. Everything is stored by then; the process ends with the install's other processes.
            Write-Host "    the core (pid $($record.pid)) is drained and unpublished but still alive after $waited s; it is ended with the installed processes"
            return
        }
        $status = Get-CoreRunningWork
        $titles = (@($status.running) | ForEach-Object { $_.title }) -join '; '
        Write-Host "    waiting for the core to become idle ($waited s): $titles"
        Write-FastDirectReceipt -Status 'waiting-for-idle-core' -Detail $titles
        if (-not $aborted -and $waited -ge $DrainLimitSeconds -and $status.drain -and @($status.running).Count -eq 0) {
            Write-Host "    the drain did not end within $DrainLimitSeconds s with nothing running; stopping the core by the confirmed abort"
            & $coreExe ctl stop --abort --reason fastDeploy --confirm-token $status.drain.confirmToken --json | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "mixdogd ctl stop --abort exited with $LASTEXITCODE" }
            $aborted = $true
        }
        if ($aborted -and $waited -ge $DrainLimitSeconds + 120) {
            throw "The core (pid $($record.pid)) is still running 120 s after the confirmed abort. Nothing was killed: end it with `"$coreExe ctl terminate`" (see ctl terminate --help) or by its pid, then rerun."
        }
    }
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
            }
            else {
                Start-InstalledMixdogApp -Exe $RelaunchExe
            }
            $nextRelaunchAt = [DateTime]::UtcNow.AddSeconds(15)
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

# The core is built where cargo's incremental state lives: the checkout, not the frozen snapshot (a fresh
# checkout of the same files has newer mtimes, so cargo would rebuild all 41 crates every deploy).
$coreBuildRoot = if ($CoreBuildRoot) { $CoreBuildRoot } elseif ($env:MIXDOG_FASTDIRECT_SOURCE_ROOT) { $env:MIXDOG_FASTDIRECT_SOURCE_ROOT } else { $repoRoot }

function Get-BuiltCorePath {
    if ($CoreBinary) { return $CoreBinary }
    return Join-Path $coreBuildRoot 'native\core\target\release\mixdogd.exe'
}

function Build-LocalCore {
    if ($CoreBinary) {
        # Built ahead (any cargo target dir); only valid while the sources are the ones it was stamped with.
        Write-Step "using the prebuilt core $CoreBinary"
        # Out-Host: this function's output is its return value (the binary's path).
        & node $fastDirectHelper --action=assert-core-binary "--binary=$CoreBinary" "--source-root=$coreBuildRoot" | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "The prebuilt core does not match the sources." }
        return $CoreBinary
    }
    Write-Step 'building mixdogd (cargo build --release -p mixdog-cli)'
    if ($FastDirect -and $fastPlan) {
        & node $fastDirectHelper --action=assert-core-source "--plan=$FastPlanPath" "--source-root=$coreBuildRoot" | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'FastDirect core sources changed after planning.' }
    }
    & cargo build --release --locked -p mixdog-cli --manifest-path (Join-Path $coreBuildRoot 'native\core\Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw "cargo build exited with $LASTEXITCODE" }
    if ($FastDirect -and $fastPlan) {
        & node $fastDirectHelper --action=assert-core-source "--plan=$FastPlanPath" "--source-root=$coreBuildRoot" | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'FastDirect core sources changed while building.' }
    }
    $built = Join-Path $coreBuildRoot 'native\core\target\release\mixdogd.exe'
    if (-not (Test-Path -LiteralPath $built -PathType Leaf)) { throw "cargo did not produce $built" }
    return $built
}

# prepare:runtime recreates .runtime from nothing, so the core is staged after it, never before.
function Install-LocalCoreIntoRuntime {
    param([string]$Binary)
    & node (Join-Path $PSScriptRoot 'stage-core.mjs') "--binary=$Binary" --platform=win32 --arch=x64
    if ($LASTEXITCODE -ne 0) { throw "stage-core exited with $LASTEXITCODE" }
}

function Invoke-Build {
    param(
        [string]$OverrideVersion,
        [switch]$DirectoryOnly,
        [object]$Plan = $null
    )
    Push-Location $desktopDir
    try {
        if ($DirectoryOnly) {
            # Fast local deployment still includes every current Desktop/runtime
            # source file, but intentionally omits the release-only typecheck and
            # NSIS compression stages.
            Invoke-FastDirectChangedOutputs $Plan
            & npm.cmd run brand:win
            if ($LASTEXITCODE -ne 0) { throw "brand:win exited with $LASTEXITCODE" }
            $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
            $builder = Start-Process -FilePath $npx `
                -ArgumentList @('electron-builder', '--dir', '--win', '--x64', '--publish', 'never', "-c.extraMetadata.version=$OverrideVersion") `
                -WorkingDirectory $desktopDir -NoNewWindow -Wait -PassThru
            if ($builder.ExitCode -ne 0) { throw "electron-builder --dir exited with $($builder.ExitCode)" }
            # The same integrity check the release package passes, for this machine's package only (no server bundles).
            & node (Join-Path $PSScriptRoot 'verify-staged-package.mjs') "--resources=$(Join-Path $unpackedDir 'resources')" --platform=win32 --arch=x64 --host-only | Out-Host
            if ($LASTEXITCODE -ne 0) { throw "verify-staged-package exited with $LASTEXITCODE" }
            Assert-DesktopCoreArtifact $unpackedDir
            Write-Step 'complete win-unpacked fallback ready'
            return
        }
        # The steps of build:win, except that the core is the one cargo builds here: build:win stages release
        # builds of every platform, which only CI has.
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "build exited with $LASTEXITCODE" }
        & npm.cmd run prepare:runtime -- --platform=win32 --arch=x64
        if ($LASTEXITCODE -ne 0) { throw "prepare:runtime exited with $LASTEXITCODE" }
        Install-LocalCoreIntoRuntime (Build-LocalCore)
        & npm.cmd run brand:win
        if ($LASTEXITCODE -ne 0) { throw "brand:win exited with $LASTEXITCODE" }
        $builderArguments = @('electron-builder', '--win', '--x64', '--publish', 'never')
        if (-not [string]::IsNullOrWhiteSpace($OverrideVersion)) { $builderArguments += "-c.extraMetadata.version=$OverrideVersion" }
        & npx.cmd @builderArguments
        if ($LASTEXITCODE -ne 0) { throw "electron-builder exited with $LASTEXITCODE" }
        & npm.cmd run verify:update-metadata
        if ($LASTEXITCODE -ne 0) { throw "verify:update-metadata exited with $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
}

function Get-FastDirectPlan {
    param([switch]$ForceFull)
    $output = & node $fastDirectHelper --action=plan "--install-dir=$InstallDir" `
        "--state=$FastStatePath" "--plan=$FastPlanPath" "--force-full=$([bool]$ForceFull)"
    if ($LASTEXITCODE -ne 0) { throw "FastDirect planning exited with $LASTEXITCODE" }
    return ($output | Out-String | ConvertFrom-Json)
}

function Assert-FastDirectPlanCurrent {
    & node $fastDirectHelper --action=assert-current "--install-dir=$InstallDir" `
        "--plan=$FastPlanPath"
    if ($LASTEXITCODE -ne 0) {
        throw 'FastDirect inputs changed after planning/build; rerun the deploy before installing artifacts.'
    }
}

function Test-FastDirectNoOp {
    param([object]$Plan)
    return (
        -not [bool]$Plan.full -and
        @($Plan.targets).Count -eq 0 -and
        -not [bool]$Plan.core -and
        -not [bool]$Plan.runtime
    )
}

function Complete-FastDirectNoOp {
    # `exit` inside a function ends the whole script, not just this function.
    Write-Host 'FastDirect inputs are unchanged; nothing to build, stop, or restart.' -ForegroundColor Green
    Write-FastDirectReceipt -Status 'completed' -Detail 'no changes'
    exit 0
}

function Get-FastRendererWatchState {
    if (-not (Test-Path -LiteralPath $fastRendererWatchState -PathType Leaf)) { return $null }
    try {
        return Get-Content -LiteralPath $fastRendererWatchState -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Get-FastRendererWatchProcess {
    $state = Get-FastRendererWatchState
    if ($null -eq $state -or -not $state.pid) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$state.pid)" `
        -ErrorAction SilentlyContinue
    if ($null -eq $process -or $process.CommandLine -notlike '*dev-renderer-watch.mjs*') {
        return $null
    }
    return $process
}

function Stop-FastRendererWatch {
    $process = Get-FastRendererWatchProcess
    if ($process) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        try { Wait-Process -Id $process.ProcessId -Timeout 5 -ErrorAction SilentlyContinue } catch {}
    }
    Remove-Item -LiteralPath $fastRendererWatchState -Force -ErrorAction SilentlyContinue
}

function Start-FastRendererWatch {
    $cacheDir = Split-Path -Parent $fastRendererWatchState
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    Remove-Item -LiteralPath $fastRendererWatchState, $fastRendererWatchLog, `
        $fastRendererWatchErrorLog -Force -ErrorAction SilentlyContinue
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $process = Start-Process -FilePath $node `
        -ArgumentList @($fastRendererWatchHelper, "--state=$fastRendererWatchState") `
        -WorkingDirectory $desktopDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $fastRendererWatchLog `
        -RedirectStandardError $fastRendererWatchErrorLog
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) {
        $detail = if (Test-Path -LiteralPath $fastRendererWatchErrorLog) {
            Get-Content -LiteralPath $fastRendererWatchErrorLog -Raw
        }
        else { 'no watcher error output' }
        throw "renderer watcher exited during startup: $detail"
    }
}

function Test-FastRendererOutputFresh {
    param([object]$Plan)
    $output = Join-Path $desktopDir 'out\renderer\index.html'
    if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { return $false }
    $outputMtimeMs = ([DateTimeOffset](Get-Item -LiteralPath $output).LastWriteTimeUtc).ToUnixTimeMilliseconds()
    $requiredMtimeMs = [Math]::Max(
        [double]$Plan.groups.renderer.newestMtimeMs,
        [double]$Plan.groups.package.newestMtimeMs
    )
    return $outputMtimeMs -ge $requiredMtimeMs
}

function Complete-FastRendererWatchBuild {
    param([object]$Plan)
    try {
        $state = Get-FastRendererWatchState
        $process = Get-FastRendererWatchProcess
        $configMtimeMs = ([DateTimeOffset](Get-Item -LiteralPath `
                (Join-Path $desktopDir 'electron.vite.config.ts')).LastWriteTimeUtc).ToUnixTimeMilliseconds()
        if ($process -and ([double]$state.configMtimeMs + 1) -lt $configMtimeMs) {
            Write-Step 'restarting renderer watch cache for changed build config'
            Stop-FastRendererWatch
            $process = $null
        }
        if (-not $process) {
            Write-Step 'starting persistent production renderer build cache'
            Start-FastRendererWatch
        }
        else {
            Write-Step 'waiting for persistent renderer rebuild'
        }

        $deadline = [DateTime]::UtcNow.AddSeconds(90)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-FastRendererOutputFresh $Plan) {
                Write-Step 'reusing warm renderer build'
                return Get-FastDirectPlan
            }
            $state = Get-FastRendererWatchState
            if ($state -and $state.status -eq 'error') {
                throw "renderer watcher failed: $($state.detail)"
            }
            if (-not (Get-FastRendererWatchProcess)) {
                throw 'renderer watcher stopped before producing a fresh build'
            }
            Start-Sleep -Milliseconds 200
        }
        throw 'renderer watcher did not produce a fresh build within 90 seconds'
    }
    catch {
        Write-Warning "$($_.Exception.Message); falling back to a one-shot renderer build"
        Stop-FastRendererWatch
        return $Plan
    }
}

function Invoke-SelectedElectronBuild {
    param([string[]]$Targets)
    if (@($Targets).Count -eq 0) { return }
    Push-Location $desktopDir
    try {
        $previousTargets = $env:MIXDOG_ELECTRON_BUILD_TARGETS
        $env:MIXDOG_ELECTRON_BUILD_TARGETS = $Targets -join ','
        & npx.cmd electron-vite build
        if ($LASTEXITCODE -ne 0) { throw "electron-vite incremental build exited with $LASTEXITCODE" }
    }
    finally {
        if ($null -eq $previousTargets) {
            Remove-Item Env:MIXDOG_ELECTRON_BUILD_TARGETS -ErrorAction SilentlyContinue
        }
        else {
            $env:MIXDOG_ELECTRON_BUILD_TARGETS = $previousTargets
        }
        Pop-Location
    }
}

function Invoke-FastDirectChangedOutputs {
    param([object]$Plan)
    if ($null -eq $Plan) { throw 'FastDirect build plan is required.' }
    $targets = if ($Plan.full) {
        @('main', 'preload', 'renderer')
    }
    else {
        @($Plan.targets)
    }
    # Freshness is a claim about SOURCES, and a target whose output is not on
    # disk cannot be fresh no matter what the plan says. A snapshot deploy
    # builds in a throwaway worktree that starts with no `out/`, so a
    # renderer-only plan staged an asar without out/main/index.js and the install
    # failed on the missing entry point.
    $targetArtifacts = [ordered]@{
        main     = 'out\main\index.js'
        preload  = 'out\preload\index.js'
        renderer = 'out\renderer\index.html'
    }
    $missingTargets = @($targetArtifacts.Keys | Where-Object {
            -not (Test-Path -LiteralPath (Join-Path $desktopDir $targetArtifacts[$_]) -PathType Leaf)
        })
    if ($missingTargets.Count -gt 0) {
        Write-Step "missing build output for: $($missingTargets -join ', ')"
        $targets = @($targetArtifacts.Keys | Where-Object { $_ -in $targets -or $_ -in $missingTargets })
    }
    $reusedTargets = @($targets | Where-Object {
            ($ReuseBuild -or [bool]$Plan.prebuilt.$_) -and $_ -notin $missingTargets
        })
    $buildTargets = @($targets | Where-Object { $_ -notin $reusedTargets })
    if ($reusedTargets.Count -gt 0) {
        Write-Step "reusing fresh Electron target(s): $($reusedTargets -join ', ')"
    }
    if ($buildTargets.Count -gt 0) {
        Write-Step "building changed Electron target(s): $($buildTargets -join ', ')"
        Invoke-SelectedElectronBuild $buildTargets
    }

    # A complete deploy prepares the whole runtime and stages the core into it
    # (prepare:runtime recreates .runtime, so the core goes in after it).
    if ($Plan.full) {
        Push-Location $desktopDir
        try {
            Write-Step 'preparing production runtime.asar for the complete fallback'
            & npm.cmd run prepare:runtime -- --platform=win32 --arch=x64
            if ($LASTEXITCODE -ne 0) { throw "prepare:runtime exited with $LASTEXITCODE" }
        }
        finally {
            Pop-Location
        }
        Install-LocalCoreIntoRuntime (Build-LocalCore)
        return
    }
    if ([bool]$Plan.core) {
        Build-LocalCore | Out-Null
    }
    if ([bool]$Plan.runtime) {
        Push-Location $desktopDir
        try {
            Write-Step 'preparing the changed runtime package'
            # Through npm like prepare:runtime: the script packs via npm_execpath.
            & npm.cmd run prepare:fast-runtime-code -- `
                "--dependency-hash=$($Plan.groups.runtimeDependencies.hash)" `
                "--runtime-hash=$($Plan.groups.runtime.hash)"
            if ($LASTEXITCODE -ne 0) { throw "prepare-fast-runtime-code exited with $LASTEXITCODE" }
        }
        finally {
            Pop-Location
        }
    }
}

function Invoke-FastDirectIncrementalBuild {
    param([object]$Plan)
    Invoke-FastDirectChangedOutputs $Plan
    Assert-FastDirectPlanCurrent
    $targets = @($Plan.targets)
    if ($targets.Count -gt 0) {
        Write-Step 'staging incremental app.asar'
        & node $fastDirectHelper --action=stage-shell "--install-dir=$InstallDir" `
            "--plan=$FastPlanPath" "--artifact=$FastArtifactDir"
        if ($LASTEXITCODE -ne 0) { throw "FastDirect shell staging exited with $LASTEXITCODE" }
    }
}

function Install-UnpackedBuild {
    if (-not (Test-Path -LiteralPath (Join-Path $unpackedDir 'Mixdog.exe') -PathType Leaf)) {
        throw "Unpacked desktop artifact missing: $unpackedDir"
    }
    Assert-DesktopCoreArtifact $unpackedDir
    $installParent = Split-Path -Parent $InstallDir
    $installLeaf = Split-Path -Leaf $InstallDir
    $backupDir = Join-Path $installParent ".$installLeaf.fast-backup-$PID"
    if (Test-Path -LiteralPath $backupDir) {
        throw "Fast deploy backup path already exists: $backupDir"
    }
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
    $replaced = [System.Collections.Generic.List[object]]::new()
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
            }
            catch {
                if ([DateTime]::UtcNow -ge $deadline) {
                    throw "$Stage failed: $($_.Exception.Message)"
                }
                Start-Sleep -Milliseconds 250
            }
        } while ($true)
    }
    $beforeSwapRan = $false
    $shell = (Get-Command pwsh.exe -ErrorAction Stop).Source
    try {
        if ($BeforeSwapScript) {
            Write-Step "running $BeforeSwapScript"
            Write-FastDirectReceipt -Status 'before-swap' -Detail $BeforeSwapScript
            $beforeSwapRan = $true
            & $shell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $BeforeSwapScript `
                -CoreExe (Join-Path $unpackedDir 'resources\core\mixdogd.exe')
            if ($LASTEXITCODE -ne 0) { throw "$BeforeSwapScript exited with $LASTEXITCODE" }
        }
        New-Item -ItemType Directory -Path $backupDir -ErrorAction Stop | Out-Null
        # Every entry the build produced is app-owned: an Electron upgrade also
        # changes the Chromium files beside Mixdog.exe, and a new executable
        # beside the previous version's V8 snapshot dies at startup. Leaving the
        # installation directory itself in place avoids locks on debug.log and
        # preserves the registered uninstaller and shortcuts.
        foreach ($entry in @(Get-ChildItem -LiteralPath $unpackedDir -Force)) {
            $installed = Join-Path $InstallDir $entry.Name
            $backup = Join-Path $backupDir $entry.Name
            $hadInstalled = Test-Path -LiteralPath $installed
            if ($hadInstalled) { Move-WithRetry $installed $backup "backup $($entry.Name)" }
            $replaced.Add([pscustomobject]@{ Installed = $installed; Backup = $backup; HadInstalled = $hadInstalled })
            Move-WithRetry $entry.FullName $installed "install $($entry.Name)"
        }
        if (-not $NoLaunch) {
            Write-Step 'starting the fast-deployed app'
            Start-DetachedMixdogApp
            $fresh = Wait-ForFreshDaemon -Previous $daemonBefore -RelaunchExe $installedExe -DetachedRelaunch
            if (-not $fresh) { throw 'Fast-deployed Mixdog did not publish a fresh daemon.' }
            # A first start reads the whole converted profile before the window is composed.
            if (-not (Wait-ForVisibleAppWindow -TimeoutSeconds 180)) {
                throw 'Fast-deployed Mixdog did not open a visible application window.'
            }
            $script:daemonAfter = $fresh
        }
        Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction Stop
    }
    catch {
        $failure = $_
        if ($replaced.Count) {
            Write-Step 'fast deploy failed; restoring the previous installation'
            Stop-MixdogApp
            Stop-Daemon
            Stop-InstalledMixdogProcess
            foreach ($item in $replaced) {
                Remove-Item -LiteralPath $item.Installed -Recurse -Force -ErrorAction SilentlyContinue
                if ($item.HadInstalled -and (Test-Path -LiteralPath $item.Backup)) {
                    Move-WithRetry $item.Backup $item.Installed "restore $(Split-Path -Leaf $item.Installed)"
                }
            }
        }
        if ($beforeSwapRan) {
            # The old app must not start on what the script changed: it is undone first, and an undo that fails
            # leaves the app closed (the message names what to run).
            Write-Step "undoing $BeforeSwapScript"
            & $shell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $BeforeSwapScript -Undo
            if ($LASTEXITCODE -ne 0) {
                throw "The deploy failed ($($failure.Exception.Message)) and `"$BeforeSwapScript -Undo`" exited with $($LASTEXITCODE): the app was not started. Run that undo, then start Mixdog."
            }
        }
        Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
        if (-not $NoLaunch -and (Test-Path -LiteralPath $installedExe -PathType Leaf)) {
            Start-DetachedMixdogApp
        }
        throw $failure
    }
}

function Install-IncrementalBuild {
    param([object]$Plan)
    $shellChanged = @($Plan.targets).Count -gt 0
    $runtimeChanged = [bool]$Plan.runtime
    $coreChanged = [bool]$Plan.core
    # The core reads the package root at start and holds mixdogd.exe open, so either change restarts it.
    $coreRestartRequired = $runtimeChanged -or $coreChanged
    $appRestartRequired = $shellChanged -or $coreRestartRequired
    $installedResources = Join-Path $InstallDir 'resources'
    $backupDir = Join-Path $env:TEMP ("mixdog-fast-incremental-backup-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $backedUp = [Collections.Generic.List[object]]::new()
    function Backup-InstalledArtifact {
        param([string]$Path, [string]$Name)
        $backup = $null
        if (Test-Path -LiteralPath $Path) {
            $backup = Join-Path $backupDir $Name
            Move-Item -LiteralPath $Path -Destination $backup -Force
        }
        [void]$backedUp.Add([pscustomobject]@{ Path = $Path; Backup = $backup })
    }
    function Restore-IncrementalArtifacts {
        foreach ($entry in @($backedUp)) {
            Remove-Item -LiteralPath $entry.Path -Recurse -Force -ErrorAction SilentlyContinue
            if ($entry.Backup -and (Test-Path -LiteralPath $entry.Backup)) {
                Move-Item -LiteralPath $entry.Backup -Destination $entry.Path -Force
            }
        }
    }
    function Install-PreparedArtifact {
        param([string]$Source, [string]$Destination)
        if (Test-Path -LiteralPath $Destination) {
            throw "Prepared artifact destination already exists: $Destination"
        }
        $sourceRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Source))
        $destinationRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Destination))
        if ([string]::Equals($sourceRoot, $destinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
            Move-Item -LiteralPath $Source -Destination $Destination
        }
        else {
            Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
        }
    }

    try {
        if ($appRestartRequired) {
            Write-Step 'stopping the installed app'
            Stop-MixdogApp
        }
        if ($coreRestartRequired) {
            Write-Step 'stopping the core'
            Stop-Daemon
        }
        if ($appRestartRequired) {
            Write-Step 'waiting for every installed Mixdog process to release files'
            Stop-InstalledMixdogProcess
        }
        if ($shellChanged) {
            Backup-InstalledArtifact (Join-Path $InstallDir 'Mixdog.exe') 'Mixdog.exe'
            Backup-InstalledArtifact (Join-Path $installedResources 'app.asar') 'app.asar'
            Backup-InstalledArtifact (Join-Path $installedResources 'app.asar.unpacked') 'app.asar.unpacked'
            Copy-Item -LiteralPath (Join-Path $FastArtifactDir 'Mixdog.exe') `
                -Destination (Join-Path $InstallDir 'Mixdog.exe') -Force
            Copy-Item -LiteralPath (Join-Path $FastArtifactDir 'resources\app.asar') `
                -Destination (Join-Path $installedResources 'app.asar') -Force
            Copy-Item -LiteralPath (Join-Path $FastArtifactDir 'resources\app.asar.unpacked') `
                -Destination (Join-Path $installedResources 'app.asar.unpacked') -Recurse -Force
        }
        if ($runtimeChanged) {
            # The package root js-runtime.json names: real files beside the core's other modules.
            $runtimeCode = Join-Path $desktopDir '.runtime\fast-runtime-code\node_modules\mixdog'
            $installedPackage = Join-Path $installedResources 'runtime.asar.unpacked\node_modules\mixdog'
            if (-not (Test-Path -LiteralPath (Join-Path $runtimeCode 'src\ext-host\worker.mjs') -PathType Leaf)) {
                throw "Prepared runtime package is missing: $runtimeCode"
            }
            if (-not (Test-Path -LiteralPath $installedPackage -PathType Container)) {
                throw "Installed runtime package is missing: $installedPackage"
            }
            Backup-InstalledArtifact $installedPackage 'runtime-package-mixdog'
            Install-PreparedArtifact $runtimeCode $installedPackage
        }
        if ($coreChanged) {
            $builtCore = Get-BuiltCorePath
            if (-not (Test-Path -LiteralPath $builtCore -PathType Leaf)) { throw "Built core is missing: $builtCore" }
            $installedCore = Join-Path $installedResources 'core\mixdogd.exe'
            Backup-InstalledArtifact $installedCore 'mixdogd.exe'
            Copy-Item -LiteralPath $builtCore -Destination $installedCore
        }

        if (-not $NoLaunch) {
            if ($appRestartRequired -or $appBefore.Count -eq 0) {
                Write-Step 'starting the incrementally deployed app'
                Start-DetachedMixdogApp
            }
            if ($coreRestartRequired) {
                $fresh = Wait-ForFreshDaemon -Previous $daemonBefore -RelaunchExe $installedExe -DetachedRelaunch
                if (-not $fresh) { throw 'Incrementally deployed Mixdog did not publish a fresh core.' }
                $script:daemonAfter = $fresh
            }
            else {
                if (-not (Wait-ForVisibleAppWindow -TimeoutSeconds 30)) {
                    throw 'Incrementally deployed Mixdog did not open a visible application window.'
                }
                $script:daemonAfter = Get-DaemonRecord
            }
        }
        & node $fastDirectHelper --action=commit "--install-dir=$InstallDir" `
            "--state=$FastStatePath" "--plan=$FastPlanPath"
        if ($LASTEXITCODE -ne 0) { throw "FastDirect state commit exited with $LASTEXITCODE" }
        Remove-Item -LiteralPath $backupDir -Recurse -Force
    }
    catch {
        $failure = $_
        Write-Step 'incremental deploy failed; restoring the previous installation'
        if ($appRestartRequired) {
            Stop-MixdogApp
            Stop-InstalledMixdogProcess
        }
        if ($coreRestartRequired) { Stop-Daemon }
        Restore-IncrementalArtifacts
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
}
elseif ($FastDirect) {
    if ([string]::IsNullOrWhiteSpace($Version)) { Get-InstalledSemVer } else { $Version }
}
else { $Version }

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

# Release CI commits to the default branch (version bump, synchronized runtime
# and native manifests). A tree without those commits installs stale manifests
# under the installed version number, so a behind branch is never deployed.
# The detached worker runs after the front process already checked. A
# FastDirect snapshot is a detached copy; its source checkout holds the branch.
if (-not $FastDirectWorker) {
    $upstreamCheckRoot = if ($env:MIXDOG_FASTDIRECT_SOURCE_ROOT) { $env:MIXDOG_FASTDIRECT_SOURCE_ROOT } else { $repoRoot }
    # Work branches are never pushed, so one has no upstream and no release commits to be behind.
    # --quiet: no stderr text, which a native command under ErrorActionPreference=Stop would raise as an error.
    & git -C $upstreamCheckRoot rev-parse --verify --quiet '@{upstream}' | Out-Null
    $hasUpstream = $LASTEXITCODE -eq 0
    if (-not $hasUpstream) {
        Write-Host 'the current branch has no upstream; skipping the check for newer release commits'
    }
    else {
        Write-Step 'checking the working tree includes the latest upstream commits'
        & git -C $upstreamCheckRoot fetch --quiet
        if ($LASTEXITCODE -ne 0) { throw 'git fetch failed; cannot confirm the working tree includes the latest release commits.' }
        $behind = & git -C $upstreamCheckRoot rev-list --count 'HEAD..@{upstream}'
    }
    if ($hasUpstream -and [int]$behind -gt 0) {
        throw "The working tree is $behind commit(s) behind its upstream. Pull them first: release commits carry the version and runtime manifest updates."
    }
}

if ($FastDirect -and $SkipBuild) {
    $fastPlan = Get-Content -LiteralPath $FastPlanPath -Raw | ConvertFrom-Json
    Assert-FastDirectPlanCurrent
}
if ($FastDirect -and -not $FastDirectWorker -and -not $SkipBuild) {
    Remove-Item -LiteralPath $ReceiptPath -Force -ErrorAction SilentlyContinue
    Write-FastDirectReceipt -Status 'building'
}
if (-not $SkipBuild) {
    if ($FastDirect) {
        Write-Step 'fingerprinting FastDirect inputs'
        $forceFull = [bool]$targetVersion -and ((Get-InstalledSemVer) -ne $targetVersion)
        $fastPlan = Get-FastDirectPlan -ForceFull:$forceFull
        if (Test-FastDirectNoOp $fastPlan) { Complete-FastDirectNoOp }
        if ($fastPlan.full) {
            Stop-FastRendererWatch
            Write-Step 'native/package inputs changed; building complete win-unpacked fallback'
            Invoke-Build $targetVersion -DirectoryOnly -Plan $fastPlan
            Assert-FastDirectPlanCurrent
        }
        else {
            if (-not $ReuseBuild -and [bool]$fastPlan.changed.renderer -and
                -not [bool]$fastPlan.prebuilt.renderer) {
                $fastPlan = Complete-FastRendererWatchBuild $fastPlan
            }
            Invoke-FastDirectIncrementalBuild $fastPlan
        }
    }
    else {
        Write-Step 'building the installer from the dev root'
        Invoke-Build $targetVersion
    }
    if ($FastDirect -and -not $FastDirectWorker) {
        Write-FastDirectReceipt -Status 'build-completed'
    }
}
if ($FastDirect -and $fastPlan.full) {
    if (-not (Test-Path -LiteralPath $unpackedDir)) { throw "Unpacked artifact missing: $unpackedDir" }
}
elseif (-not (Test-Path -LiteralPath $installer)) {
    if (-not $FastDirect) { throw "Installer artifact missing: $installer" }
}
if ($FastDirect -and (Test-FastDirectNoOp $fastPlan)) { Complete-FastDirectNoOp }

if ($FastDirect -and $BuildOnly) {
    Write-Step 'FastDirect build stage complete; rerun with -SkipBuild to swap'
    exit 0
}

if ($FastDirect -and -not $FastDirectWorker) {
    if ([string]::IsNullOrWhiteSpace($ReceiptPath)) {
        $ReceiptPath = Join-Path $env:USERPROFILE '.mixdog\data\dev-fast-deploy.json'
    }
    if ($StopBeforeSwap) {
        Write-Step 'stopping before the swap (-StopBeforeSwap); the detached worker would:'
        $drain = if (Test-Path -LiteralPath $coreExe -PathType Leaf) { 'ask the installed core to stop when idle (mixdogd ctl stop --when-idle)' } else { 'ask the running 1.4.5 daemon to drain through /upgrade and wait up to the drain limit, then end it by its pid (every session ends)' }
        Write-Host "  1. close the app: $(if ($appBefore.Count) { 'pid ' + ($appBefore.ProcessId -join ', ') } else { '(not running)' })"
        Write-Host "  2. $drain"
        Write-Host '  3. force-stop what still holds files under the install dir (after 10 s)'
        if ($BeforeSwapScript) {
            if (-not $fastPlan.full) { throw '-BeforeSwapScript runs only before a full replacement; this plan swaps single artifacts.' }
            Write-Host "  3a. run $BeforeSwapScript -CoreExe $(Join-Path $unpackedDir 'resources\core\mixdogd.exe') (a failure ends the deploy; -Undo runs if step 4 or 5 fails)"
        }
        Write-Host "  4. $(if ($fastPlan.full) { "replace every entry of $InstallDir with $unpackedDir (the old ones are kept aside until the new app has published a core)" } else { "swap the changed artifacts (shell: $(@($fastPlan.targets).Count -gt 0), core: $([bool]$fastPlan.core), runtime package: $([bool]$fastPlan.runtime))" })"
        Write-Host '  5. start the app and wait for a fresh daemon.json and a visible window; on failure restore step 4'
        Write-Host "plan current: yes (inputs match the plan); installed now: $installedBefore; target: $targetVersion; core: $(if ($CoreBinary) { $CoreBinary } else { 'built by cargo' })"
        exit 0
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
        Start-InstalledMixdogApp
        Write-Step "waiting for the app's own updater to install $targetVersion"
        $deadline = [DateTime]::UtcNow.AddMinutes(6)
        while ((Get-InstalledVersion) -ne $targetVersion -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Seconds 2
        }
        if ((Get-InstalledVersion) -ne $targetVersion) {
            throw "The updater did not install $targetVersion (installed: $(Get-InstalledVersion))."
        }
    }
    finally {
        if ($feed -and -not $feed.HasExited) { Stop-Process -Id $feed.Id -Force -ErrorAction SilentlyContinue }
        Remove-Item Env:MIXDOG_UPDATER_DEV_FEED -ErrorAction SilentlyContinue
        Remove-Item Env:MIXDOG_UPDATER_DEV_AUTO_INSTALL -ErrorAction SilentlyContinue
    }
}
elseif ($FastDirect) {
    try {
        Write-FastDirectReceipt -Status 'worker-started'
        # Let the launching Mixdog shell return before this independent worker
        # terminates the app and daemon that owned it.
        Start-Sleep -Seconds 2
        if ($BeforeSwapScript -and -not $fastPlan.full) {
            throw '-BeforeSwapScript runs only before a full replacement; this plan swaps single artifacts. Nothing was stopped.'
        }
        Write-Step 'stopping the installed app'
        Stop-MixdogApp
        Write-Step 'stopping the session daemon'
        Stop-Daemon
        Write-Step 'waiting for every installed Mixdog process to release files'
        Stop-InstalledMixdogProcess
        if ($fastPlan.full) {
            Write-Step 'atomically replacing the installed directory'
            Install-UnpackedBuild
            & node $fastDirectHelper --action=commit "--install-dir=$InstallDir" `
                "--state=$FastStatePath" "--plan=$FastPlanPath"
            if ($LASTEXITCODE -ne 0) { throw "FastDirect state commit exited with $LASTEXITCODE" }
        }
        else {
            Write-Step 'atomically replacing changed installed artifacts'
            Install-IncrementalBuild $fastPlan
        }
        Write-FastDirectReceipt -Status 'completed'
    }
    catch {
        Write-FastDirectReceipt -Status 'failed' -Detail $_.Exception.Message
        throw
    }
}
else {
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
        Start-InstalledMixdogApp
    }
}

if ($NoLaunch) {
    Write-Step 'stopping the app again (-NoLaunch)'
    Stop-MixdogApp
    if (-not $KeepDaemon) { Stop-Daemon }
}
elseif (-not $FastDirect) {
    Write-Step 'waiting for a fresh session daemon'
    $daemonAfter = Wait-ForFreshDaemon -Previous $daemonBefore -RelaunchExe $installedExe
    if (-not (Wait-ForVisibleAppWindow -TimeoutSeconds 15)) {
        # A live background process is not a successful relaunch. Starting the exe
        # again either creates the missing app or activates the primary instance
        # through Electron's second-instance handler.
        Write-Step 'activating the installed app window'
        Start-InstalledMixdogApp
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
