<#
  One-command web deploy (user: CI/CD 단축).

    npm run deploy:vps   # changed renderer/relay -> VPS swap
    npm run deploy:fast  # ...while staging the installed-app update

  Renderer and relay fingerprints are independent:
    - unchanged inputs skip build, stage, and upload
    - relay-only changes reuse the installed VPS renderer
    - the relay is the Linux mixdog-relay binary of a CI run whose relay sources
      equal the local tree: a successful run of mixdogd-build.yml (dispatched by
      hand), of deploy.yml (its release calls mixdogd-build, so the artifact
      belongs to the Deploy run) or of linux-desktop-verify.yml, within the 2 days
      the artifact is kept; without such a run only the renderer is deployed and
      the relay change is left for the release
    - fresh local renderer output is reused
    - FastDirect builds only stale local targets while upload runs
  The FastDirect swap stays LAST: its detached worker restarts the daemon
  after this script exits, so nothing tracked dies mid-chain.
#>
[CmdletBinding()]
param(
    [string]$SshHost = 'root@192.255.139.161',
    [string]$Domain = '192-255-139-161.sslip.io',
    [switch]$FastDirect,
    # Build the Linux relay from THIS working tree (committed or not) in the manylinux_2_28 container CI uses, instead of
    # taking a CI artifact. For a box no CI run can serve (sources not pushed). Needs Docker. See Build-LocalRelay.
    [switch]$LocalRelayBuild,
    # Everything up to the first ssh/scp: plan, builds, staging, the upload archive. Prints what would be sent and run;
    # touches no server and records no deploy state.
    [switch]$PlanOnly
)
$ErrorActionPreference = 'Stop'
trap {
    [Console]::Error.WriteLine(($_ | Out-String))
    exit 1
}
$repo = Split-Path -Parent $PSScriptRoot
$deployClock = [Diagnostics.Stopwatch]::StartNew()
function Step([string]$Message) {
    Write-Host ("==> [{0,6:N1}s] {1}" -f $deployClock.Elapsed.TotalSeconds, $Message) `
        -ForegroundColor Cyan
}
$desktopDir = Join-Path $repo 'apps\desktop'
$relayDir = Join-Path $repo 'apps\relay'
$pwshExe = Join-Path $PSHOME 'pwsh.exe'
$desktopVersion = [string]((Get-Content (Join-Path $desktopDir 'package.json') -Raw | ConvertFrom-Json).version)
$deployPlanner = Join-Path $relayDir 'scripts\deploy-plan.mjs'
$deployPlanPath = Join-Path $relayDir '.cache\deploy-plan.json'
$deployStatePath = Join-Path $relayDir '.cache\deploy-state.json'

# A reusable workflow may check out a ref different from the event head, and a
# Deploy run may build a version commit created later. Only the provenance
# recorded beside the exact binary establishes which source it built.
# The Linux relay binary the VPS runs: the mixdog-relay-x86_64-unknown-linux-gnu
# artifact of a successful CI run whose relay sources (what the binary is built
# from: relayInputs of apps/relay/scripts/deploy-plan.mjs without deploy/) equal
# the local tree. The artifact of a called workflow belongs to the caller's run,
# so a Deploy run is searched as well as the hand-dispatched mixdogd-build runs.
# Returns the folder holding it, or $null.
$relaySources = @('native/core/crates/mixdog-relay', 'native/core/crates/mixdog-js',
    'native/core/crates/mixdog-fsio', 'native/core/crates/mixdog-rt',
    'native/core/crates/mixdog-workspace-hack', 'native/core/vendor/regress',
    'native/core/vendor/icu_collator', 'native/core/Cargo.toml', 'native/core/Cargo.lock')
function Get-RelayBinaryDir([string]$cacheDir) {
    $sources = $relaySources
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return $null }
    Push-Location $repo
    try {
        if (git ls-files --others --exclude-standard -- @sources) { return $null }
        git fetch --quiet origin main 2>$null
        $runs = @()
        foreach ($workflow in 'mixdogd-build.yml', 'deploy.yml', 'linux-desktop-verify.yml') {
            $runs += @(& gh run list --workflow $workflow --status success --limit 15 `
                    --json 'databaseId,headSha,createdAt,workflowName' 2>$null | ConvertFrom-Json)
        }
        foreach ($run in ($runs | Sort-Object { [datetime]$_.createdAt } -Descending)) {
            $target = Join-Path $cacheDir "relay-binary-$($run.databaseId)"
            $buildInfo = Join-Path $target 'relay-build.json'
            if (-not (Test-Path -LiteralPath (Join-Path $target 'mixdog-relay'))) {
                & gh run download $run.databaseId --name mixdog-relay-x86_64-unknown-linux-gnu --dir $target 2>$null
                if ($LASTEXITCODE -ne 0) { continue }
            }
            if (-not (Test-Path -LiteralPath $buildInfo)) { continue }
            $builtSha = & node (Join-Path $PSScriptRoot 'relay-artifact.mjs') verify $target x86_64-unknown-linux-gnu 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $builtSha) { continue }
            git cat-file -e "$builtSha^{commit}" 2>$null
            if ($LASTEXITCODE -ne 0) { continue }
            git diff --quiet $builtSha -- @sources
            if ($LASTEXITCODE -ne 0) { continue }
            return $target
        }
    }
    finally {
        Pop-Location
    }
    return $null
}

# The Linux relay of this working tree, built by the command CI runs (mixdogd-build.yml, the x86_64 leg): the pinned
# manylinux_2_28 image and apps/desktop/scripts/linux-build-core-old-glibc.sh. Differences from CI, all outside the
# build command: the repo is mounted read-only, the binary lands in $outDir (MIXDOG_OUT_DIR), only the relay is
# compiled (MIXDOG_RELAY_ONLY), and the target directory, cargo registry/git and rustup live in named Docker volumes
# (never C:\mixdog-build\pool\mixdog-target or native\core\target), so a second build is incremental.
# relay-build.json beside the binary says build=local, dirty or not, and which relay-source fingerprint it was built
# from: relay-artifact.mjs verify (the CI check) refuses it. Returns $outDir.
function Build-LocalRelay([string]$outDir, [string]$fingerprint) {
    $target = 'x86_64-unknown-linux-gnu'
    $tool = Join-Path $PSScriptRoot 'relay-artifact.mjs'
    if (Test-Path -LiteralPath (Join-Path $outDir 'relay-build.json')) {
        $built = & node $tool verify-local $outDir $target 2>$null
        if ($LASTEXITCODE -eq 0 -and $built -eq $fingerprint) {
            Step 'reusing the local relay build of these sources'
            return $outDir
        }
    }
    $workflow = Get-Content (Join-Path $repo '.github\workflows\mixdogd-build.yml') -Raw
    if ($workflow -notmatch 'target: x86_64-unknown-linux-gnu,[^}]*image: "([^"]+)"') {
        throw 'the x86_64 Linux leg of mixdogd-build.yml names no container image'
    }
    $image = $Matches[1]
    docker info *>$null
    if ($LASTEXITCODE -ne 0) { throw 'Docker is not running: start Docker Desktop for -LocalRelayBuild' }
    Step "building the Linux relay from the working tree in $image"
    if (Test-Path -LiteralPath $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    & docker run --rm -e MIXDOG_BUILD_RELAY=1 -e MIXDOG_RELAY_ONLY=1 -e MIXDOG_OUT_DIR=/out `
        -v "${repo}:/w:ro" -v "${outDir}:/out" `
        -v mixdog-relay-build-target:/tmp/target `
        -v mixdog-relay-build-cargo-registry:/root/.cargo/registry `
        -v mixdog-relay-build-cargo-git:/root/.cargo/git `
        -v mixdog-relay-build-rustup:/root/.rustup `
        $image bash /w/apps/desktop/scripts/linux-build-core-old-glibc.sh | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "container relay build exited with $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath (Join-Path $outDir 'mixdog-relay'))) { throw 'the container build left no mixdog-relay' }
    Push-Location $repo
    try {
        $commit = (git rev-parse HEAD).Trim()
        $dirty = if (git status --porcelain --untracked-files=all -- @relaySources) { 'dirty' } else { 'clean' }
    }
    finally { Pop-Location }
    & node $tool record-local $outDir $target $commit $fingerprint $dirty
    if ($LASTEXITCODE -ne 0) { throw "recording the local relay build exited with $LASTEXITCODE" }
    Write-Host "local relay build: commit $commit, $dirty relay sources, fingerprint $fingerprint"
    return $outDir
}

if ($PlanOnly -and $FastDirect) { throw '-PlanOnly stops before the installed-app swap that -FastDirect ends with' }
$planOutput = & node $deployPlanner --action=plan "--state=$deployStatePath" "--plan=$deployPlanPath"
if ($LASTEXITCODE -ne 0) { throw "live deploy planning exited with $LASTEXITCODE" }
$deployPlan = $planOutput | Out-String | ConvertFrom-Json

# The binary is needed to deploy a relay change, and (as the delta tool on the
# VPS) to deploy a renderer to a box whose installed tree is still Node.
$relayBinaryDir = $null
$relayDeployed = $true
# What the last -LocalRelayBuild deploy shipped. The deploy state itself never records a local build (its relay hash is
# blanked after one), so a CI-built relay is never skipped as "unchanged" and a CI deploy always follows a local one.
$localRelayStatePath = Join-Path $relayDir '.cache\relay-local-deploy.json'
$localMarkerTool = Join-Path $relayDir 'scripts\local-relay-marker.mjs'
$localRelayShipped = $false
if ($LocalRelayBuild) {
    $localCurrent = (& node $localMarkerTool --action=current "--marker=$localRelayStatePath" "--hash=$($deployPlan.relay.hash)") -eq 'true'
    $deployPlan.relayChanged = -not $localCurrent
    $deployPlan.deploy = [bool]($deployPlan.relayChanged -or $deployPlan.rendererChanged)
    if ($deployPlan.relayChanged) {
        $relayBinaryDir = Build-LocalRelay (Join-Path $relayDir '.cache\relay-local') $deployPlan.relay.hash
        $localRelayShipped = $true
    }
}
elseif ($deployPlan.relayChanged -or $deployPlan.rendererChanged) {
    $relayBinaryDir = Get-RelayBinaryDir (Join-Path $relayDir '.cache')
}
if ($deployPlan.relayChanged -and -not $relayBinaryDir) {
    $relayDeployed = $false
    Write-Warning ('no successful CI run (mixdogd-build, deploy or linux-desktop-verify) built relay sources ' +
        'equal to this tree whose artifact is still kept (2 days): the relay change is not deployed. Commit and ' +
        'push the relay sources (an uncommitted or unpushed change can never match a run), start ' +
        '"gh workflow run mixdogd-build.yml -f ref=<pushed sha>", wait for it to finish, and deploy again; ' +
        'the renderer is deployed.')
    $deployPlan.relayChanged = $false
    $deployPlan.deploy = [bool]$deployPlan.rendererChanged
}

if ($deployPlan.rendererBuild) {
    Step 'building changed desktop renderer only'
    Push-Location $desktopDir
    try {
        $previousTargets = $env:MIXDOG_ELECTRON_BUILD_TARGETS
        $env:MIXDOG_ELECTRON_BUILD_TARGETS = 'renderer'
        & npx.cmd electron-vite build
        if ($LASTEXITCODE -ne 0) { throw "renderer build exited with $LASTEXITCODE" }
    }
    finally {
        if ($null -eq $previousTargets) {
            Remove-Item Env:MIXDOG_ELECTRON_BUILD_TARGETS -ErrorAction SilentlyContinue
        }
        else {
            $env:MIXDOG_ELECTRON_BUILD_TARGETS = $previousTargets
        }
        Pop-Location
    }
}
elseif ($deployPlan.rendererChanged) {
    Step 'reusing fresh desktop renderer build'
}

if ($deployPlan.stageRenderer) {
    Step 'staging changed web renderer beside the relay'
    npm run stage:web --prefix $relayDir
    if ($LASTEXITCODE -ne 0) { throw "stage:web exited with $LASTEXITCODE" }
}

$vpsDeployScript = {
    param($relayDir, $SshHost, $Domain, $version, $includeRenderer, $desktopVersion, $relayBinaryDir, $uploadRelay, $nativeDir, $planOnly)
    $ErrorActionPreference = 'Stop'
    $tgz = Join-Path $env:TEMP 'mixdog-relay-upload.tgz'
    # The uploaded renderer is installed as an ADDITIONAL release named by the
    # desktop version it was built for; the relay serves each paired desktop the
    # release matching its version. A relay-only deploy uploads no renderer and
    # registers no release.
    $releaseDesktopVersion = if ($includeRenderer) { $desktopVersion } else { '' }
    Remove-Item -LiteralPath $tgz -Force -ErrorAction SilentlyContinue
    try {
        $entries = @('deploy')
        if ($includeRenderer) {
            $cacheDir = Join-Path $relayDir '.cache'
            $baseManifest = Join-Path $cacheDir 'renderer-base-manifest.json'
            $targetManifest = Join-Path $cacheDir 'renderer-manifest.json'
            $deltaDir = Join-Path $cacheDir 'renderer-delta'
            New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
            # The installed manifest is computed by the Linux binary on the box: the
            # uploaded one when this run has it (so a VPS whose installed tree is
            # still Node works), else the installed one.
            $remoteTool = $null
            if ($planOnly) {
                # The installed manifest comes from the box (and the delta from a cargo build): neither belongs to a plan.
                Write-Host '[plan] renderer delta skipped (needs the box); the archive carries the whole renderer'
            }
            elseif ($relayBinaryDir) {
                scp -o BatchMode=yes -q (Join-Path $relayBinaryDir 'mixdog-relay') "${SshHost}:/root/mixdog-relay-tool"
                if ($LASTEXITCODE -ne 0) { throw "renderer manifest tool upload exited with $LASTEXITCODE" }
                ssh -o BatchMode=yes $SshHost 'chmod 0755 /root/mixdog-relay-tool'
                if ($LASTEXITCODE -ne 0) { throw "renderer manifest tool chmod exited with $LASTEXITCODE" }
                $remoteTool = '/root/mixdog-relay-tool'
            }
            else {
                ssh -o BatchMode=yes $SshHost 'test -x /opt/mixdog-relay/mixdog-relay'
                if ($LASTEXITCODE -eq 0) { $remoteTool = '/opt/mixdog-relay/mixdog-relay' }
            }
            if ($remoteTool) {
                $remoteManifest = & ssh -o BatchMode=yes $SshHost `
                    "$remoteTool renderer-delta --action=manifest --root=/opt/mixdog-relay/renderer"
                if ($LASTEXITCODE -ne 0) { throw "remote renderer manifest exited with $LASTEXITCODE" }
                [IO.File]::WriteAllText(
                    $baseManifest,
                    (($remoteManifest -join "`n") + "`n"),
                    [Text.UTF8Encoding]::new($false)
                )
                $deltaResult = & cargo run --release --quiet --manifest-path (Join-Path $nativeDir 'Cargo.toml') `
                    -p mixdog-relay --bin mixdog-relay -- renderer-delta --action=create `
                    "--root=$(Join-Path $relayDir 'renderer')" "--base=$baseManifest" `
                    "--delta=$deltaDir" "--manifest=$targetManifest"
                if ($LASTEXITCODE -ne 0) { throw "renderer delta creation exited with $LASTEXITCODE" }
                Write-Host "renderer delta: $($deltaResult -join '')"
                $entries += @('.cache/renderer-delta', '.cache/renderer-manifest.json')
            }
            else {
                # Nothing on the box can compute the installed manifest: the whole
                # renderer goes up and deploy-release.sh installs it in full.
                $entries += @('renderer')
            }
        }
        $tarArguments = @('-czf', $tgz, '-C', $relayDir) + $entries
        if ($uploadRelay) { $tarArguments += @('-C', $relayBinaryDir, 'mixdog-relay') }
        & tar @tarArguments
        if ($LASTEXITCODE -ne 0) { throw "tar exited with $LASTEXITCODE" }
        if ($planOnly) {
            $listing = @(& tar -tzf $tgz)
            $top = $listing | ForEach-Object { ($_ -split '/')[0] } | Group-Object | ForEach-Object { "$($_.Name) ($($_.Count) entries)" }
            Write-Host "[plan] archive $([math]::Round((Get-Item $tgz).Length / 1MB, 2)) MB: $($top -join ', ')"
            Write-Host "[plan] would scp it to ${SshHost}:/root/relay-upload.tgz and run:"
            Write-Host "[plan]   bash /root/relay-upload/deploy/deploy-release.sh $Domain v$version $releaseDesktopVersion"
            Write-Host "[plan] relay binary in the archive: $([bool]$uploadRelay)"
            return
        }
        scp -o BatchMode=yes -q $tgz "${SshHost}:/root/relay-upload.tgz"
        if ($LASTEXITCODE -ne 0) { throw "scp exited with $LASTEXITCODE" }
        ssh -o BatchMode=yes $SshHost ("rm -rf /root/relay-upload && mkdir -p /root/relay-upload" `
                + " && tar -xzf /root/relay-upload.tgz -C /root/relay-upload" `
                + " && bash /root/relay-upload/deploy/deploy-release.sh $Domain v$version $releaseDesktopVersion")
        if ($LASTEXITCODE -ne 0) { throw "VPS swap exited with $LASTEXITCODE" }
    }
    finally {
        if (-not $planOnly) {
            & ssh -o BatchMode=yes -o ConnectTimeout=10 $SshHost `
                'rm -rf -- /root/relay-upload /root/relay-upload.tgz /root/mixdog-relay-tool' 2>$null
        }
        Remove-Item -LiteralPath $tgz -Force -ErrorAction SilentlyContinue
    }
    $ErrorActionPreference = 'Continue'
    $health = 'no response'
    foreach ($attempt in 1..10) {
        $code = & curl.exe -s -o NUL -w '%{http_code}' --max-time 5 "https://$Domain/healthz" 2>$null
        if ($code) { $health = "HTTP $code" }
        if ($code -eq '200') { break }
        Start-Sleep -Seconds 2
    }
    "[health] https://$Domain/healthz -> $health"
    if ($code -ne '200') { throw "public VPS health check failed: $health" }
}

$uploadJob = $null
$vpsDeploySucceeded = $false
if ($deployPlan.deploy) {
    $version = (Get-Content (Join-Path $relayDir 'package.json') -Raw | ConvertFrom-Json).version
    $vpsDeployArgs = @(
        $relayDir, $SshHost, $Domain, $version, ([bool]$deployPlan.rendererChanged), $desktopVersion,
        $relayBinaryDir, ([bool]$deployPlan.relayChanged), (Join-Path $repo 'native\core'), [bool]$PlanOnly
    )
    if ($FastDirect) {
        Step 'pack + upload + atomic VPS swap (background job)'
        $uploadJob = Start-Job -ScriptBlock $vpsDeployScript -ArgumentList $vpsDeployArgs
    }
    else {
        # VPS-only runs have no local work to overlap. Avoid a second PowerShell
        # process and its serialization overhead.
        Step 'pack + upload + atomic VPS swap'
        & $vpsDeployScript @vpsDeployArgs
        $vpsDeploySucceeded = $true
    }
}
else {
    Step 'VPS inputs unchanged; skipping renderer build, stage, and upload'
}

if ($PlanOnly) {
    Step 'plan only: nothing was sent, no server was contacted, no deploy state was recorded'
    exit 0
}

$devUpdate = Join-Path $desktopDir 'scripts\dev-update-windows.ps1'
$fastBuildFailed = $false
if ($FastDirect) {
    Step 'FastDirect staging while the VPS upload runs'
    & $pwshExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $devUpdate -FastDirect -BuildOnly `
        -Version $desktopVersion
    if ($LASTEXITCODE -ne 0) { $fastBuildFailed = $true }
}

if ($uploadJob) {
    try {
        Receive-Job -Job $uploadJob -Wait -ErrorAction Continue
        if ($uploadJob.State -ne 'Completed') {
            $reason = $uploadJob.ChildJobs[0].JobStateInfo.Reason
            if ($reason) { throw "VPS deploy job failed: $($reason.Message)" }
            throw "VPS deploy job failed with state $($uploadJob.State)"
        }
        $vpsDeploySucceeded = $true
    }
    finally {
        Remove-Job -Job $uploadJob -Force -ErrorAction SilentlyContinue
    }
}
if ($vpsDeploySucceeded) {
    if (-not $relayDeployed) {
        # The relay change was not deployed: the state must not say it was.
        $plan = Get-Content $deployPlanPath -Raw | ConvertFrom-Json
        $previousState = if (Test-Path $deployStatePath) { Get-Content $deployStatePath -Raw | ConvertFrom-Json } else { $null }
        $plan.relay.hash = if ($previousState) { [string]$previousState.relayHash } else { '' }
        [IO.File]::WriteAllText($deployPlanPath, ($plan | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    }
    if ($LocalRelayBuild) {
        # The box now runs a local build (this run's, or an earlier one this run found current): the state must not
        # say a CI-equal relay is installed.
        $plan = Get-Content $deployPlanPath -Raw | ConvertFrom-Json
        $plan.relay.hash = ''
        [IO.File]::WriteAllText($deployPlanPath, ($plan | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    }
    & node $deployPlanner --action=commit "--state=$deployStatePath" "--plan=$deployPlanPath"
    if ($LASTEXITCODE -ne 0) { throw "live deploy state commit exited with $LASTEXITCODE" }
    if ($localRelayShipped) {
        $built = Get-Content (Join-Path $relayBinaryDir 'relay-build.json') -Raw | ConvertFrom-Json
        & node $localMarkerTool --action=record "--marker=$localRelayStatePath" "--hash=$($built.sourceFingerprint)" `
            "--binarySha256=$($built.binarySha256)" "--sourceCommit=$($built.sourceCommit)" "--dirty=$($built.dirty.ToString().ToLower())"
        if ($LASTEXITCODE -ne 0) { throw "recording the local relay marker exited with $LASTEXITCODE" }
    }
    elseif (-not $LocalRelayBuild -and $deployPlan.relayChanged) {
        # A CI relay replaced whatever was installed: the marker must not claim the local build still is.
        & node $localMarkerTool --action=clear "--marker=$localRelayStatePath"
        if ($LASTEXITCODE -ne 0) { throw "clearing the local relay marker exited with $LASTEXITCODE" }
    }
}
Write-Host ''
if ($fastBuildFailed) { exit 1 }

if ($FastDirect) {
    Step 'FastDirect installed-app swap (app restarts once)'
    & $pwshExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $devUpdate -FastDirect -SkipBuild `
        -Version $desktopVersion
    $localExitCode = $LASTEXITCODE
    if ($localExitCode -eq 0) { Step 'FastDirect swap handed off successfully' }
    exit $localExitCode
}
Step 'VPS deployment workflow complete'
