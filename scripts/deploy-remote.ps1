<#
  One-command web deploy (user: CI/CD 단축).

    pwsh scripts/deploy-remote.ps1              # build:fast -> stage -> VPS swap
    pwsh scripts/deploy-remote.ps1 -FastDirect  # ...then installed-app update

  Cuts against the old ad-hoc chain:
    - skips typecheck (the dev loop already ran it; `npm run build` keeps it)
    - SWC renderer transform (electron.vite.config.ts)
    - ONE tar.gz upload instead of hundreds of per-file scp round trips
    - the VPS reuses node_modules when package-lock.json is unchanged
  FastDirect stays LAST: its detached worker restarts the daemon after this
  script exits, so nothing tracked dies mid-chain.
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

Step 'packing one release archive'
$tgz = Join-Path $env:TEMP 'mixdog-relay-upload.tgz'
Remove-Item -LiteralPath $tgz -Force -ErrorAction SilentlyContinue
tar -czf $tgz -C (Join-Path $repo 'apps/relay') server.mjs package.json package-lock.json lib renderer deploy
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Step "uploading to $SshHost"
scp -o BatchMode=yes -q $tgz "${SshHost}:/root/relay-upload.tgz"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Step 'atomic swap + health check on the VPS'
$version = (Get-Content (Join-Path $repo 'apps/relay/package.json') -Raw | ConvertFrom-Json).version
ssh -o BatchMode=yes $SshHost ("rm -rf /root/relay-upload && mkdir -p /root/relay-upload" `
  + " && tar -xzf /root/relay-upload.tgz -C /root/relay-upload" `
  + " && bash /root/relay-upload/deploy/deploy-release.sh $Domain v$version")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
curl.exe -s "https://$Domain/healthz"
Write-Host ''

if ($FastDirect) {
  Step 'FastDirect installed-app update (app restarts once)'
  npm run update:dev:fast --prefix (Join-Path $repo 'apps/desktop')
  exit $LASTEXITCODE
}
