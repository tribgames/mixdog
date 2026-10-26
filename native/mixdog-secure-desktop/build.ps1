[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'),
    [ValidateSet('', 'x64', 'arm64')]
    [string]$TargetArchitecture = ''
)

# Reproducible build of the secure-desktop bridge into dist/, with its licence
# notice. Mirrors native/mixdog-browser-import/build.ps1 in shape, but this
# crate is built entirely from in-repo source (no pinned upstream checkout).
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

$cargoArgs = @('build')
if ($isRelease) { $cargoArgs += '--release' }
if ($cargoTarget) { $cargoArgs += @('--target', $cargoTarget) }

# Build at Idle so interactive work stays responsive; cargo's rustc children
# inherit the priority class.
$process = Start-Process -FilePath 'cargo' -ArgumentList $cargoArgs `
    -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru
try { $process.PriorityClass = 'Idle' } catch { }
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw "cargo build failed (exit $($process.ExitCode))." }

$profile = if ($isRelease) { 'release' } else { 'debug' }
$targetProfileDirectory = if ($cargoTarget) {
    Join-Path $PSScriptRoot "target\$cargoTarget\$profile"
}
else {
    Join-Path $PSScriptRoot "target\$profile"
}
$exe = Join-Path $targetProfileDirectory 'mixdog-secure-desktop.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    throw "Secure-desktop build did not produce the executable: $exe"
}

Remove-Item -LiteralPath $OutputDirectory -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
Copy-Item -LiteralPath $exe -Destination (Join-Path $OutputDirectory 'mixdog-secure-desktop.exe')

@"
Mixdog secure-desktop bridge

A Windows service and session helper that let the Mixdog desktop app see and
operate the current input desktop, including the secure desktop (UAC consent and
the lock / sign-in screen), over a local secret-gated named pipe. Part of the
remote-desktop feature; off by default, installed only on explicit user opt-in.

Licence: Apache-2.0, the same licence as Mixdog (see LICENSE and LICENSES/
Apache-2.0.txt at the repository root). Built from in-repo source at:
native/mixdog-secure-desktop/

No reference code is copied verbatim, so this component needs no separate
attribution entry under LICENSES/. The statically linked Rust dependencies are
all permissively dual-licensed under "MIT OR Apache-2.0" and are used here under
Apache-2.0:

  serde, serde_json   https://github.com/serde-rs       (MIT OR Apache-2.0)
  base64              https://github.com/marshallpierce/rust-base64
                                                        (MIT OR Apache-2.0)
  rand                https://github.com/rust-random/rand
                                                        (MIT OR Apache-2.0)
  hmac, sha2          https://github.com/RustCrypto     (MIT OR Apache-2.0)
  windows             https://github.com/microsoft/windows-rs
                                                        (MIT OR Apache-2.0)

Their transitive dependencies (as pinned in Cargo.lock) carry the same
permissive terms; the full texts ship with each crate's source.
"@ | Set-Content -LiteralPath (Join-Path $OutputDirectory 'secure-desktop-NOTICE.txt')

Write-Host "Secure-desktop output: $OutputDirectory"
