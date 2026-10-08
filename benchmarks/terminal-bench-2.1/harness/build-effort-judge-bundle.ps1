# Builds mixdog-prebake/effort-judge-bundle.tar for route profiles with
# "autoEffort": true: the installed effort-judge model files at the tar root,
# plus node_modules/onnxruntime-node (linux-x64 binaries only) and
# node_modules/onnxruntime-common at the version the repo pins.
# Usage: .\harness\build-effort-judge-bundle.ps1 [-ModelDir <dir>] [-Out <tar>]
param(
  [string]$ModelDir = (Join-Path $env:LOCALAPPDATA 'mixdog-dev\default\data\models\effort-judge'),
  [string]$Out = (Join-Path $PSScriptRoot '..\mixdog-prebake\effort-judge-bundle.tar')
)
$ErrorActionPreference = 'Stop'
$repoPackage = Get-Content (Join-Path $PSScriptRoot '..\..\..\package.json') -Raw | ConvertFrom-Json
$version = $repoPackage.dependencies.'onnxruntime-node'
if (-not (Test-Path (Join-Path $ModelDir 'model.onnx'))) { throw "no effort-judge model in $ModelDir" }

$stage = Join-Path ([IO.Path]::GetTempPath()) ('effort-judge-bundle-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path (Join-Path $stage 'node_modules') | Out-Null
Push-Location $stage
try {
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
  Copy-Item (Join-Path $ModelDir '*') $stage
  New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
  tar -cf $Out --exclude='*.tgz' --exclude='unpack-*' -C $stage .
  if ($LASTEXITCODE -ne 0) { throw "tar failed for the bundle" }
  $item = Get-Item $Out
  '{0} ({1:N1} MB, onnxruntime-node {2}, model from {3})' -f $item.FullName, ($item.Length / 1MB), $version, $ModelDir
} finally {
  Pop-Location
  Remove-Item -Recurse -Force $stage
}
