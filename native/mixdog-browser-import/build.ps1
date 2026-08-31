[CmdletBinding()]
param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release',
  [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'),
  [string]$UpstreamDirectory = '',
  [ValidateSet('', 'x64', 'arm64')]
  [string]$TargetArchitecture = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
trap {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}

$UpstreamUrl = 'https://github.com/bitwarden/clients.git'
$UpstreamCommit = '6e2c2151f215df69b7cf75b43f189b2cba8b6b5e'
$isRelease = $Configuration -eq 'Release'
$cargoTarget = switch ($TargetArchitecture) {
  'x64' { 'x86_64-pc-windows-msvc' }
  'arm64' { 'aarch64-pc-windows-msvc' }
  default { '' }
}

$ownedUpstream = [string]::IsNullOrWhiteSpace($UpstreamDirectory)
if ($ownedUpstream) {
  $UpstreamDirectory = Join-Path $env:TEMP "mixdog-browser-import-$UpstreamCommit"
}
$UpstreamDirectory = [IO.Path]::GetFullPath($UpstreamDirectory)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)

if ($ownedUpstream -and -not (Test-Path -LiteralPath (Join-Path $UpstreamDirectory '.git'))) {
  git clone --filter=blob:none --no-checkout $UpstreamUrl $UpstreamDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Unable to clone the browser importer source.' }
  git -C $UpstreamDirectory sparse-checkout init --no-cone
  if ($LASTEXITCODE -ne 0) { throw 'Unable to initialize sparse checkout.' }
  @(
    '/apps/desktop/desktop_native/'
    '/apps/desktop/resources/icon.ico'
    '/LICENSE_GPL.txt'
  ) | Set-Content -LiteralPath (Join-Path $UpstreamDirectory '.git\info\sparse-checkout')
}
if (-not (Test-Path -LiteralPath (Join-Path $UpstreamDirectory '.git'))) {
  throw "UpstreamDirectory is not a Git checkout: $UpstreamDirectory"
}

git -C $UpstreamDirectory fetch --depth 1 origin $UpstreamCommit
if ($LASTEXITCODE -ne 0) { throw 'Unable to fetch the pinned browser importer source.' }
git -C $UpstreamDirectory checkout --detach --force $UpstreamCommit
if ($LASTEXITCODE -ne 0) { throw 'Unable to check out the pinned browser importer source.' }
git -C $UpstreamDirectory clean -fd
if ($LASTEXITCODE -ne 0) { throw 'Unable to clean the isolated browser importer checkout.' }

$nativeRoot = Join-Path $UpstreamDirectory 'apps\desktop\desktop_native'
$configPath = Join-Path $nativeRoot 'chromium_importer\config_constants.rs'
$importerBuildPath = Join-Path $nativeRoot 'chromium_importer\build.rs'
$helperBuildPath = Join-Path $nativeRoot 'bitwarden_chromium_import_helper\build.rs'
$config = [IO.File]::ReadAllText($configPath)
$signatureValidationEnabled = 'pub const ENABLE_SIGNATURE_VALIDATION: bool = true;'
$signatureValidationDisabled = 'pub const ENABLE_SIGNATURE_VALIDATION: bool = false;'
if (-not $config.Contains($signatureValidationEnabled)) {
  throw 'Pinned browser importer no longer exposes the expected signature validation setting.'
}
$config = $config.Replace(
  $signatureValidationEnabled,
  $signatureValidationDisabled
)
if ($config.Contains($signatureValidationEnabled) -or -not $config.Contains($signatureValidationDisabled)) {
  throw 'Unable to disable browser importer signature validation for the unsigned build.'
}
[IO.File]::WriteAllText($configPath, $config)
[IO.File]::WriteAllText($importerBuildPath, @'
include!("config_constants.rs");

fn main() {
    println!("cargo:rerun-if-changed=config_constants.rs");
    if cfg!(not(debug_assertions)) && ENABLE_DEVELOPER_LOGGING {
        panic!("ENABLE_DEVELOPER_LOGGING must be false in release builds");
    }
}
'@
)
# The helper is a hidden elevated process and needs no application icon. Keeping
# resource compilation would pull unrelated desktop assets into the sparse,
# security-scoped native build.
[IO.File]::WriteAllText($helperBuildPath, "fn main() {}`n")

$wrapperDestination = Join-Path $nativeRoot 'mixdog_browser_import_cli'
New-Item -ItemType Directory -Force -Path (Join-Path $wrapperDestination 'src') | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Cargo.toml') -Destination $wrapperDestination -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'src\*') -Destination (Join-Path $wrapperDestination 'src') -Recurse -Force

$cargoArgs = @('build')
if ($isRelease) { $cargoArgs += '--release' }
if ($cargoTarget) { $cargoArgs += @('--target', $cargoTarget) }
$targetKey = if ($cargoTarget) { $cargoTarget } else { 'host' }
$previousCargoTargetDirectory = $env:CARGO_TARGET_DIR
if ([string]::IsNullOrWhiteSpace($previousCargoTargetDirectory)) {
  $env:CARGO_TARGET_DIR = Join-Path $env:TEMP "mx-bi-$($UpstreamCommit.Substring(0, 8))-$targetKey"
}
$cargoTargetRoot = [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
$env:CARGO_NET_GIT_FETCH_WITH_CLI = 'true'
try {
  & cargo @cargoArgs --manifest-path (Join-Path $wrapperDestination 'Cargo.toml')
  if ($LASTEXITCODE -ne 0) { throw 'Unable to build mixdog-browser-import.' }
  Push-Location $nativeRoot
  try {
    & cargo @cargoArgs -p bitwarden_chromium_import_helper
    if ($LASTEXITCODE -ne 0) { throw 'Unable to build the elevated browser import helper.' }
  } finally {
    Pop-Location
  }
} finally {
  if ($null -eq $previousCargoTargetDirectory) {
    Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
  } else {
    $env:CARGO_TARGET_DIR = $previousCargoTargetDirectory
  }
}

$profile = $Configuration.ToLowerInvariant()
$targetProfileDirectory = if ($cargoTarget) {
  Join-Path $cargoTargetRoot "$cargoTarget\$profile"
} else {
  Join-Path $cargoTargetRoot $profile
}
$importer = Join-Path $targetProfileDirectory 'mixdog-browser-import.exe'
$helper = Join-Path $targetProfileDirectory 'bitwarden_chromium_import_helper.exe'
if (-not (Test-Path -LiteralPath $importer) -or -not (Test-Path -LiteralPath $helper)) {
  throw 'Browser importer build did not produce both executables.'
}

Remove-Item -LiteralPath $OutputDirectory -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
Copy-Item -LiteralPath $importer -Destination (Join-Path $OutputDirectory 'mixdog-browser-import.exe')
Copy-Item -LiteralPath $helper -Destination (Join-Path $OutputDirectory 'bitwarden_chromium_import_helper.exe')
Copy-Item -LiteralPath (Join-Path $UpstreamDirectory 'LICENSE_GPL.txt') `
  -Destination (Join-Path $OutputDirectory 'LICENSE_GPL.txt')
@"
Chrome password import sidecar

This directory contains a separate GPL-3.0 process built from:
$UpstreamUrl
commit $UpstreamCommit

Mixdog wrapper source and the reproducible build script are in:
native/mixdog-browser-import/

The sidecar is invoked only from the packaged desktop main process.
"@ | Set-Content -LiteralPath (Join-Path $OutputDirectory 'browser-import-NOTICE.txt')

Write-Host "Browser importer output: $OutputDirectory"
