# Rust-core replacement of prebake.ps1 (the Node prebake): the dependency shell of a Terminal-Bench container is
# the staged `mixdogd` bundle, not NodeSource node + `npm install -g mixdog`. apps/desktop/scripts/stage-core.mjs
# builds `<runtime>/server-cores/linux-x64/bundle.tgz` (mixdogd + its JS runtime payload) and records its sha256
# in the server manifest; this script verifies that digest and the pinned version, and copies the bundle to
#   mixdog-prebake/mixdogd-linux-x64.tgz
# which the agent extracts under /opt/mixdog. Nothing is installed from a registry and no container is started.
param(
    [Parameter(Mandatory = $true)][string]$ServerCores,
    [string]$MixdogVersion = "",
    [string]$Platform = "linux-x64",
    [string]$OutDir = ""
)
$ErrorActionPreference = "Stop"
$manifestFile = Join-Path $ServerCores "servers.json"
$manifest = Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($MixdogVersion)) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
    $MixdogVersion = [string]((Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version)
}
if ([string]::IsNullOrWhiteSpace($MixdogVersion) -or $MixdogVersion -eq "latest") {
    throw "MixdogVersion must be a pinned version, not latest"
}
if ([string]$manifest.version -ne $MixdogVersion) {
    throw "server cores are version $($manifest.version), the pinned version is $MixdogVersion"
}
$entry = $manifest.binaries.$Platform
if (-not $entry) { throw "the server manifest has no $Platform entry" }
$bundle = Join-Path (Join-Path $ServerCores $Platform) $entry.bundle.file
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $bundle).Hash.ToLowerInvariant()
if ($sha -ne [string]$entry.bundle.sha256) {
    throw "bundle digest $sha does not match the manifest $($entry.bundle.sha256)"
}
$outDir = if ($OutDir) { $OutDir } else { Join-Path (Split-Path $PSScriptRoot -Parent) "mixdog-prebake" }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item -LiteralPath $bundle -Destination (Join-Path $outDir "mixdogd-$Platform.tgz") -Force
Write-Output "prebake: mixdogd $MixdogVersion $Platform ($sha) -> $outDir"

