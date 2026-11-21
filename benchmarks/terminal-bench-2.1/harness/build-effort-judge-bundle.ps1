# Builds mixdog-prebake/effort-judge-bundle.tar for runs with -EffortJudge on|steps:
# the effort-judge release named in src/runtime/effort-judge/model-manifest.json
# (the manifest the core installs from), each file downloaded with its exact size
# and sha256 checked, at the tar root with the core's install.json stamp. The
# ONNX Runtime is the core bundle's own (js-runtime.json ortLibrary).
# <Out>.json records the release and the tar digest; run.ps1 checks both.
# Usage: .\harness\build-effort-judge-bundle.ps1 [-Out <tar>]
param(
    [string]$Out = (Join-Path $PSScriptRoot '..\mixdog-prebake\effort-judge-bundle.tar')
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$manifest = Get-Content (Join-Path $repoRoot 'src\runtime\effort-judge\model-manifest.json') -Raw | ConvertFrom-Json
$release = [string]$manifest.release

$stage = Join-Path ([IO.Path]::GetTempPath()) ('effort-judge-bundle-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    foreach ($file in $manifest.files.PSObject.Properties) {
        $target = Join-Path $stage $file.Name
        Invoke-WebRequest -Uri ([string]$file.Value.url) -OutFile $target -UseBasicParsing
        $item = Get-Item -LiteralPath $target
        if ($item.Length -ne [int64]$file.Value.size) { throw "$($file.Name): $($item.Length) bytes, the manifest names $($file.Value.size)" }
        $digest = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($digest -ne [string]$file.Value.sha256) { throw "$($file.Name): sha256 $digest differs from the manifest" }
    }
    [IO.File]::WriteAllText((Join-Path $stage 'install.json'), (@{ release = $release } | ConvertTo-Json -Compress))
    $steps = ((Get-Content (Join-Path $stage 'calibration.json') -Raw | ConvertFrom-Json).steps -eq 1)
    New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
    tar -cf $Out -C $stage .
    if ($LASTEXITCODE -ne 0) { throw "tar failed for the bundle" }
    $item = Get-Item $Out
    $digest = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    [ordered]@{ release = $release; steps = $steps; sha256 = $digest } |
        ConvertTo-Json | Set-Content -LiteralPath "$($item.FullName).json" -Encoding utf8
    '{0} ({1:N1} MB, {2}, steps={3})' -f $item.FullName, ($item.Length / 1MB), $release, $steps
}
finally {
    Remove-Item -Recurse -Force $stage
}
