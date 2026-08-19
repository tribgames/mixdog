<#
  One-command web deploy (user: CI/CD 단축).

    pwsh scripts/deploy-remote.ps1              # build:fast -> stage -> VPS swap
    pwsh scripts/deploy-remote.ps1 -FastDirect  # ...then installed-app update

  Cuts against the old ad-hoc chain:
    - skips typecheck (the dev loop already ran it; `npm run build` keeps it)
    - SWC renderer transform (electron.vite.config.ts)
    - ONE tar.gz upload instead of hundreds of per-file scp round trips
    - the VPS reuses node_modules when package-lock.json is unchanged
    - -FastDirect reuses the build:fast output (no second electron-vite or
      daemon build) and stages app.asar while the upload runs in a job
  The FastDirect swap stays LAST: its detached worker restarts the daemon
  after this script exits, so nothing tracked dies mid-chain.
#>
[CmdletBinding()]
param(
  [string]$SshHost = 'root@192.255.139.161',
  [string]$Domain = '192-255-139-161.sslip.io',
  [switch]$FastDirect
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
function Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

Step 'building desktop renderer (build:fast, no typecheck)'
npm run build:fast --prefix (Join-Path $repo 'apps/desktop')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Step 'staging web renderer beside the relay'
npm run stage:web --prefix (Join-Path $repo 'apps/relay')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Step 'pack + upload + atomic VPS swap (background job)'
$version = (Get-Content (Join-Path $repo 'apps/relay/package.json') -Raw | ConvertFrom-Json).version
$uploadJob = Start-Job -ScriptBlock {
  param($relayDir, $SshHost, $Domain, $version)
  $ErrorActionPreference = 'Stop'
  $tgz = Join-Path $env:TEMP 'mixdog-relay-upload.tgz'
  Remove-Item -LiteralPath $tgz -Force -ErrorAction SilentlyContinue
  tar -czf $tgz -C $relayDir server.mjs package.json package-lock.json lib renderer deploy
  if ($LASTEXITCODE -ne 0) { throw "tar exited with $LASTEXITCODE" }
  scp -o BatchMode=yes -q $tgz "${SshHost}:/root/relay-upload.tgz"
  if ($LASTEXITCODE -ne 0) { throw "scp exited with $LASTEXITCODE" }
  ssh -o BatchMode=yes $SshHost ("rm -rf /root/relay-upload && mkdir -p /root/relay-upload" `
    + " && tar -xzf /root/relay-upload.tgz -C /root/relay-upload" `
    + " && bash /root/relay-upload/deploy/deploy-release.sh $Domain v$version")
  if ($LASTEXITCODE -ne 0) { throw "VPS swap exited with $LASTEXITCODE" }
  curl.exe -s "https://$Domain/healthz"
} -ArgumentList (Join-Path $repo 'apps/relay'), $SshHost, $Domain, $version

$devUpdate = Join-Path $repo 'apps\desktop\scripts\dev-update-windows.ps1'
$fastBuildFailed = $false
if ($FastDirect) {
  Step 'FastDirect staging (reuses build:fast output) while the upload runs'
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $devUpdate -FastDirect -ReuseBuild -BuildOnly
  if ($LASTEXITCODE -ne 0) { $fastBuildFailed = $true }
}

try {
  Receive-Job -Job $uploadJob -Wait -ErrorAction Stop
} finally {
  Remove-Job -Job $uploadJob -Force -ErrorAction SilentlyContinue
}
Write-Host ''
if ($fastBuildFailed) { exit 1 }

if ($FastDirect) {
  Step 'FastDirect installed-app swap (app restarts once)'
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $devUpdate -FastDirect -SkipBuild
  exit $LASTEXITCODE
}
