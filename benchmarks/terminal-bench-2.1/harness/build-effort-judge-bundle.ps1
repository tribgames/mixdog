# Builds mixdog-prebake/effort-judge-bundle.tar for runs with -EffortJudge on|steps:
# the effort-judge release named in src/runtime/effort-judge/model-manifest.json,
# downloaded and sha256-checked by the product installer, at the tar root, plus
# node_modules/onnxruntime-node (linux-x64 binaries only) and
# node_modules/onnxruntime-common at the version the repo pins.
# <Out>.json records the release and the tar digest; run.ps1 checks both.
# Usage: .\harness\build-effort-judge-bundle.ps1 [-Out <tar>]
param(
    [string]$Out = (Join-Path $PSScriptRoot '..\mixdog-prebake\effort-judge-bundle.tar')
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$repoPackage = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = $repoPackage.dependencies.'onnxruntime-node'
$installer = ([Uri](Join-Path $repoRoot 'src\runtime\effort-judge\model-install.mjs')).AbsoluteUri

$stage = Join-Path ([IO.Path]::GetTempPath()) ('effort-judge-bundle-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path (Join-Path $stage 'node_modules') | Out-Null
Push-Location $stage
try {
    node --input-type=module -e 'const m = await import(process.argv[1]); await m.installEffortJudgeModel(process.argv[2]);' $installer $stage
    if ($LASTEXITCODE -ne 0) { throw "effort-judge model download failed" }
    $release = [string]((Get-Content (Join-Path $stage 'install.json') -Raw | ConvertFrom-Json).release)
    $steps = ((Get-Content (Join-Path $stage 'calibration.json') -Raw | ConvertFrom-Json).steps -eq 1)
    npm pack "onnxruntime-node@$version" "onnxruntime-common@$version" --silent | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed" }
    foreach ($name in 'onnxruntime-node', 'onnxruntime-common') {
        $unpack = Join-Path $stage "unpack-$name"
        New-Item -ItemType Directory -Path $unpack | Out-Null
        tar -xzf "$name-$version.tgz" -C $unpack
        if ($LASTEXITCODE -ne 0) { throw "tar failed for $name" }
        Move-Item (Join-Path $unpack 'package') (Join-Path $stage "node_modules\$name")
    }
    # The containers are linux-x64; other platforms' binaries only add size.
    $bin = Join-Path $stage 'node_modules\onnxruntime-node\bin\napi-v6'
    Get-ChildItem $bin -Directory | Where-Object { $_.Name -ne 'linux' } | Remove-Item -Recurse -Force
    Get-ChildItem (Join-Path $bin 'linux') -Directory | Where-Object { $_.Name -ne 'x64' } | Remove-Item -Recurse -Force
    if (-not (Test-Path (Join-Path $bin 'linux\x64\onnxruntime_binding.node'))) { throw "linux-x64 binding missing from onnxruntime-node $version" }
    New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
    tar -cf $Out --exclude='*.tgz' --exclude='unpack-*' -C $stage .
    if ($LASTEXITCODE -ne 0) { throw "tar failed for the bundle" }
    $item = Get-Item $Out
    $digest = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    [ordered]@{ release = $release; steps = $steps; sha256 = $digest; onnxruntime = $version } |
        ConvertTo-Json | Set-Content -LiteralPath "$($item.FullName).json" -Encoding utf8
    '{0} ({1:N1} MB, {2}, steps={3}, onnxruntime-node {4})' -f $item.FullName, ($item.Length / 1MB), $release, $steps, $version
}
finally {
    Pop-Location
    Remove-Item -Recurse -Force $stage
}
