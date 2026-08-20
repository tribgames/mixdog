<#
  One-command web deploy (user: CI/CD 단축).

    pwsh scripts/deploy-remote.ps1              # changed renderer/relay -> VPS swap
    pwsh scripts/deploy-remote.ps1 -FastDirect  # ...then installed-app update

  Renderer and relay fingerprints are independent:
    - unchanged inputs skip build, stage, and upload
    - relay-only changes reuse the installed VPS renderer
    - fresh local renderer output is reused
    - FastDirect builds only stale local targets while upload runs
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
trap {
  [Console]::Error.WriteLine(($_ | Out-String))
  exit 1
}
$repo = Split-Path -Parent $PSScriptRoot
function Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
$desktopDir = Join-Path $repo 'apps\desktop'
$relayDir = Join-Path $repo 'apps\relay'
$deployPlanner = Join-Path $relayDir 'scripts\deploy-plan.mjs'
$deployPlanPath = Join-Path $relayDir '.cache\deploy-plan.json'
$deployStatePath = Join-Path $relayDir '.cache\deploy-state.json'

$planOutput = & node $deployPlanner --action=plan "--state=$deployStatePath" "--plan=$deployPlanPath"
if ($LASTEXITCODE -ne 0) { throw "live deploy planning exited with $LASTEXITCODE" }
$deployPlan = $planOutput | Out-String | ConvertFrom-Json

if ($deployPlan.rendererBuild) {
  Step 'building changed desktop renderer only'
  Push-Location $desktopDir
  try {
    $previousTargets = $env:MIXDOG_ELECTRON_BUILD_TARGETS
    $env:MIXDOG_ELECTRON_BUILD_TARGETS = 'renderer'
    & npx.cmd electron-vite build
    if ($LASTEXITCODE -ne 0) { throw "renderer build exited with $LASTEXITCODE" }
  } finally {
    if ($null -eq $previousTargets) {
      Remove-Item Env:MIXDOG_ELECTRON_BUILD_TARGETS -ErrorAction SilentlyContinue
    } else {
      $env:MIXDOG_ELECTRON_BUILD_TARGETS = $previousTargets
    }
    Pop-Location
  }
} elseif ($deployPlan.rendererChanged) {
  Step 'reusing fresh desktop renderer build'
}

if ($deployPlan.stageRenderer) {
  Step 'staging changed web renderer beside the relay'
  npm run stage:web --prefix $relayDir
  if ($LASTEXITCODE -ne 0) { throw "stage:web exited with $LASTEXITCODE" }
}

$uploadJob = $null
if ($deployPlan.deploy) {
  Step 'pack + upload + atomic VPS swap (background job)'
  $version = (Get-Content (Join-Path $relayDir 'package.json') -Raw | ConvertFrom-Json).version
  $uploadJob = Start-Job -ScriptBlock {
    param($relayDir, $SshHost, $Domain, $version, $includeRenderer)
    $ErrorActionPreference = 'Stop'
    $tgz = Join-Path $env:TEMP 'mixdog-relay-upload.tgz'
    Remove-Item -LiteralPath $tgz -Force -ErrorAction SilentlyContinue
    $entries = @('server.mjs', 'package.json', 'package-lock.json', 'lib', 'deploy')
    if ($includeRenderer) {
      $deltaTool = Join-Path $relayDir 'deploy\renderer-delta.mjs'
      $cacheDir = Join-Path $relayDir '.cache'
      $baseManifest = Join-Path $cacheDir 'renderer-base-manifest.json'
      $targetManifest = Join-Path $cacheDir 'renderer-manifest.json'
      $deltaDir = Join-Path $cacheDir 'renderer-delta'
      New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
      scp -o BatchMode=yes -q $deltaTool "${SshHost}:/root/mixdog-renderer-delta.mjs"
      if ($LASTEXITCODE -ne 0) { throw "renderer manifest tool upload exited with $LASTEXITCODE" }
      $remoteManifest = & ssh -o BatchMode=yes $SshHost `
        'node /root/mixdog-renderer-delta.mjs --action=manifest --root=/opt/mixdog-relay/renderer'
      if ($LASTEXITCODE -ne 0) { throw "remote renderer manifest exited with $LASTEXITCODE" }
      [IO.File]::WriteAllText(
        $baseManifest,
        (($remoteManifest -join "`n") + "`n"),
        [Text.UTF8Encoding]::new($false)
      )
      $deltaResult = & node $deltaTool --action=create `
        "--root=$(Join-Path $relayDir 'renderer')" "--base=$baseManifest" `
        "--delta=$deltaDir" "--manifest=$targetManifest"
      if ($LASTEXITCODE -ne 0) { throw "renderer delta creation exited with $LASTEXITCODE" }
      Write-Host "renderer delta: $($deltaResult -join '')"
      $entries += @('.cache/renderer-delta', '.cache/renderer-manifest.json')
    }
    & tar -czf $tgz -C $relayDir @entries
    if ($LASTEXITCODE -ne 0) { throw "tar exited with $LASTEXITCODE" }
    scp -o BatchMode=yes -q $tgz "${SshHost}:/root/relay-upload.tgz"
    if ($LASTEXITCODE -ne 0) { throw "scp exited with $LASTEXITCODE" }
    ssh -o BatchMode=yes $SshHost ("rm -rf /root/relay-upload && mkdir -p /root/relay-upload" `
      + " && tar -xzf /root/relay-upload.tgz -C /root/relay-upload" `
      + " && bash /root/relay-upload/deploy/deploy-release.sh $Domain v$version")
    if ($LASTEXITCODE -ne 0) { throw "VPS swap exited with $LASTEXITCODE" }
    $ErrorActionPreference = 'Continue'
    $health = 'no response'
    foreach ($attempt in 1..10) {
      $code = & curl.exe -s -o NUL -w '%{http_code}' --max-time 5 "https://$Domain/healthz" 2>$null
      if ($code) { $health = "HTTP $code" }
      if ($code -eq '200') { break }
      Start-Sleep -Seconds 2
    }
    "[health] https://$Domain/healthz -> $health"
  } -ArgumentList $relayDir, $SshHost, $Domain, $version, ([bool]$deployPlan.rendererChanged)
} else {
  Step 'VPS inputs unchanged; skipping renderer build, stage, and upload'
}

$devUpdate = Join-Path $desktopDir 'scripts\dev-update-windows.ps1'
$fastBuildFailed = $false
if ($FastDirect) {
  Step 'FastDirect staging while the VPS upload runs'
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $devUpdate -FastDirect -BuildOnly
  if ($LASTEXITCODE -ne 0) { $fastBuildFailed = $true }
}

if ($uploadJob) {
  try {
    Receive-Job -Job $uploadJob -Wait -ErrorAction Stop
    & node $deployPlanner --action=commit "--state=$deployStatePath" "--plan=$deployPlanPath"
    if ($LASTEXITCODE -ne 0) { throw "live deploy state commit exited with $LASTEXITCODE" }
  } finally {
    Remove-Job -Job $uploadJob -Force -ErrorAction SilentlyContinue
  }
}
Write-Host ''
if ($fastBuildFailed) { exit 1 }

if ($FastDirect) {
  Step 'FastDirect installed-app swap (app restarts once)'
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $devUpdate -FastDirect -SkipBuild
  exit $LASTEXITCODE
}
