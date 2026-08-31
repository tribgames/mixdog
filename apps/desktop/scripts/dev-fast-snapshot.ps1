<#
  FastDirect against a frozen copy of the working tree.

  dev-fast-direct fingerprints its inputs, builds for several minutes, then
  refuses to install if those inputs moved meanwhile — the build would otherwise
  mix files from before and after the edit. With more than one session editing
  the repository the check can never pass: the build takes ~5 minutes and edits
  land every minute or two.

  This wrapper removes the race instead of tolerating it. `git stash create`
  records the working tree (uncommitted changes included) as a commit object
  WITHOUT touching the tree itself, a temporary worktree checks that commit out,
  and the deploy runs there. Later edits cannot reach the frozen copy, so the
  build is exactly one point in time and the assertion passes on the first try.

  The install target and the FastDirect caches stay with the real checkout, so
  incremental state carries across runs instead of rebuilding from scratch.
  node_modules is linked rather than installed: a junction costs nothing and the
  snapshot's dependency tree is identical by construction.

  The worktree is always removed, success or failure.
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
$linked = [Collections.Generic.List[string]]::new()

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }

function New-DirectoryLink {
  param([string]$Link, [string]$Target)
  if (-not (Test-Path -LiteralPath $Target)) { return }
  New-Item -ItemType Junction -Path $Link -Target $Target -ErrorAction Stop | Out-Null
  [void]$linked.Add($Link)
}

# The ONE way a snapshot worktree may be deleted. node_modules inside it is a
# junction to the real dependency tree, and both `git worktree remove` and a
# robocopy mirror will walk through a live junction and empty the TARGET — the
# actual checkout's dependencies — instead of removing the link. Every deletion
# path therefore severs the links first, by scanning the tree rather than
# trusting a caller's bookkeeping, so a worktree orphaned by a crash (or by an
# app restart that skipped `finally`) is just as safe to clean up.
function Remove-SnapshotWorktree {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return }
  $leaf = Split-Path -Leaf $Path
  if ($leaf -notlike 'mxsnap-*') { throw "Refusing to delete $Path : not a snapshot worktree" }

  foreach ($entry in Get-ChildItem -LiteralPath $Path -Recurse -Force -Directory -ErrorAction SilentlyContinue) {
    if ($entry.LinkType) { try { $entry.Delete() } catch {} }
  }
  # Both calls below are expected to fail sometimes — a directory that git never
  # registered, a path it considers dirty. Under ErrorActionPreference='Stop' a
  # native command's stderr becomes a terminating error, which would abandon the
  # cleanup halfway and leave the tree behind, so they run detached from it.
  try {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & git -C $repoRoot worktree remove --force $Path 2>&1 | Out-Null
  } catch {
  } finally { $ErrorActionPreference = $previous }
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
    } catch {
    } finally { $ErrorActionPreference = $previous }
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
  }
  try {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & git -C $repoRoot worktree prune 2>&1 | Out-Null
  } catch {
  } finally { $ErrorActionPreference = $previous }
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
  } finally {
    $ErrorActionPreference = $previous
    Pop-Location
  }
  if ($code -ne 0) { throw "npm ci failed in $Root (exit $code)" }
  if (-not (Test-DependencyTree $Root)) { throw "npm ci left $Root without dependencies" }
  Write-Host "  restored $Label dependencies"
}

function Remove-StaleSnapshots {
  param([string]$Except = '')
  $stale = @(
    Get-ChildItem $env:TEMP -Directory -Filter 'mxsnap-*' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -ne $Except }
  )
  if (-not $stale) { return 0 }
  foreach ($dir in $stale) { Remove-SnapshotWorktree $dir.FullName }
  return $stale.Count
}

# This deploy ends by restarting the app, which kills the script before its
# finally block runs — so the worktree from the PREVIOUS run is still on disk.
# Sweeping it here keeps the whole flow to one command: there is no separate
# cleanup step to remember, and no way to reach for the unsafe manual one.
if ($CleanupOnly) {
  $removed = Remove-StaleSnapshots
  Write-Step $(if ($removed) { "removed $removed snapshot worktree(s)" } else { 'no snapshot worktrees to remove' })
  exit 0
}

try {
  Push-Location $repoRoot

  $swept = Remove-StaleSnapshots
  if ($swept) { Write-Step "swept $swept snapshot worktree(s) left by an earlier restart" }

  Restore-DependencyTree $repoRoot 'root'
  Restore-DependencyTree $desktopDir 'desktop'

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
    try {
      $env:GIT_INDEX_FILE = $tempIndex
      & git read-tree HEAD
      if ($LASTEXITCODE -ne 0) { throw "git read-tree exited with $LASTEXITCODE" }
      & git add -A
      if ($LASTEXITCODE -ne 0) { throw "git add exited with $LASTEXITCODE" }
      $tree = (& git write-tree).Trim()
      if ($LASTEXITCODE -ne 0) { throw "git write-tree exited with $LASTEXITCODE" }
      $snapshot = (& git commit-tree $tree -p HEAD -m 'fastdirect snapshot').Trim()
      if ($LASTEXITCODE -ne 0) { throw "git commit-tree exited with $LASTEXITCODE" }
    } finally {
      $env:GIT_INDEX_FILE = $null
      Remove-Item -LiteralPath $tempIndex -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  snapshot commit $($snapshot.Substring(0,8)) (uncommitted and untracked files included)"

    Write-Step 'checking the snapshot out into a temporary worktree'
    & git worktree add --detach $snapshotRoot $snapshot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git worktree add exited with $LASTEXITCODE" }

    Write-Step 'linking dependency trees'
    New-DirectoryLink (Join-Path $snapshotRoot 'node_modules') (Join-Path $repoRoot 'node_modules')
    New-DirectoryLink (Join-Path $snapshotRoot 'apps\desktop\node_modules') (Join-Path $desktopDir 'node_modules')
    # `out/` is deliberately NOT linked here. electron-builder collects the app
    # files itself and walks past a junction without descending into it, so a
    # linked build directory produced an app.asar with no out/main/index.js in
    # it. The snapshot starts with no build output at all, and the deploy's own
    # missing-artifact rule (dev-update-windows.ps1) rebuilds whatever the
    # incremental plan would otherwise have skipped.

    Write-Step 'checking the frozen copy compiles'
    Push-Location (Join-Path $snapshotRoot 'apps\desktop')
    try {
      & npm.cmd run typecheck:node 2>&1 | Out-Null
      $compiles = $LASTEXITCODE -eq 0
    } finally { Pop-Location }
    if ($compiles) { break }
    if ($attempt -ge 3) {
      throw 'The working tree did not compile in three snapshots; let the in-flight edit finish and retry.'
    }
    Write-Host '  frozen copy does not compile (an edit was mid-save); retaking in 20s' -ForegroundColor Yellow
    $linked.Clear()
    Remove-SnapshotWorktree $snapshotRoot
    Start-Sleep -Seconds 20
  }

  # Caches and the install target belong to the real checkout: the snapshot is
  # thrown away, and a per-run cache would force a full rebuild every time.
  $planPath = Join-Path $desktopDir '.cache\dev-fast-direct-plan.json'
  $statePath = Join-Path $desktopDir '.cache\dev-fast-direct-state.json'
  $artifactDir = Join-Path $desktopDir '.cache\dev-fast-direct-artifact'

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
    } catch { continue }
    $status = [string]$receipt.status
    if ($status -eq 'completed') { Write-Host '  worker completed'; break }
    if ($status -eq 'failed') { throw "FastDirect worker failed: $($receipt.detail)" }
  }
  if ($status -ne 'completed') { throw "FastDirect worker did not finish within 15 minutes (last status: $status)" }
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $snapshotRoot) { Write-Step 'removing the snapshot worktree' }
  Remove-SnapshotWorktree $snapshotRoot
}
