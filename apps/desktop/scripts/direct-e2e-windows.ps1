[CmdletBinding()]
param(
  [int]$Iterations = 1,
  [string]$Duration = '',
  [double]$IntervalSeconds = 0,
  [switch]$SourceMode,
  [int]$Port = 9341,
  [string]$ProjectPath
)

$ErrorActionPreference = 'Stop'
$desktopDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
  $ProjectPath = (Resolve-Path (Join-Path $desktopDir '..\..')).Path
}
if ($Iterations -lt 0) { throw 'Iterations must be zero or greater.' }
if ($IntervalSeconds -lt 0) { throw 'IntervalSeconds must be zero or greater.' }

function ConvertTo-DurationMs {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return 0L }
  if ($Value -notmatch '^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)$') {
    throw "Duration must use ms, s, m, or h (for example: 30m or 5h)."
  }
  $amount = [double]$Matches[1]
  $factor = switch ($Matches[2]) {
    'ms' { 1 }
    's' { 1000 }
    'm' { 60000 }
    'h' { 3600000 }
  }
  return [long]($amount * $factor)
}

function Get-ProcessTreeIds {
  param([int]$RootId)
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $ids = [Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootId)
  do {
    $before = $ids.Count
    foreach ($process in $all) {
      if ($ids.Contains([int]$process.ParentProcessId)) {
        [void]$ids.Add([int]$process.ProcessId)
      }
    }
  } while ($ids.Count -ne $before)
  return @($ids)
}

function Get-ProcessRole {
  param(
    [string]$Name,
    [string]$CommandLine
  )
  if ($CommandLine -match 'runtime\\memory\\index\.mjs') { return 'memory-worker' }
  if ($CommandLine -match '--type=renderer') { return 'renderer' }
  if ($CommandLine -match '--type=gpu-process') { return 'gpu' }
  if ($CommandLine -match '--type=utility') { return 'utility' }
  if ($CommandLine -match 'electron-vite') { return 'dev-launcher' }
  if ($CommandLine -match 'channel-daemon') { return 'channel-worker' }
  if ($CommandLine -match 'whisper-server') { return 'voice-runtime' }
  if ($Name -eq 'electron' -and $CommandLine -match 'remote-debugging') { return 'desktop-main' }
  return 'other'
}

$durationMs = ConvertTo-DurationMs $Duration
if ($Iterations -eq 0 -and $durationMs -eq 0) {
  throw 'Specify at least one iteration or a duration.'
}

$electron = Join-Path $desktopDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) { throw "Electron is missing: $electron" }
$electronVite = Join-Path $desktopDir 'node_modules\electron-vite\bin\electron-vite.js'
if ($SourceMode -and -not (Test-Path -LiteralPath $electronVite)) {
  throw "electron-vite is missing: $electronVite"
}

$running = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -eq $electron -and $_.CommandLine -notmatch '--type='
})
if ($running.Count) {
  throw "Close the existing Mixdog Desktop window before direct E2E. PID(s): $($running.ProcessId -join ', ')"
}

$artifactDir = Join-Path $desktopDir 'artifacts'
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$stdoutPath = Join-Path $artifactDir "direct-e2e-$stamp.stdout.log"
$stderrPath = Join-Path $artifactDir "direct-e2e-$stamp.stderr.log"
$jsonlPath = Join-Path $artifactDir "direct-e2e-$stamp.jsonl"
$reportPath = Join-Path $artifactDir "direct-e2e-$stamp.json"
$startedAt = [DateTime]::UtcNow
$watch = [Diagnostics.Stopwatch]::StartNew()
$runs = [Collections.Generic.List[object]]::new()
$peakRssMb = 0.0
$appProcess = $null
$caughtError = $null

try {
  # Deliberately inherit the real user environment. Do not set MIXDOG_HOME,
  # MIXDOG_DATA_DIR, MIXDOG_RUNTIME_ROOT, or an alternate Chromium user-data-dir.
  $launcher = if ($SourceMode) { (Get-Command node.exe -ErrorAction Stop).Source } else { $electron }
  $launcherArgs = if ($SourceMode) {
    @($electronVite, '.', '--remoteDebuggingPort', [string]$Port, '--clearScreen', 'false')
  } else {
    @('.', "--remote-debugging-port=$Port")
  }
  $appProcess = Start-Process -FilePath $launcher -ArgumentList $launcherArgs `
    -WorkingDirectory $desktopDir -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

  $target = $null
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 100
    if ($appProcess.HasExited) {
      throw "Mixdog exited before CDP became available (exit $($appProcess.ExitCode))."
    }
    try {
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
      $target = @($targets | Where-Object { $_.type -eq 'page' })[0]
    } catch {}
  } while (-not $target -and [DateTime]::UtcNow -lt $deadline)
  if (-not $target) { throw "Mixdog CDP target did not appear on port $Port." }

  $iteration = 0
  while ($true) {
    if ($Iterations -gt 0 -and $iteration -ge $Iterations) { break }
    if ($durationMs -gt 0 -and $iteration -gt 0 -and $watch.ElapsedMilliseconds -ge $durationMs) { break }
    $iteration += 1
    $iterationWatch = [Diagnostics.Stopwatch]::StartNew()
    $raw = & node.exe --import tsx 'scripts/cdp-e2e.mjs' $target.webSocketDebuggerUrl $ProjectPath
    if ($LASTEXITCODE -ne 0) { throw "Direct CDP E2E iteration $iteration exited with $LASTEXITCODE." }
    $result = $raw | ConvertFrom-Json
    $iterationWatch.Stop()
    $treeIds = Get-ProcessTreeIds $appProcess.Id
    # Capture one immutable CIM snapshot. Get-Process exposes live objects whose
    # WorkingSet64 getter throws if a short-lived Chromium child exits while the
    # rows are being sorted.
    $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in $treeIds })
    $rssBytes = ($processes | Measure-Object WorkingSetSize -Sum).Sum
    $rssMb = [Math]::Round($rssBytes / 1MB, 2)
    $peakRssMb = [Math]::Max($peakRssMb, $rssMb)
    $processBreakdown = @($processes | Sort-Object WorkingSetSize -Descending | ForEach-Object {
      $processName = [IO.Path]::GetFileNameWithoutExtension([string]$_.Name)
      [ordered]@{
        pid = [int]$_.ProcessId
        parentPid = [int]$_.ParentProcessId
        name = $processName
        role = Get-ProcessRole -Name $processName -CommandLine ([string]$_.CommandLine)
        rssMb = [Math]::Round([double]$_.WorkingSetSize / 1MB, 2)
      }
    })
    $record = [ordered]@{
      iteration = $iteration
      completedUtc = [DateTime]::UtcNow.ToString('o')
      seconds = [Math]::Round($iterationWatch.Elapsed.TotalSeconds, 3)
      rssMb = $rssMb
      processBreakdown = $processBreakdown
      result = $result
    }
    $runs.Add([pscustomobject]$record)
    ($record | ConvertTo-Json -Depth 20 -Compress) | Add-Content -LiteralPath $jsonlPath -Encoding UTF8
    Write-Output "DIRECT_E2E_ITERATION=$iteration; SECONDS=$($record.seconds); RSS_MB=$rssMb"
    if ($IntervalSeconds -gt 0) {
      $sleepMs = [long]($IntervalSeconds * 1000)
      if ($durationMs -gt 0) {
        $sleepMs = [Math]::Min($sleepMs, [Math]::Max(0, $durationMs - $watch.ElapsedMilliseconds))
      }
      if ($sleepMs -gt 0) { Start-Sleep -Milliseconds $sleepMs }
    }
  }

} catch {
  $caughtError = $_
} finally {
  $watch.Stop()
  if ($appProcess -and -not $appProcess.HasExited) {
    if ($SourceMode) {
      $treeIds = Get-ProcessTreeIds $appProcess.Id
      $desktopRoot = Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -in $treeIds -and $_.ExecutablePath -eq $electron -and
        $_.CommandLine -notmatch '--type='
      } | Sort-Object CreationDate | Select-Object -First 1
      if ($desktopRoot) {
        $desktopProcess = Get-Process -Id $desktopRoot.ProcessId -ErrorAction SilentlyContinue
        if ($desktopProcess) { [void]$desktopProcess.CloseMainWindow() }
      }
    } else {
      [void]$appProcess.CloseMainWindow()
    }
    if (-not $appProcess.WaitForExit(20000)) {
      $treeIds = Get-ProcessTreeIds $appProcess.Id
      foreach ($id in ($treeIds | Sort-Object -Descending)) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
      }
    }
  }

  $report = [ordered]@{
    schemaVersion = 1
    accepted = $null -eq $caughtError
    error = if ($caughtError) { [string]$caughtError.Exception.Message } else { $null }
    mode = if ($SourceMode) { 'source-direct-user-environment' } else { 'direct-user-environment' }
    startedUtc = $startedAt.ToString('o')
    completedUtc = [DateTime]::UtcNow.ToString('o')
    elapsedSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
    iterations = $runs.Count
    requestedIterations = $Iterations
    requestedDuration = $Duration
    intervalSeconds = $IntervalSeconds
    sourceMode = [bool]$SourceMode
    peakRssMb = $peakRssMb
    firstRssMb = if ($runs.Count) { $runs[0].rssMb } else { 0 }
    lastRssMb = if ($runs.Count) { $runs[$runs.Count - 1].rssMb } else { 0 }
    rssGrowthMb = if ($runs.Count) {
      [Math]::Round($runs[$runs.Count - 1].rssMb - $runs[0].rssMb, 2)
    } else { 0 }
    runs = $runs
  }
  $report | ConvertTo-Json -Depth 24 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-Output "DIRECT_E2E_REPORT=$reportPath"
}

if ($caughtError) { throw $caughtError }
