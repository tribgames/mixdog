<#
  FastDirect against a frozen copy of the working tree.

  dev-fast-direct fingerprints its inputs, builds for several minutes, then
  refuses to install if those inputs moved meanwhile — the build would otherwise
  mix files from before and after the edit. With more than one session editing
  the repository the check can never pass: the build takes ~5 minutes and edits
  land every minute or two.

  This wrapper removes the race instead of tolerating it. A throwaway index
  records the working tree (uncommitted and untracked changes included) as a
  commit object WITHOUT touching the tree itself, a temporary worktree checks
  that commit out, and the deploy runs there. Later edits cannot reach the frozen copy, so the
  build is exactly one point in time and the assertion passes on the first try.

  The install target and the FastDirect caches stay with the real checkout, so
  incremental state carries across runs instead of rebuilding from scratch.
  node_modules is linked rather than installed: a junction costs nothing and the
  snapshot's dependency tree is identical by construction.

  The worktree is removed, success or failure, unless a link in it cannot be
  severed first: then it is kept and named, never deleted through the link.
#>
[CmdletBinding()]
param(
    [switch]$NoLaunch,
    [switch]$KeepDaemon,
    [switch]$CleanupOnly,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\mixdog-desktop')
)

$ErrorActionPreference = 'Stop'
$desktopDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$repoRoot = Resolve-Path (Join-Path $desktopDir '../..')
# Short on purpose: the tree carries paths like node_modules/@homebridge/
# node-pty-prebuilt-multiarch/third_party/conpty/... and a long prefix pushes
# them past the 260-character limit that git's own delete still honours.
$snapshotRoot = Join-Path $env:TEMP ("mxsnap-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$deployStartedAtUtc = [DateTime]::UtcNow
$timings = [ordered]@{}

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
# Windows PowerShell wraps Write-Warning at the console width when its output
# is redirected, breaking a long snapshot path in two; write the line whole.
function Write-SnapshotWarning { param([string]$Text) [Console]::Error.WriteLine("WARNING: $Text") }
function Save-Timing {
    param([string]$Name, [Diagnostics.Stopwatch]$Stopwatch)
    $timings[$Name] = [math]::Round($Stopwatch.Elapsed.TotalMilliseconds)
}

function New-DirectoryLink {
    param([string]$Link, [string]$Target)
    if (-not (Test-Path -LiteralPath $Target)) { return }
    New-Item -ItemType Junction -Path $Link -Target $Target -ErrorAction Stop | Out-Null
}

# The ONE way a snapshot worktree may be deleted. node_modules inside it is a
# junction to the real dependency tree, and both `git worktree remove` and a
# robocopy mirror will walk through a live junction and empty the TARGET — the
# actual checkout's dependencies — instead of removing the link. Every deletion
# path therefore severs the links first, by scanning the tree rather than
# trusting a caller's bookkeeping, so a worktree orphaned by a crash (or by an
# app restart that skipped `finally`) is just as safe to clean up. A link
# that cannot be severed (or a folder that cannot be searched for links)
# skips that snapshot: nothing of it is deleted, a warning names it, and the
# function returns $false. $true: removed, or nothing was there.
function Remove-SnapshotWorktree {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $true }
    $leaf = Split-Path -Leaf $Path
    if ($leaf -notlike 'mxsnap-*') { throw "Refusing to delete $Path : not a snapshot worktree" }

    $links = Find-DirectoryLinks $Path
    if ($null -eq $links) {
        Write-SnapshotWarning "Skipped $Path : a folder in it could not be searched for links; nothing was deleted."
        return $false
    }
    $stuck = @(
        foreach ($link in $links) {
            try { [IO.Directory]::Delete($link) } catch {}
            if (Test-LinkPresent $link) { $link }
        }
    )
    if ($stuck.Count -gt 0) {
        Write-SnapshotWarning ("Skipped $Path : could not unlink " + ($stuck -join ', ') +
            '; nothing was deleted. Remove those links (never their targets), then run -CleanupOnly again.')
        return $false
    }
    $left = Find-DirectoryLinks $Path
    if ($null -eq $left -or $left.Count -gt 0) {
        Write-SnapshotWarning "Skipped $Path : links are still present after unlinking; nothing was deleted."
        return $false
    }
    # Both calls below are expected to fail sometimes — a directory that git never
    # registered, a path it considers dirty. Under ErrorActionPreference='Stop' a
    # native command's stderr becomes a terminating error, which would abandon the
    # cleanup halfway and leave the tree behind, so they run detached from it.
    try {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & git -C $repoRoot worktree remove --force $Path 2>&1 | Out-Null
    }
    catch {
    }
    finally { $ErrorActionPreference = $previous }
    if (Test-Path -LiteralPath $Path) {
        # git gave up on a long path; robocopy mirrors an empty directory over the
        # tree, which uses the wide APIs and has no such limit. /XJ is belt and
        # braces now that the links are already gone.
        $empty = Join-Path $env:TEMP ("mxsnap-empty-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
        New-Item -ItemType Directory -Path $empty -Force | Out-Null
        try {
            $previous = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            # robocopy reports success with exit codes 0-7, which PowerShell would
            # otherwise treat as failure.
            & robocopy $empty $Path /MIR /XJ /NFL /NDL /NJH /NJS /NP 2>&1 | Out-Null
        }
        catch {
        }
        finally { $ErrorActionPreference = $previous }
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
    }
    try {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & git -C $repoRoot worktree prune 2>&1 | Out-Null
    }
    catch {
    }
    finally { $ErrorActionPreference = $previous }
    return $true
}

# Every directory link (junction, directory symlink) under $Root, found
# without ever entering one: a link is listed, never walked, so the real
# dependency tree behind node_modules is never visited. $null when a folder
# cannot be read: then the tree cannot be proven link-free.
function Find-DirectoryLinks {
    param([string]$Root)
    $links = New-Object System.Collections.Generic.List[string]
    $pending = New-Object System.Collections.Generic.Stack[string]
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $dir = $pending.Pop()
        try {
            foreach ($child in [IO.Directory]::GetDirectories($dir)) {
                if ([IO.File]::GetAttributes($child) -band [IO.FileAttributes]::ReparsePoint) { $links.Add($child) }
                else { $pending.Push($child) }
            }
        }
        catch { return $null }
    }
    return , $links.ToArray()
}

# Whether the link itself is still there; a dangling junction counts, which
# Test-Path (it follows the link) would miss.
function Test-LinkPresent {
    param([string]$Path)
    try {
        [void][IO.File]::GetAttributes($Path)
        return $true
    }
    catch { return $false }
}

# A dependency tree can exist as a directory and still be useless: the junction
# accident this script now guards against emptied both trees without removing
# them. The snapshot links to these, so an empty one would surface much later as
# "the frozen copy does not compile" and burn three retries on a cause that has
# nothing to do with a mid-save edit.
function Test-DependencyTree {
    param([string]$Root)
    $modules = Join-Path $Root 'node_modules'
    if (-not (Test-Path -LiteralPath $modules)) { return $false }
    return @(Get-ChildItem -LiteralPath $modules -Force -ErrorAction SilentlyContinue).Count -gt 0
}

function Restore-DependencyTree {
    param([string]$Root, [string]$Label)
    if (Test-DependencyTree $Root) { return }
    Write-Step "$Label dependencies are missing; running npm ci"
    Push-Location $Root
    $code = 1
    try {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & npm.cmd ci --prefer-offline --no-audit --no-fund 2>&1 | Out-Null
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
        Pop-Location
    }
    if ($code -ne 0) { throw "npm ci failed in $Root (exit $code)" }
    if (-not (Test-DependencyTree $Root)) { throw "npm ci left $Root without dependencies" }
    Write-Host "  restored $Label dependencies"
}

# Every snapshot an earlier run left. $env:TEMP differs between runs (a session
# scratch folder, the user's temp), so the folder is no guide: the repository's
# own registrations name every snapshot worktree wherever it was made, and
# this run's TEMP adds the ones git no longer knows.
function Get-SnapshotLeftovers {
    $listing = @()
    try {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $listing = @(& git -C $repoRoot worktree list --porcelain 2>$null)
    }
    catch {
    }
    finally { $ErrorActionPreference = $previous }
    $paths = @(
        foreach ($line in $listing) {
            if ($line -like 'worktree *') { $line.Substring(9) -replace '/', '\' }
        }
        Get-ChildItem $env:TEMP -Directory -Filter 'mxsnap-*' -ErrorAction SilentlyContinue |
            ForEach-Object { $_.FullName }
    )
    $seen = @{}
    foreach ($path in $paths) {
        if ((Split-Path -Leaf $path) -notlike 'mxsnap-*') { continue }
        $key = $path.TrimEnd('\').ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $path
    }
}

function Remove-StaleSnapshots {
    param([string]$Except = '')
    $exceptKey = $Except.TrimEnd('\').ToLowerInvariant()
    $stale = @(Get-SnapshotLeftovers | Where-Object { $_.TrimEnd('\').ToLowerInvariant() -ne $exceptKey })
    # Remove-SnapshotWorktree severs the junctions into the real checkout first
    # (and skips a snapshot it cannot sever); a registration whose folder is
    # already gone is dropped by the prune.
    $result = [pscustomobject]@{ Removed = 0; Skipped = 0 }
    foreach ($path in $stale) {
        if (Remove-SnapshotWorktree $path) { $result.Removed += 1 } else { $result.Skipped += 1 }
    }
    if ($stale) {
        try {
            $previous = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            & git -C $repoRoot worktree prune 2>&1 | Out-Null
        }
        catch {
        }
        finally { $ErrorActionPreference = $previous }
    }
    return $result
}

# This deploy ends by restarting the app, which kills the script before its
# finally block runs — so the worktree from the PREVIOUS run is still on disk.
# Sweeping it here keeps the whole flow to one command: there is no separate
# cleanup step to remember, and no way to reach for the unsafe manual one.
if ($CleanupOnly) {
    $swept = Remove-StaleSnapshots
    Write-Step $(if ($swept.Removed) { "removed $($swept.Removed) snapshot worktree(s)" } else { 'no snapshot worktrees removed' })
    # A skipped snapshot (its links could not be severed) was named above; it is still on disk.
    if ($swept.Skipped) {
        Write-Host "  skipped $($swept.Skipped) snapshot worktree(s); see the warnings above" -ForegroundColor Yellow
        exit 1
    }
    exit 0
}

$failure = $null
try {
    Push-Location $repoRoot

    $stepTimer = [Diagnostics.Stopwatch]::StartNew()
    $swept = Remove-StaleSnapshots
    Save-Timing 'staleSnapshotCleanupMs' $stepTimer
    if ($swept.Removed) { Write-Step "swept $($swept.Removed) snapshot worktree(s) left by an earlier restart" }
    if ($swept.Skipped) { Write-Host "  kept $($swept.Skipped) snapshot worktree(s) whose links could not be severed" -ForegroundColor Yellow }

    Restore-DependencyTree $repoRoot 'root'
    Restore-DependencyTree $desktopDir 'desktop'

    # The installed app runs the native tools its manifests pin (downloaded
    # releases), never target/release, so committed native changes that were
    # not released yet are silently absent from this build. Say so (stdout:
    # native stderr would be a terminating error here; informational only).
    try { & node (Join-Path $repoRoot 'scripts\native-release-status.mjs') --warn-dev } catch {}

    # A commit object for the current tree, index included. It is unreachable
    # until the worktree references it, and nothing in the real checkout moves.
    #
    # Freezing protects the build from edits that land while it runs, but it
    # preserves the instant it was taken exactly — including a file caught
    # half-written by an editor. So the frozen copy is type-checked before the
    # deploy commits to it, and a broken instant is simply re-taken.
    $attempt = 0
    while ($true) {
        $attempt += 1
        Write-Step "freezing the working tree (attempt $attempt)"
        # `git stash create` would be the obvious tool but it records only TRACKED
        # changes: a module another session just added is untracked, so the snapshot
        # would drop it and every import of it would fail to resolve. Staging into a
        # throwaway index instead captures the tree as it actually is — .gitignore
        # still applies, so node_modules and build output stay out — and neither the
        # real index nor the working tree is touched.
        $tempIndex = Join-Path $env:TEMP ("mxsnap-index-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        $snapshot = ''
        $stepTimer = [Diagnostics.Stopwatch]::StartNew()
        try {
            $env:GIT_INDEX_FILE = $tempIndex
            & git read-tree HEAD
            if ($LASTEXITCODE -ne 0) { throw "git read-tree exited with $LASTEXITCODE" }
            $snapshotPaths = @(
                '.npmignore', 'package.json', 'package-lock.json', 'README.md', 'NOTICE.md',
                'LICENSE', 'LICENSES', 'scripts', 'src', 'vendor', 'changelog',
                'native/mixdog-browser-import', 'native/mixdog-secure-desktop', 'apps/desktop', 'apps/relay'
            )
            # Optional package roots are not present in every checkout. Keep a path
            # when it exists now or was tracked in HEAD (so deletions still enter the
            # snapshot), and avoid making `git add` fail on an unknown pathspec.
            $snapshotPaths = @($snapshotPaths | Where-Object {
                    (Test-Path -LiteralPath (Join-Path $repoRoot $_)) -or
                    @(& git ls-files -- $_).Count -gt 0
                })
            & git -c core.safecrlf=false add -A -- @snapshotPaths
            if ($LASTEXITCODE -ne 0) { throw "git add exited with $LASTEXITCODE" }
            $tree = (& git write-tree).Trim()
            if ($LASTEXITCODE -ne 0) { throw "git write-tree exited with $LASTEXITCODE" }
            $snapshot = (& git commit-tree $tree -p HEAD -m 'fastdirect snapshot').Trim()
            if ($LASTEXITCODE -ne 0) { throw "git commit-tree exited with $LASTEXITCODE" }
        }
        finally {
            $env:GIT_INDEX_FILE = $null
            Remove-Item -LiteralPath $tempIndex -Force -ErrorAction SilentlyContinue
        }
        Save-Timing 'freezeMs' $stepTimer
        Write-Host "  snapshot commit $($snapshot.Substring(0,8)) (uncommitted and untracked files included)"

        Write-Step 'checking the snapshot out into a temporary worktree'
        $stepTimer = [Diagnostics.Stopwatch]::StartNew()
        & git worktree add --detach --no-checkout $snapshotRoot $snapshot | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git worktree add exited with $LASTEXITCODE" }
        & git -C $snapshotRoot sparse-checkout set --cone `
            apps/desktop apps/relay src scripts vendor native/mixdog-browser-import native/mixdog-secure-desktop LICENSES changelog | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git sparse-checkout exited with $LASTEXITCODE" }
        # `worktree add --no-checkout` leaves the directory empty. Defining the
        # sparse paths configures the index but does not materialize HEAD on every
        # Git version, so explicitly populate the frozen tree before linking deps.
        & git -C $snapshotRoot checkout --force HEAD | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git checkout exited with $LASTEXITCODE" }
        Save-Timing 'checkoutMs' $stepTimer

        Write-Step 'linking dependency trees'
        $stepTimer = [Diagnostics.Stopwatch]::StartNew()
        $realDesktopCache = Join-Path $desktopDir '.cache'
        New-Item -ItemType Directory -Path $realDesktopCache -Force | Out-Null
        New-DirectoryLink (Join-Path $snapshotRoot 'node_modules') (Join-Path $repoRoot 'node_modules')
        New-DirectoryLink (Join-Path $snapshotRoot 'apps\desktop\node_modules') (Join-Path $desktopDir 'node_modules')
        New-DirectoryLink (Join-Path $snapshotRoot 'apps\desktop\.cache') $realDesktopCache
        Save-Timing 'linkMs' $stepTimer
        # `out/` is deliberately NOT linked here. electron-builder collects the app
        # files itself and walks past a junction without descending into it, so a
        # linked build directory produced an app.asar with no out/main/index.js in
        # it. The snapshot starts with no build output at all, and the deploy's own
        # missing-artifact rule (dev-update-windows.ps1) rebuilds whatever the
        # incremental plan would otherwise have skipped.

        Write-Step 'checking the frozen copy compiles'
        $stepTimer = [Diagnostics.Stopwatch]::StartNew()
        Push-Location (Join-Path $snapshotRoot 'apps\desktop')
        try {
            $typecheckOutput = @(& npm.cmd run typecheck:node 2>&1)
            $compiles = $LASTEXITCODE -eq 0
        }
        finally { Pop-Location }
        Save-Timing 'snapshotTypecheckMs' $stepTimer
        if ($compiles) { break }
        if ($attempt -ge 3) {
            $typecheckOutput | ForEach-Object { Write-Host $_ -ForegroundColor Red }
            throw 'The working tree did not compile in three snapshots; let the in-flight edit finish and retry.'
        }
        Write-Host '  frozen copy does not compile (an edit was mid-save); retaking in 20s' -ForegroundColor Yellow
        if (-not (Remove-SnapshotWorktree $snapshotRoot)) {
            throw "The snapshot $snapshotRoot could not be removed safely before retaking it."
        }
        Start-Sleep -Seconds 20
    }

    # Caches and the install target belong to the real checkout: the snapshot is
    # thrown away, and a per-run cache would force a full rebuild every time.
    $planPath = Join-Path $desktopDir '.cache\dev-fast-direct-plan.json'
    $statePath = Join-Path $desktopDir '.cache\dev-fast-direct-state.json'
    $artifactDir = Join-Path $desktopDir '.cache\dev-fast-direct-artifact'

    # electron-builder 26 collects production modules through `npm list`, and
    # npm's Arborist reports hoisted transitive packages (node-addon-api,
    # prebuild-install, graceful-fs, …) as missing/extraneous when node_modules
    # is a junction — which the snapshot's is. The complete win-unpacked
    # fallback then packs an app.asar without them and the closure guard
    # refuses it. electron-builder honours a `packageManager` field ahead of
    # lock-file detection, and `traversal` selects its file-system collector,
    # which resolves straight through the junction. Only the frozen manifest is
    # patched; it is thrown away with the snapshot and npm ignores the field.
    Write-Step 'selecting the traversal module collector for the frozen manifest'
    $frozenManifest = Join-Path $snapshotRoot 'apps\desktop\package.json'
    $manifestText = [IO.File]::ReadAllText($frozenManifest)
    if ($manifestText -notmatch '"packageManager"') {
        $manifestText = $manifestText -replace '^\{', "{`n  `"packageManager`": `"traversal@0.0.0`","
        [IO.File]::WriteAllText($frozenManifest, $manifestText, [Text.UTF8Encoding]::new($false))
    }

    Write-Step 'deploying from the snapshot'
    $deploy = Join-Path $snapshotRoot 'apps\desktop\scripts\dev-update-windows.ps1'
    # -File passes each token verbatim, so a bound parameter needs its value as a
    # separate argument; `-Name=value` arrives as one unknown parameter name.
    $arguments = @(
        '-FastDirect',
        '-InstallDir', $InstallDir,
        '-FastPlanPath', $planPath,
        '-FastStatePath', $statePath,
        '-FastArtifactDir', $artifactDir
    )
    if ($NoLaunch) { $arguments += '-NoLaunch' }
    if ($KeepDaemon) { $arguments += '-KeepDaemon' }
    # The deploy hands the install to a DETACHED worker and returns immediately.
    # That worker still reads the snapshot, so the worktree may only be removed
    # once it reports a terminal status — otherwise it loses its own source mid
    # flight and fails the very assertion this wrapper exists to satisfy.
    $receiptPath = Join-Path $env:USERPROFILE '.mixdog\data\dev-fast-deploy.json'
    Remove-Item -LiteralPath $receiptPath -Force -ErrorAction SilentlyContinue
    $timings['snapshotPreparationMs'] = [math]::Round(
        ([DateTime]::UtcNow - $deployStartedAtUtc).TotalMilliseconds
    )
    $env:MIXDOG_FASTDIRECT_STARTED_AT = $deployStartedAtUtc.ToString('o')
    $env:MIXDOG_FASTDIRECT_SNAPSHOT_TIMINGS = ($timings | ConvertTo-Json -Compress)
    $env:MIXDOG_RUNTIME_DEPENDENCY_CACHE = Join-Path $realDesktopCache 'runtime-dependencies\win32-x64'
    $env:MIXDOG_RUNTIME_NPM_CACHE = Join-Path $realDesktopCache 'runtime-npm-cache'
    # The snapshot is a detached commit whose parent is this checkout's HEAD, so
    # the deploy checks this checkout's branch against its upstream.
    $env:MIXDOG_FASTDIRECT_SOURCE_ROOT = [string]$repoRoot
    & powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $deploy @arguments
    if ($LASTEXITCODE -ne 0) { throw "FastDirect deploy exited with $LASTEXITCODE" }

    Write-Step 'waiting for the detached install worker'
    $deadline = (Get-Date).AddMinutes(15)
    $status = ''
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (-not (Test-Path -LiteralPath $receiptPath)) { continue }
        try {
            $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        }
        catch { continue }
        $status = [string]$receipt.status
        if ($status -eq 'completed') { Write-Host '  worker completed'; break }
        if ($status -eq 'failed') { throw "FastDirect worker failed: $($receipt.detail)" }
    }
    if ($status -ne 'completed') { throw "FastDirect worker did not finish within 15 minutes (last status: $status)" }
}
catch {
    $failure = $_
}
finally {
    Pop-Location -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $snapshotRoot) { Write-Step 'removing the snapshot worktree' }
    # A skip warns by itself; the next run's sweep tries again.
    [void](Remove-SnapshotWorktree $snapshotRoot)
}
if ($failure) {
    Write-Error $failure -ErrorAction Continue
    exit 1
}
