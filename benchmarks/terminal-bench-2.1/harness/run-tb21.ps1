# terminal-bench 2.1 launcher with infra-error auto-retry baked in.
# Usage:
#   .\run-tb21.ps1 -JobsDir jobs-tb21                          # full suite
#   .\run-tb21.ps1 -JobsDir jobs-retry -Include qemu-startup,raman-fitting
param(
    [Parameter(Mandatory)][string]$JobsDir,
    [string[]]$Include = @(),
    [string[]]$Exclude = @(),
    [int]$Concurrent = 4,
    # Primary route overrides; empty => configured route provider/model.
    [string]$Provider = "",
    [string]$Model = "",
    # Lead session effort override (e.g. xhigh); empty => configured route effort.
    [string]$Effort = "",
    # Complete per-role routing table, applied to the disposable config copy.
    [string]$RouteProfile = "",
    # Explicit workflow override; empty preserves the stock default.
    [string]$Workflow = "",
    # Auto-retry count for trials that die before/around the agent run
    # (RuntimeError, NonZeroAgentExitCodeError, docker daemon death, ...).
    # Harbor's default exclude list keeps AgentTimeout/Verifier errors OUT of
    # retry, so real task failures are never retried — only infra errors.
    [int]$MaxRetries = 2,
    # Render the exact routes and Harbor command without launching Harbor.
    [switch]$DryRun,
    # Agent container KEY=VALUE entries; comma-bearing values are unsupported.
    [string[]]$AgentEnv = @()
)
$ErrorActionPreference = "Stop"
$hasProvider = -not [string]::IsNullOrWhiteSpace($Provider)
$hasModel = -not [string]::IsNullOrWhiteSpace($Model)
$hasEffort = -not [string]::IsNullOrWhiteSpace($Effort)
$hasRouteProfile = -not [string]::IsNullOrWhiteSpace($RouteProfile)
$hasWorkflow = -not [string]::IsNullOrWhiteSpace($Workflow)
if ($hasRouteProfile -and ($hasProvider -or $hasModel -or $hasEffort)) {
    throw "RouteProfile cannot be combined with Provider, Model, or Effort."
}
if ($hasProvider -ne $hasModel) {
    throw "Provider and Model must be supplied together, or both omitted."
}
$resolvedProfile = $null
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
    $validationCode = 'import json, runpy, sys; from pathlib import Path; module = runpy.run_path(sys.argv[1]); print(json.dumps(module["load_route_profile"](sys.argv[2], Path(sys.argv[3])), separators=(",", ":")))'
    $validatedProfileJson = @(
        & python -c $validationCode $validatorPath $RouteProfile $profilePath 2>&1
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Invalid RouteProfile '$RouteProfile': $($validatedProfileJson -join [Environment]::NewLine)"
    }
    $resolvedProfile = ($validatedProfileJson -join [Environment]::NewLine) | ConvertFrom-Json
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

# Freeze the complete source union before Harbor starts. Every trial uploads
# only this immutable snapshot; the adapter verifies it again before apply.
$snapshotRoot = Join-Path ([IO.Path]::GetTempPath()) ("mixdog-tb-src-" + [guid]::NewGuid().ToString("N"))
$fallbackStateRoot = Join-Path ([IO.Path]::GetTempPath()) ("mixdog-tb-fallback-" + [guid]::NewGuid().ToString("N"))
$harborExitCode = 0
try {
    $overlayPreflight = & python -m harness.src_overlay --output $snapshotRoot 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Terminal-Bench src overlay preflight failed: $($overlayPreflight -join [Environment]::NewLine)"
    }
    $env:MIXDOG_TB_SRC_SNAPSHOT = $snapshotRoot
    $env:MIXDOG_TB_FALLBACK_STATE_DIR = $fallbackStateRoot

$harborArgs = @(
    "run",
    "-d", "terminal-bench/terminal-bench-2-1",
    "--agent-import-path", "harness.mixdog_agent:MixdogAgent",
    "-o", $JobsDir,
    "-n", $Concurrent,
    "-r", $MaxRetries,
    "--retry-exclude", "AgentTimeoutError",
    "--retry-exclude", "VerifierOutputParseError",
    # VerifierTimeoutError intentionally NOT excluded: a verifier (grader)
    # timeout is a load/infra artifact, not an agent failure — observed under
    # 8-way concurrency (torch-pipeline-parallelism: agent finished + verified,
    # grader exceeded its fixed 900s budget). Retrying is fair game.
    "--retry-exclude", "RewardFileEmptyError",
    # Verifier env-build resilience: grader uv installs of large wheel stacks
    # (CUDA torch ~2GB) hit the default 30s per-download timeout under 8-way
    # concurrency on this link (torch-pipeline-parallelism: agent PASSed, the
    # grader died downloading nvidia-cudnn). Longer waits only; grading
    # conditions themselves are unchanged.
    "--verifier-env", "UV_HTTP_TIMEOUT=300",
    "-q", "-y"
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
if ($hasModel) { $harborArgs += @("-m", $Model) }
if ($hasProvider) { $harborArgs += @("--ak", "provider=$Provider") }
if ($Effort) { $harborArgs += @("--ak", "effort=$Effort") }
if ($hasWorkflow) { $harborArgs += @("--ak", "workflow=$Workflow") }
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
    $routeParts = @()
    foreach ($role in @("lead", "worker", "heavy-worker", "reviewer", "debugger", "explorer")) {
        $route = $resolvedProfile.routes.$role
        $fast = if ($route.fast -eq $true) { "true" } else { "false" }
        $routeParts += "${role}=$($route.provider)/$($route.model) effort=$($route.effort) fast=$fast"
    }
    "route-profile ${RouteProfile}: $($routeParts -join '; ')"
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
    harbor @harborArgs
    $harborExitCode = $LASTEXITCODE
}
}
finally {
    Remove-Item Env:MIXDOG_TB_SRC_SNAPSHOT -ErrorAction SilentlyContinue
    Remove-Item Env:MIXDOG_TB_FALLBACK_STATE_DIR -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $snapshotRoot) {
        Remove-Item -LiteralPath $snapshotRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $fallbackStateRoot) {
        Remove-Item -LiteralPath $fallbackStateRoot -Recurse -Force
    }
}
if ($harborExitCode -ne 0) {
    exit $harborExitCode
}
