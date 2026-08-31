# terminal-bench 2.1 launcher with infra-error auto-retry baked in.
# Usage:
#   .\run-tb21.ps1 -JobsDir jobs-tb21                          # full suite
#   .\run-tb21.ps1 -JobsDir jobs-retry -Include qemu-startup,raman-fitting
param(
    [Parameter(Mandatory)][string]$JobsDir,
    # Resume an interrupted Harbor job by excluding only trials already
    # completed (reward 0 or 1). Pending/running/errored tasks are rerun.
    [string]$ResumeFrom = "",
    [string[]]$Include = @(),
    [string[]]$Exclude = @(),
    [int]$Concurrent = 4,
    [int]$Attempts = 1,
    # Primary route overrides; empty => configured route provider/model.
    [string]$Provider = "",
    [string]$Model = "",
    # Lead session effort override (e.g. xhigh); empty => configured route effort.
    [string]$Effort = "",
    # Complete per-role routing table, applied to the disposable config copy.
    [string]$RouteProfile = "",
    # Auto-retry count for trials that die before/around the agent run
    # (RuntimeError, NonZeroAgentExitCodeError, docker daemon death, ...).
    # Harbor's default exclude list keeps AgentTimeout/Verifier errors OUT of
    # retry, so real task failures are never retried — only infra errors.
    [int]$MaxRetries = 2,
    # Render the exact routes and Harbor command without launching Harbor.
    [switch]$DryRun,
    # Agent container KEY=VALUE entries; comma-bearing values are unsupported.
    [string[]]$AgentEnv = @(),
    # Where to record what this run actually executed: source commit, whether
    # the tree matched it, and the digests of the uploaded runtime bundle.
    # Empty => provenance is not recorded (ad-hoc local run).
    [string]$ProvenanceOut = ""
)
$ErrorActionPreference = "Stop"
$hasProvider = -not [string]::IsNullOrWhiteSpace($Provider)
$hasModel = -not [string]::IsNullOrWhiteSpace($Model)
$hasEffort = -not [string]::IsNullOrWhiteSpace($Effort)
$hasRouteProfile = -not [string]::IsNullOrWhiteSpace($RouteProfile)
$resumeCompletedTasks = @()
if (-not [string]::IsNullOrWhiteSpace($ResumeFrom)) {
    $resumeRoot = (Resolve-Path -LiteralPath $ResumeFrom -ErrorAction Stop).Path
    $resumeResultPath = if ((Get-Item -LiteralPath $resumeRoot).PSIsContainer) {
        Join-Path $resumeRoot "result.json"
    } else {
        $resumeRoot
    }
    if (-not (Test-Path -LiteralPath $resumeResultPath -PathType Leaf)) {
        throw "ResumeFrom result.json not found: $resumeResultPath"
    }
    $resumeResult = Get-Content -Raw -LiteralPath $resumeResultPath | ConvertFrom-Json
    $completed = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($evalProperty in @($resumeResult.stats.evals.PSObject.Properties)) {
        foreach ($metric in @($evalProperty.Value.reward_stats.PSObject.Properties)) {
            foreach ($bucket in @($metric.Value.PSObject.Properties)) {
                foreach ($trialId in @($bucket.Value)) {
                    $task = ([string]$trialId -split "__", 2)[0]
                    if (-not [string]::IsNullOrWhiteSpace($task)) {
                        [void]$completed.Add("terminal-bench/$task")
                    }
                }
            }
        }
    }
    $resumeCompletedTasks = @($completed | Sort-Object)
    if ($resumeCompletedTasks.Count -eq 0 -and [int]$resumeResult.stats.n_completed_trials -gt 0) {
        throw "ResumeFrom contains completed trials but no task ids could be recovered: $resumeResultPath"
    }
}
if ($hasRouteProfile -and ($hasProvider -or $hasModel -or $hasEffort)) {
    throw "RouteProfile cannot be combined with Provider, Model, or Effort."
}
if ($hasProvider -ne $hasModel) {
    throw "Provider and Model must be supplied together, or both omitted."
}
$resolvedAudit = $null
if ($hasRouteProfile) {
    $profilePath = Join-Path $PSScriptRoot "route_profiles.json"
    $profileDoc = Get-Content -Raw $profilePath | ConvertFrom-Json
    if ($profileDoc.schemaVersion -ne 1) {
        throw "Unsupported routing profile schemaVersion: $($profileDoc.schemaVersion)"
    }
    $profileProperty = $profileDoc.profiles.PSObject.Properties[$RouteProfile]
    if ($null -eq $profileProperty) {
        $available = @($profileDoc.profiles.PSObject.Properties.Name) -join ", "
        throw "Unknown RouteProfile '$RouteProfile'. Available: $available"
    }
    # Use the harness validator as the single source of truth before doing any
    # preflight work or constructing a Harbor invocation. ConvertFrom-Json
    # alone accepts missing/extra route fields and weakly compares booleans to
    # schemaVersion 1, so it is not sufficient validation.
    $validatorPath = Join-Path $PSScriptRoot "routing_profiles.py"
    $validationCode = 'import runpy, sys; from pathlib import Path; m = runpy.run_path(sys.argv[1]); p = m["load_route_profile"](sys.argv[2], Path(sys.argv[3])); print(m["format_resolved_routes"](sys.argv[2], p))'
    $validatedAudit = @(
        & python -c $validationCode $validatorPath $RouteProfile $profilePath 2>&1
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Invalid RouteProfile '$RouteProfile': $($validatedAudit -join [Environment]::NewLine)"
    }
    $resolvedAudit = $validatedAudit -join [Environment]::NewLine
}
# Windows: harbor/rich read+write UTF-8 content (agent logs, box-drawing
# glyphs); the cp949 default codec crashed a full run mid-flight. Force
# Python UTF-8 mode (files) + UTF-8 stdio for the whole child tree.
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
# Run from the terminal-bench-2.1 dir (parent of this harness/ dir) so that
# `harness.mixdog_agent` is importable regardless of where the repo lives.
$benchRoot = Split-Path $PSScriptRoot -Parent
Set-Location $benchRoot
$env:PYTHONPATH = $benchRoot

# The published npm package is only a dependency shell; the bundle below is
# the code under measurement. Without this record a report names no source, so
# nobody can tell which commit produced a score. The bundle archive is built
# deterministically, so its digest is reproducible from the same files.
function Get-RuntimeProvenance {
    param(
        [object[]]$PreflightOutput,
        [string]$ManifestPath
    )
    $bundle = $null
    foreach ($line in $PreflightOutput) {
        $text = [string]$line
        if ($text.TrimStart().StartsWith("{")) {
            try { $bundle = $text | ConvertFrom-Json } catch { }
        }
    }
    if ($null -eq $bundle -or [string]::IsNullOrWhiteSpace([string]$bundle.bundleSha256)) {
        throw "runtime bundle preflight produced no bundle digest"
    }
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
    $mixdogVersion = [string]((Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version)
    $commit = ""
    $dirty = $null
    $dirtyPaths = @()
    try {
        $commit = [string](& git -C $repoRoot rev-parse HEAD 2>$null)
        if ($LASTEXITCODE -ne 0) { $commit = "" }
    } catch {
        $commit = ""
    }
    if (-not [string]::IsNullOrWhiteSpace($commit)) {
        # Only the trees that enter the bundle decide whether this run is
        # attributable to that commit: src/ (overlay) and native/ (spawn).
        $status = @(& git -C $repoRoot status --porcelain --untracked-files=all -- src native 2>$null)
        if ($LASTEXITCODE -eq 0) {
            $dirtyPaths = @(
                $status |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                    ForEach-Object { ([string]$_).Trim() }
            )
            $dirty = $dirtyPaths.Count -gt 0
        }
    }
    return [ordered]@{
        schemaVersion = 1
        capturedAt = (Get-Date).ToUniversalTime().ToString("o")
        mixdogVersion = $mixdogVersion
        sourceCommit = $commit
        sourceDirty = $dirty
        sourceDirtyPaths = @($dirtyPaths | Select-Object -First 50)
        bundleSha256 = [string]$bundle.bundleSha256
        bundleFileCount = [int]$bundle.fileCount
        bundleBytes = [int64]$bundle.totalBytes
        spawnSha256 = [string]$bundle.spawnSha256
        bundleManifest = [IO.Path]::GetFileName($ManifestPath)
    }
}

# Freeze the complete local runtime before Harbor starts. The local build
# couples current src with its matching Linux native spawn binary; every trial
# uploads only this immutable bundle.
$snapshotRoot = Join-Path ([IO.Path]::GetTempPath()) ("mixdog-tb-src-" + [guid]::NewGuid().ToString("N"))
$harnessSnapshotRoot = Join-Path ([IO.Path]::GetTempPath()) ("mixdog-tb-harness-" + [guid]::NewGuid().ToString("N"))
$harborExitCode = 0
try {
    if (-not $DryRun) {
        $overlayArgs = @("-m", "harness.src_overlay", "--output", $snapshotRoot)
        $bundleManifestPath = ""
        if (-not [string]::IsNullOrWhiteSpace($ProvenanceOut)) {
            $provenanceDir = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ProvenanceOut))
            New-Item -ItemType Directory -Force -Path $provenanceDir | Out-Null
            $bundleManifestPath = Join-Path $provenanceDir "runtime-manifest.json"
            $overlayArgs += @("--manifest", $bundleManifestPath)
        }
        $overlayPreflight = & python @overlayArgs 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Terminal-Bench runtime bundle preflight failed: $($overlayPreflight -join [Environment]::NewLine)"
        }
        if (-not [string]::IsNullOrWhiteSpace($bundleManifestPath)) {
            $provenance = Get-RuntimeProvenance -PreflightOutput $overlayPreflight -ManifestPath $bundleManifestPath
            $provenance | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ProvenanceOut -Encoding utf8
            $commitLabel = if ($provenance.sourceCommit) { $provenance.sourceCommit.Substring(0, 12) } else { "unknown" }
            $dirtyLabel = if ($null -eq $provenance.sourceDirty) { "unknown" } else { [string]$provenance.sourceDirty }
            "runtime source=$commitLabel dirty=$dirtyLabel bundle=$($provenance.bundleSha256.Substring(0, 12)) files=$($provenance.bundleFileCount) mixdog=$($provenance.mixdogVersion)"
            if ($provenance.sourceDirty) {
                Write-Warning (
                    "source tree differs from HEAD in $($provenance.sourceDirtyPaths.Count) path(s) under src/ or native/; " +
                    "this run cannot be attributed to a published commit — commit before a publishable run"
                )
            }
        }
        New-Item -ItemType Directory -Path $harnessSnapshotRoot -ErrorAction Stop | Out-Null
        $harnessManifest = [ordered]@{}
        foreach ($name in @("anthropic_oauth_preflight.mjs")) {
            $source = Join-Path $PSScriptRoot $name
            $target = Join-Path $harnessSnapshotRoot $name
            Copy-Item -LiteralPath $source -Destination $target -ErrorAction Stop
            (Get-Item -LiteralPath $target).IsReadOnly = $true
            $harnessManifest[$name] = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $env:MIXDOG_TB_SRC_SNAPSHOT = $snapshotRoot
        $env:MIXDOG_TB_HARNESS_SNAPSHOT = $harnessSnapshotRoot
        $env:MIXDOG_TB_HARNESS_SNAPSHOT_MANIFEST = ($harnessManifest | ConvertTo-Json -Compress)
    }

$harborArgs = @(
    "run",
    "-d", "terminal-bench/terminal-bench-2-1",
    "--agent-import-path", "harness.mixdog_agent:MixdogAgent",
    "-o", $JobsDir,
    "-n", $Concurrent,
    "-k", $Attempts,
    "-r", $MaxRetries,
    "--retry-exclude", "AgentTimeoutError",
    "--retry-exclude", "VerifierOutputParseError",
    "--retry-exclude", "RewardFileEmptyError",
    "-y"
)
# Accept both array and comma-joined string; task names need the
# "terminal-bench/" prefix to match the dataset registry names.
function Expand-Tasks([string[]]$names) {
    $names | ForEach-Object { $_ -split "," } | Where-Object { $_ } | ForEach-Object {
        if ($_ -like "terminal-bench/*") { $_ } else { "terminal-bench/$_" }
    }
}
foreach ($t in (Expand-Tasks $Include)) { $harborArgs += @("-i", $t) }
foreach ($t in (Expand-Tasks $Exclude)) { $harborArgs += @("-x", $t) }
foreach ($t in $resumeCompletedTasks) { $harborArgs += @("-x", $t) }
if ($resumeCompletedTasks.Count -gt 0) {
    "resume: excluding $($resumeCompletedTasks.Count) completed task(s) from $resumeResultPath"
}
if ($hasModel) { $harborArgs += @("-m", $Model) }
if ($hasProvider) { $harborArgs += @("--ak", "provider=$Provider") }
if ($Effort) { $harborArgs += @("--ak", "effort=$Effort") }
foreach ($item in $AgentEnv) {
    foreach ($entry in ($item -split ",")) {
        if ($entry -notmatch "^[A-Za-z_][A-Za-z0-9_]*=.+$") {
            $equalsIndex = $entry.IndexOf("=")
            $displayEntry = if ($equalsIndex -ge 0) {
                ($entry.Substring(0, $equalsIndex) -replace "[\x00-\x1F\x7F]", "?") + "=***"
            } else {
                "<missing '='>"
            }
            throw "AgentEnv entry must be KEY=VALUE with a valid environment variable name and non-empty value: '$displayEntry'"
        }
        $harborArgs += @("--ae", $entry)
    }
}
if ($hasRouteProfile) {
    $harborArgs += @("--ak", "route_profile=$RouteProfile")
    $resolvedAudit
}

$displayArgs = @($harborArgs)
for ($i = 0; $i -lt ($displayArgs.Count - 1); $i++) {
    if ($displayArgs[$i] -eq "--ae") {
        $key = $displayArgs[$i + 1].Split("=", 2)[0]
        $displayArgs[$i + 1] = "$key=***"
        $i++
    }
}
"harbor $($displayArgs -join ' ')"
if (-not $DryRun) {
    # Progress heartbeat: harbor's rich progress bar is invisible through a
    # non-TTY pipe, so a long run looks hung. A detached pwsh inherits this
    # console/pipe (-NoNewWindow) and prints trial counts + last file activity
    # from the run's result.json every 30s. Task-neutral: counts only, no
    # task names or hints reach the agent (separate process, stdout only).
    $heartbeat = $null
    try {
        $hbJobs = $JobsDir.Replace("'", "''")
        $hbCommand = "`$jobs = '$hbJobs'; while (`$true) { Start-Sleep -Seconds 30; try { " +
            "`$run = Get-ChildItem -LiteralPath `$jobs -Directory -ErrorAction Stop | Sort-Object Name | Select-Object -Last 1; " +
            "if (`$null -eq `$run) { continue }; " +
            "`$rp = Join-Path `$run.FullName 'result.json'; " +
            "if (-not (Test-Path -LiteralPath `$rp)) { continue }; " +
            "`$s = (Get-Content -Raw -LiteralPath `$rp | ConvertFrom-Json).stats; " +
            "`$last = Get-ChildItem -LiteralPath `$run.FullName -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; " +
            "`$age = if (`$last) { [int]([DateTime]::Now - `$last.LastWriteTime).TotalSeconds } else { -1 }; " +
            "Write-Host ('[progress {0:HH:mm:ss}] completed={1} running={2} pending={3} errors={4} last-activity={5}s ago' -f (Get-Date), `$s.n_completed_trials, `$s.n_running_trials, `$s.n_pending_trials, `$s.n_errored_trials, `$age) " +
            "} catch { } }"
        $hbEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($hbCommand))
        $heartbeat = Start-Process (Get-Command pwsh.exe).Source `
            -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $hbEncoded) `
            -NoNewWindow -PassThru
    } catch {
        Write-Warning "progress heartbeat unavailable: $($_.Exception.Message)"
    }
    try {
        harbor @harborArgs
        $harborExitCode = $LASTEXITCODE
    } finally {
        if ($heartbeat -and -not $heartbeat.HasExited) {
            Stop-Process -Id $heartbeat.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
}
finally {
    Remove-Item Env:MIXDOG_TB_SRC_SNAPSHOT -ErrorAction SilentlyContinue
    Remove-Item Env:MIXDOG_TB_HARNESS_SNAPSHOT -ErrorAction SilentlyContinue
    Remove-Item Env:MIXDOG_TB_HARNESS_SNAPSHOT_MANIFEST -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $snapshotRoot) {
        Remove-Item -LiteralPath $snapshotRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $harnessSnapshotRoot) {
        Remove-Item -LiteralPath $harnessSnapshotRoot -Recurse -Force
    }
}
if ($harborExitCode -ne 0) {
    exit $harborExitCode
}
