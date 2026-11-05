[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'),
    [ValidateSet('', 'x64', 'arm64')]
    [string]$TargetArchitecture = ''
)

# Reproducible build of the desktop window library into dist/. Same shape as
# native/mixdog-secure-desktop/build.ps1: in-repo source only, no dependencies.
# Runs cargo at Idle priority so a build never makes the workstation sluggish.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
trap {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}

$isRelease = $Configuration -eq 'Release'
$cargoTarget = switch ($TargetArchitecture) {
    'x64' { 'x86_64-pc-windows-msvc' }
    'arm64' { 'aarch64-pc-windows-msvc' }
    default { '' }
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)

$cargoArgs = @('build', '--locked')
if ($isRelease) { $cargoArgs += '--release' }
if ($cargoTarget) { $cargoArgs += @('--target', $cargoTarget) }

$process = Start-Process -FilePath 'cargo' -ArgumentList $cargoArgs `
    -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru
try { $process.PriorityClass = 'Idle' } catch { }
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw "cargo build failed (exit $($process.ExitCode))." }

$profile = if ($isRelease) { 'release' } else { 'debug' }
# CARGO_TARGET_DIR moves the build output out of the crate.
$targetRoot = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $PSScriptRoot 'target' }
$targetProfileDirectory = if ($cargoTarget) {
    Join-Path $targetRoot "$cargoTarget\$profile"
}
else {
    Join-Path $targetRoot $profile
}
$library = Join-Path $targetProfileDirectory 'mixdog_window.dll'
if (-not (Test-Path -LiteralPath $library)) {
    throw "Window library build did not produce the DLL: $library"
}

Remove-Item -LiteralPath $OutputDirectory -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
Copy-Item -LiteralPath $library -Destination (Join-Path $OutputDirectory 'mixdog_window.dll')

Write-Host "Window library output: $OutputDirectory"
