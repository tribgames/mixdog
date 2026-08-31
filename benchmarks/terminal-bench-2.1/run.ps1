param(
    [string]$Preset = "",
    [string]$JobsDir = "",
    [string]$ResumeFrom = "",
    # KEY=VALUE agent-process environment overrides forwarded to harbor (--ae).
    # Not part of the fingerprint: an A/B pair must stay comparable in history,
    # so the switch under test is recorded in the manifest instead.
    [string[]]$AgentEnv = @(),
    [switch]$DryRun,
    [switch]$Status
)

$ErrorActionPreference = "Stop"
$benchRoot = $PSScriptRoot
$presetPath = Join-Path $benchRoot "presets.json"
$routePath = Join-Path $benchRoot "harness/route_profiles.json"
$runnerPath = Join-Path $benchRoot "harness/run-tb21.ps1"
$reportPath = Join-Path $benchRoot "analysis/run-report.mjs"
$contractPath = Join-Path $benchRoot "analysis/contract-hash.mjs"

function Resolve-JobsPath([string]$Path) {
    if ([IO.Path]::IsPathRooted($Path)) {
        return [IO.Path]::GetFullPath($Path)
    }
    return [IO.Path]::GetFullPath((Join-Path $benchRoot $Path))
}

function Assert-PrebakeCurrent {
    # The container install verifies that the prebaked dependency shell matches
    # the pinned package version and exits 1 otherwise — which only surfaces
    # after a full trial wave has been set up and torn down. Check the same
    # thing here, in seconds, before any container starts.
    $repoRoot = (Resolve-Path (Join-Path $benchRoot "..\..")).Path
    $pinned = [string]((Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version)
    $tarPath = [string]$env:MIXDOG_TB_PREBAKE_TAR
    if ([string]::IsNullOrWhiteSpace($tarPath)) {
        $tarPath = Join-Path $benchRoot "mixdog-prebake/mixdog-node-prebake.tar.gz"
    }
    if (-not (Test-Path -LiteralPath $tarPath -PathType Leaf)) {
        # No cache: install() runs the stock installer path. Slower, valid.
        "prebake none (stock installer), pinned=$pinned"
        return
    }
    $prebakeDir = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($tarPath))
    $stampPath = Join-Path $prebakeDir "prebake.json"
    $rebuildHint = "rebuild with: pwsh -NoLogo -NoProfile -File harness/prebake.ps1"
    if (-not (Test-Path -LiteralPath $stampPath -PathType Leaf)) {
        throw "prebake stamp missing ($stampPath); $rebuildHint"
    }
    $baked = ""
    try {
        $baked = [string]((Get-Content -Raw -LiteralPath $stampPath | ConvertFrom-Json).mixdogVersion)
    } catch {
        throw "prebake stamp unreadable ($stampPath); $rebuildHint"
    }
    if ([string]::IsNullOrWhiteSpace($baked)) {
        throw "prebake stamp has no mixdogVersion ($stampPath); $rebuildHint"
    }
    if ($baked -ne $pinned) {
        throw "prebake mixdog version $baked != pinned $pinned — every trial would fail at install; $rebuildHint"
    }
    $stampTime = (Get-Item -LiteralPath $stampPath).LastWriteTimeUtc
    $newer = Get-ChildItem -LiteralPath $prebakeDir -File |
        Where-Object { $_.Name -like 'mixdog-node-prebake.*' -and $_.LastWriteTimeUtc -gt $stampTime } |
        Select-Object -ExpandProperty Name
    if ($newer) {
        throw "prebake artifacts newer than stamp ($($newer -join ', ')); $rebuildHint"
    }
    "prebake $baked ok"
}

function Write-JsonAtomic([object]$Value, [string]$Path) {
    $temporary = "$Path.tmp-$PID"
    $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

if ($Status) {
    if ([string]::IsNullOrWhiteSpace($JobsDir)) {
        if ([string]::IsNullOrWhiteSpace($Preset)) {
            throw "Status requires Preset or JobsDir."
        }
        $candidate = Get-ChildItem -LiteralPath $benchRoot -Directory -ErrorAction SilentlyContinue |
            ForEach-Object {
                $manifestPath = Join-Path $_.FullName "preset-run.json"
                if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return }
                try {
                    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
                    if ($manifest.preset -eq $Preset) {
                        [pscustomobject]@{
                            Path = $_.FullName
                            StartedAt = [datetimeoffset]$manifest.startedAt
                        }
                    }
                } catch { }
            } |
            Sort-Object StartedAt |
            Select-Object -Last 1
        if ($null -eq $candidate) {
            throw "No preset run found for '$Preset'."
        }
        $JobsDir = $candidate.Path
    }
    $statusJobsDir = Resolve-JobsPath $JobsDir
    & node $reportPath --jobs-dir $statusJobsDir --history-root $benchRoot --status
    exit $LASTEXITCODE
}

if ([string]::IsNullOrWhiteSpace($Preset)) {
    throw "Preset is required for a benchmark run."
}

$presetDoc = Get-Content -Raw -LiteralPath $presetPath | ConvertFrom-Json
if ($presetDoc.schemaVersion -ne 1) {
    throw "Unsupported preset schemaVersion: $($presetDoc.schemaVersion)"
}
$presetProperty = $presetDoc.presets.PSObject.Properties[$Preset]
if ($null -eq $presetProperty) {
    $available = @($presetDoc.presets.PSObject.Properties.Name) -join ", "
    throw "Unknown preset '$Preset'. Available: $available"
}
$presetConfig = $presetProperty.Value
$suiteProperty = $presetDoc.suites.PSObject.Properties[[string]$presetConfig.suite]
if ($null -eq $suiteProperty) {
    throw "Preset '$Preset' references unknown suite '$($presetConfig.suite)'."
}
$tasks = @($suiteProperty.Value)
$routeProfile = [string]$presetConfig.routeProfile

$routeDoc = Get-Content -Raw -LiteralPath $routePath | ConvertFrom-Json
if ($routeDoc.schemaVersion -ne 1) {
    throw "Unsupported route profile schemaVersion: $($routeDoc.schemaVersion)"
}
$routeProperty = $routeDoc.profiles.PSObject.Properties[$routeProfile]
if ($null -eq $routeProperty) {
    throw "Preset '$Preset' references unknown route profile '$routeProfile'."
}

$comparison = $null
if (-not [string]::IsNullOrWhiteSpace([string]$presetConfig.compareTo)) {
    $baselineProperty = $presetDoc.baselines.PSObject.Properties[[string]$presetConfig.compareTo]
    if ($null -eq $baselineProperty) {
        throw "Preset '$Preset' references unknown baseline '$($presetConfig.compareTo)'."
    }
    $baselineJobsDir = Resolve-JobsPath ([string]$baselineProperty.Value.jobsDir)
    if (-not (Test-Path -LiteralPath $baselineJobsDir -PathType Container)) {
        throw "Pinned baseline jobs directory not found: $baselineJobsDir"
    }
    $comparison = [ordered]@{
        name = [string]$presetConfig.compareTo
        baseline = $baselineProperty.Value
    }
}

$concurrent = if ($null -ne $presetConfig.concurrent) {
    [int]$presetConfig.concurrent
} else {
    [int]$presetDoc.defaults.concurrent
}
$attempts = if ($null -ne $presetConfig.attempts) {
    [int]$presetConfig.attempts
} else {
    [int]$presetDoc.defaults.attempts
}
$maxRetries = if ($null -ne $presetConfig.maxRetries) {
    [int]$presetConfig.maxRetries
} else {
    [int]$presetDoc.defaults.maxRetries
}
if ($concurrent -lt 1 -or $attempts -lt 1 -or $maxRetries -lt 0) {
    throw "Preset '$Preset' has invalid concurrency, attempts, or retry values."
}

$definition = [ordered]@{
    dataset = [string]$presetDoc.dataset
    suite = [string]$presetConfig.suite
    tasks = $tasks
    routeProfile = $routeProfile
    routes = $routeProperty.Value.routes
    leadFallback = $routeProperty.Value.leadFallback
    concurrent = $concurrent
    attempts = $attempts
    maxRetries = $maxRetries
}
$definitionJson = $definition | ConvertTo-Json -Depth 20 -Compress
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($definitionJson))
} finally {
    $sha.Dispose()
}
$fingerprint = "sha256:" + (($hashBytes | ForEach-Object { $_.ToString("x2") }) -join "")

if ([string]::IsNullOrWhiteSpace($JobsDir)) {
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $JobsDir = "jobs-$Preset-$stamp"
}
$resolvedJobsDir = Resolve-JobsPath $JobsDir

$lead = $routeProperty.Value.routes.lead
$taskLabel = if ($tasks.Count -eq 0) { "full" } else { [string]$tasks.Count }
"preset ${Preset}: suite=$taskLabel model=$($lead.provider)/$($lead.model) effort=$($lead.effort) concurrent=$concurrent repeat=$attempts"
"fingerprint $fingerprint"
"jobs $resolvedJobsDir"
if ($null -ne $comparison) {
    "pair $($comparison.baseline.label)"
}
Assert-PrebakeCurrent

$runnerArgs = @{
    JobsDir = $resolvedJobsDir
    Include = [string[]]$tasks
    Concurrent = $concurrent
    Attempts = $attempts
    MaxRetries = $maxRetries
    RouteProfile = $routeProfile
    DryRun = [bool]$DryRun
}
if (-not [string]::IsNullOrWhiteSpace($ResumeFrom)) {
    $runnerArgs.ResumeFrom = $ResumeFrom
}
$agentEnvEntries = @(
    foreach ($item in $AgentEnv) {
        foreach ($entry in ($item -split ",")) {
            if (-not [string]::IsNullOrWhiteSpace($entry)) { $entry }
        }
    }
)
if ($agentEnvEntries.Count -gt 0) {
    $runnerArgs.AgentEnv = [string[]]$agentEnvEntries
}

if ($DryRun) {
    & $runnerPath @runnerArgs
    exit $LASTEXITCODE
}

if ((Test-Path -LiteralPath $resolvedJobsDir) -and
    @(Get-ChildItem -LiteralPath $resolvedJobsDir -Force).Count -gt 0) {
    throw "JobsDir must be empty for a new preset run: $resolvedJobsDir"
}
New-Item -ItemType Directory -Path $resolvedJobsDir -Force | Out-Null
$manifestPath = Join-Path $resolvedJobsDir "preset-run.json"
# The fingerprint pins dataset and routes only. Capture the prompt surface —
# rules and tool schemas as the container will see them — before the snapshot
# is taken, so the report identifies the exact contract under measurement.
$contractArgs = @(
    $contractPath,
    "--provider", [string]$lead.provider,
    "--model", [string]$lead.model,
    "--workflow", "headless"
)
foreach ($slot in @('worker', 'heavy-worker', 'reviewer', 'debugger')) {
    $routeSlot = $routeProperty.Value.routes.PSObject.Properties[$slot]
    if ($null -eq $routeSlot -or $null -eq $routeSlot.Value) { continue }
    $contractArgs += @(
        "--route",
        ("{0}={1}/{2}" -f $slot, [string]$routeSlot.Value.provider, [string]$routeSlot.Value.model)
    )
}
$leadFallback = $routeProperty.Value.leadFallback
if ($null -ne $leadFallback) {
    $contractArgs += @(
        "--fallback-provider", [string]$leadFallback.provider,
        "--fallback-model", [string]$leadFallback.model
    )
}
$contractJson = & node @contractArgs
if ($LASTEXITCODE -ne 0) {
    throw "contract digest failed (exit $LASTEXITCODE)"
}
if ([string]::IsNullOrWhiteSpace($contractJson)) {
    throw "contract digest returned no JSON"
}
$contract = $contractJson | ConvertFrom-Json
if ($null -eq $contract.rulesHash -or $null -eq $contract.toolContractHash -or $null -eq $contract.promptSurfaceHash) {
    throw "contract digest missing rulesHash, toolContractHash, or promptSurfaceHash"
}
"contract rules=$($contract.rulesHash.Substring(7, 12)) tools=$($contract.toolContractHash.Substring(7, 12)) catalog=$($contract.toolCount) active=$($contract.activeToolCount) provider-tools=$($contract.providerToolCount)"
$manifest = [ordered]@{
    schemaVersion = 1
    preset = $Preset
    fingerprint = $fingerprint
    contract = $contract
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
    definition = $definition
    # Provenance for env-switch A/B runs. Only MIXDOG_* switches are recorded
    # verbatim; anything else could carry a credential, so its value is masked.
    agentEnv = @(
        foreach ($entry in $agentEnvEntries) {
            $name = $entry.Split("=", 2)[0]
            if ($name -like "MIXDOG_*") { $entry } else { "$name=***" }
        }
    )
    comparison = $comparison
}
Write-JsonAtomic $manifest $manifestPath

$benchmarkExitCode = 0
try {
    & $runnerPath @runnerArgs
    $benchmarkExitCode = [int]$LASTEXITCODE
} catch {
    $benchmarkExitCode = 1
    [Console]::Error.WriteLine("benchmark failed: $($_.Exception.Message)")
}

$manifest.completedAt = (Get-Date).ToUniversalTime().ToString("o")
$manifest.exitCode = $benchmarkExitCode
Write-JsonAtomic $manifest $manifestPath

& node $reportPath --jobs-dir $resolvedJobsDir --history-root $benchRoot
$reportExitCode = [int]$LASTEXITCODE
if ($benchmarkExitCode -ne 0) {
    exit $benchmarkExitCode
}
exit $reportExitCode
