param(
    [string]$Preset = "",
    [string]$JobsDir = "",
    [string]$ResumeFrom = "",
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
$contract = $null
try {
    $contractJson = & node $contractPath
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($contractJson)) {
        $contract = $contractJson | ConvertFrom-Json
        "contract rules=$($contract.rulesHash.Substring(7, 12)) tools=$($contract.toolCatalogHash.Substring(7, 12)) tool-count=$($contract.toolCount) schema-bytes=$($contract.toolSchemaBytes)"
    }
} catch {
    [Console]::Error.WriteLine("contract digest failed: $($_.Exception.Message)")
}
$manifest = [ordered]@{
    schemaVersion = 1
    preset = $Preset
    fingerprint = $fingerprint
    contract = $contract
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
    definition = $definition
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
