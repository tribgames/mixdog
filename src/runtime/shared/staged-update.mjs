/**
 * staged-update.mjs — staged background self-update for the globally-installed
 * `mixdog` CLI, replacing the old shutdown-time `npm install -g mixdog@latest`.
 *
 * The problem with installing at shutdown (or while live) is that
 * `npm install -g` overwrites the very .mjs files the running node process has
 * loaded → Windows TAR_ENTRY_ERROR file-locks / ENOENT for anything importing
 * mid-install. This module splits the update into two phases that never touch
 * files a live session holds:
 *
 *   1. STAGE (background, during a live session): a hidden, shell-less child
 *      runs `npm install mixdog@<ver> --prefix <stagingDir>` into a private
 *      per-version dir under ~/.mixdog/data/staging/<ver>, relocates the
 *      installed package into a SELF-CONTAINED `<stagingDir>/mixdog` (its
 *      hoisted deps nested underneath), verifies the staged package.json
 *      version, and only then writes a completion marker. The global npm dir
 *      is never touched here.
 *
 *   2. SWAP (cli.mjs, pre-import, next clean launch): if a completed staged
 *      version newer than the running one exists AND no other live mixdog
 *      session is running, the global package dir (`node_modules/mixdog`) is
 *      atomically renamed aside (backup) and the staged dir renamed into its
 *      place — bin shims in the parent prefix are untouched. Any failure
 *      (EBUSY/EPERM/EACCES, non-writable global) aborts silently and the
 *      current version runs; the swap simply retries next launch.
 *
 * Everything here is best-effort: no path in this module may ever block or
 * break launch/teardown.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync,
  readdirSync, unlinkSync, openSync, writeSync, closeSync, statSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolvePluginData } from './plugin-paths.mjs';
import { detachedSpawnOpts, hiddenSpawnOpts } from './spawn-flags.mjs';
import { renameWithRetrySync } from './atomic-file.mjs';
import {
  isDevInstall, localPackageVersion, compareSemver, isNewerVersion,
  npmCliJsPath, UPDATE_PACKAGE_NAME as PACKAGE_NAME,
} from './update-checker.mjs';

const _MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// Package root = two levels up from src/runtime/shared → src/.. (the mixdog
// package dir, i.e. <prefix>/node_modules/mixdog for a global install).
function packageRoot() {
  return join(_MODULE_DIR, '..', '..', '..');
}

const MARKER_NAME = '.staged-complete.json';
// Name of the self-contained package dir inside a staging version folder.
const PKG_SUBDIR = 'mixdog';
const STALE_INPROGRESS_MS = 10 * 60 * 1000;

function stagingRootDir() {
  return join(resolvePluginData(), 'staging');
}

function liveSessionsDir() {
  return join(resolvePluginData(), 'live-sessions');
}

function rmDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not signalable → alive; ESRCH = gone.
    return err?.code === 'EPERM';
  }
}

function sleepSync(ms) {
  const dur = Math.max(1, Number(ms) || 1);
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, dur);
  } catch {
    const end = Date.now() + dur;
    while (Date.now() < end) { /* spin fallback */ }
  }
}

// ── Live-session refcount (pid files) ─────────────────────────────────────
// Each runtime registers a `<pid>.pid` file on boot and removes it on close.
// The swap consults these to skip while another mixdog is running. Liveness is
// a single process.kill(pid,0) per stale candidate (no process-table scan);
// dead pid files are reaped opportunistically so a crashed session never
// wedges updates forever.
let _exitHooked = false;
function selfPidFile() {
  return join(liveSessionsDir(), `${process.pid}.pid`);
}

export function registerLiveSession() {
  try {
    const dir = liveSessionsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(selfPidFile(), `${process.pid} ${Date.now()}\n`, 'utf8');
    if (!_exitHooked) {
      _exitHooked = true;
      try { process.on('exit', unregisterLiveSession); } catch { /* ignore */ }
    }
  } catch { /* best-effort: liveness tracking is advisory */ }
}

export function unregisterLiveSession() {
  try { unlinkSync(selfPidFile()); } catch { /* already gone */ }
}

function otherLiveSessionExists() {
  let entries;
  try { entries = readdirSync(liveSessionsDir()); } catch { return false; }
  let alive = false;
  for (const name of entries) {
    if (!name.endsWith('.pid')) continue;
    const pid = Number.parseInt(name.slice(0, -4), 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid === process.pid) continue;
    if (pidAlive(pid)) {
      alive = true;
    } else {
      try { unlinkSync(join(liveSessionsDir(), name)); } catch { /* stale reap best-effort */ }
    }
  }
  return alive;
}

// ── Staging (background npm install into a private per-version dir) ────────
function markerPath(verDir) {
  return join(verDir, MARKER_NAME);
}

export function isStagedComplete(version) {
  const v = String(version || '').trim();
  if (!v) return false;
  const verDir = join(stagingRootDir(), v);
  try {
    const m = JSON.parse(readFileSync(markerPath(verDir), 'utf8'));
    if (!m || m.version !== v) return false;
    const pkgDir = m.pkgDir || join(verDir, PKG_SUBDIR);
    return existsSync(join(pkgDir, 'package.json')) && existsSync(join(pkgDir, 'src', 'cli.mjs'));
  } catch {
    return false;
  }
}

function inProgressLock(verDir) {
  return join(verDir, '.staging.lock');
}

// Try to claim the staging lock for verDir. Returns true if claimed (caller
// must release), false if another live worker holds a fresh lock.
function claimStagingLock(verDir) {
  const lock = inProgressLock(verDir);
  mkdirSync(verDir, { recursive: true });
  const write = () => {
    const fd = openSync(lock, 'wx');
    try { writeSync(fd, `${process.pid} ${Date.now()}`); } finally { closeSync(fd); }
  };
  try { write(); return true; } catch (err) {
    if (err?.code !== 'EEXIST') return false;
    // Existing lock: steal only if stale (dead owner or old mtime).
    let owner = 0; let ageMs = Infinity;
    try { owner = Number.parseInt(String(readFileSync(lock, 'utf8')).trim().split(/\s+/)[0], 10); } catch {}
    try { ageMs = Date.now() - statSync(lock).mtimeMs; } catch {}
    if (pidAlive(owner) && ageMs < STALE_INPROGRESS_MS) return false;
    try { unlinkSync(lock); } catch {}
    try { write(); return true; } catch { return false; }
  }
}

function releaseStagingLock(verDir) {
  try { unlinkSync(inProgressLock(verDir)); } catch { /* best-effort */ }
}

/**
 * runStagedInstall(version) — perform the full staging install for one version
 * into ~/.mixdog/data/staging/<version>. Runs to completion (awaits the npm
 * child), relocates deps under a self-contained `mixdog/` dir, verifies the
 * package.json version, then writes the completion marker. Never throws.
 */
export async function runStagedInstall(version) {
  const v = String(version || '').trim();
  if (!v) return { ok: false, error: 'no version' };
  if (isStagedComplete(v)) {
    return { ok: true, version: v, dir: join(stagingRootDir(), v, PKG_SUBDIR), alreadyStaged: true };
  }
  const verDir = join(stagingRootDir(), v);
  if (!claimStagingLock(verDir)) return { ok: false, inProgress: true, error: 'staging in progress' };
  try {
    // Fresh staging: clear any partial prior attempt (keep the lock file).
    const installPrefix = join(verDir, 'install');
    rmDir(installPrefix);
    rmDir(join(verDir, PKG_SUBDIR));
    mkdirSync(installPrefix, { recursive: true });

    const installArgs = [
      'install', `${PACKAGE_NAME}@${v}`, '--prefix', installPrefix,
      '--no-save', '--no-audit', '--no-fund', '--loglevel=error',
    ];
    // Shell-less only: node runs npm-cli.js directly so Windows never opens a
    // console window (no cmd/PowerShell, no -WindowStyle flags). If npm-cli.js
    // cannot be resolved we SKIP staging silently rather than fall back to a
    // shell spawn (AV constraint — no shell spawns).
    const cliJs = npmCliJsPath();
    if (!cliJs) return { ok: false, error: 'npm-cli.js unresolved — staging skipped' };
    const code = await new Promise((res) => {
      let child;
      try {
        child = spawn(process.execPath, [cliJs, ...installArgs], { stdio: 'ignore', shell: false, ...hiddenSpawnOpts });
      } catch { res(-1); return; }
      child.once('error', () => res(-1));
      child.once('exit', (c) => res(typeof c === 'number' ? c : -1));
    });
    if (code !== 0) return { ok: false, error: `npm install exited with code ${code}` };

    const installedNM = join(installPrefix, 'node_modules');
    const installedPkg = join(installedNM, PACKAGE_NAME);
    const pkgJson = join(installedPkg, 'package.json');
    if (!existsSync(pkgJson)) return { ok: false, error: 'staged package.json missing' };
    let stagedVer;
    try { stagedVer = String(JSON.parse(readFileSync(pkgJson, 'utf8')).version || ''); } catch { stagedVer = ''; }
    if (stagedVer !== v) return { ok: false, error: `staged version ${stagedVer || '?'} != ${v}` };

    // Relocate into a self-contained package dir: move mixdog OUT of the
    // install node_modules, then nest the remaining (hoisted) deps under it so
    // the swapped-in global dir resolves its own deps and never depends on the
    // parent prefix's node_modules. Both renames are same-volume (instant).
    const pkgDir = join(verDir, PKG_SUBDIR);
    renameSync(installedPkg, pkgDir);
    renameSync(installedNM, join(pkgDir, 'node_modules'));
    rmDir(installPrefix);

    if (!existsSync(join(pkgDir, 'src', 'cli.mjs'))) return { ok: false, error: 'staged cli.mjs missing' };
    // Marker written LAST — its presence is the completion signal for the swap.
    writeFileSync(markerPath(verDir), JSON.stringify({ version: v, pkgDir, stagedAt: Date.now() }), 'utf8');
    return { ok: true, version: v, dir: pkgDir };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    releaseStagingLock(verDir);
  }
}

/**
 * spawnStagedInstall(version) — fire-and-forget a hidden, detached background
 * worker that stages the given version. Detached so it survives the launching
 * session quitting mid-install (the swap happens on a later clean launch).
 * No-op if already staged. Never throws.
 */
export function spawnStagedInstall(version) {
  const v = String(version || '').trim();
  if (!v) return false;
  if (process.env.MIXDOG_DISABLE_STAGED_INSTALL) return false;
  if (isStagedComplete(v)) return false;
  try {
    const worker = join(_MODULE_DIR, 'staged-install-worker.mjs');
    const child = spawn(process.execPath, [worker, v], { stdio: 'ignore', ...detachedSpawnOpts });
    child.once?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

// ── Swap (pre-import, next clean launch) ──────────────────────────────────
/**
 * bestStagedVersion(currentVersion) — highest completed staged version strictly
 * newer than current, with a valid self-contained package dir; else null.
 */
function bestStagedVersion(currentVersion) {
  const cur = String(currentVersion || localPackageVersion());
  let best = null;
  let entries;
  try { entries = readdirSync(stagingRootDir()); } catch { return null; }
  for (const name of entries) {
    const verDir = join(stagingRootDir(), name);
    let m;
    try { m = JSON.parse(readFileSync(markerPath(verDir), 'utf8')); } catch { continue; }
    if (!m || !m.version) continue;
    const pkgDir = m.pkgDir || join(verDir, PKG_SUBDIR);
    if (!existsSync(join(pkgDir, 'package.json')) || !existsSync(join(pkgDir, 'src', 'cli.mjs'))) continue;
    if (!isNewerVersion(m.version, cur)) continue;
    if (!best || compareSemver(m.version, best.version) > 0) best = { version: m.version, pkgDir };
  }
  return best;
}

/**
 * swapStagedIntoGlobal({ globalPkgRoot, pkgDir, expectedVersion }) — atomically
 * replace the global package dir with a staged self-contained package via
 * rename. Old dir kept as a `.old-<ts>` backup and removed best-effort on
 * success; on failure of the second rename the backup is rolled back into
 * place. Returns true only when the new version is live. Never throws.
 */
function swapStagedIntoGlobal({ globalPkgRoot, pkgDir, expectedVersion, _rename } = {}) {
  if (!globalPkgRoot || !pkgDir) return false;
  // `_rename` is a test seam; production always uses renameWithRetrySync.
  const rename = typeof _rename === 'function' ? _rename : renameWithRetrySync;
  // Safety: only ever swap a `.../node_modules/<name>` layout — never a dev
  // checkout or an unexpected root.
  const norm = String(globalPkgRoot).replace(/\\/g, '/');
  if (!/\/node_modules\/[^/]+$/.test(norm)) return false;
  if (!existsSync(join(pkgDir, 'package.json')) || !existsSync(join(pkgDir, 'src', 'cli.mjs'))) return false;
  if (expectedVersion) {
    try {
      const sv = String(JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version || '');
      if (sv !== String(expectedVersion)) return false;
    } catch { return false; }
  }
  const backup = `${globalPkgRoot}.old-${Date.now()}`;
  try {
    rename(globalPkgRoot, backup);
  } catch {
    // Non-writable / locked global (EBUSY/EPERM/EACCES): abort, run current.
    return false;
  }
  // From here the global path is momentarily EMPTY until a rename lands there.
  let swappedForward = false;
  try {
    rename(pkgDir, globalPkgRoot);
    swappedForward = true;
  } catch {
    // 2nd rename failed. Repopulate the global path: prefer restoring the
    // original (backup); if that keeps failing, drive the swap forward
    // (staged→global) instead.
    for (let attempt = 0; attempt < 5 && !globalPopulated(globalPkgRoot); attempt++) {
      try { rename(backup, globalPkgRoot); break; } catch {}
      try { rename(pkgDir, globalPkgRoot); swappedForward = true; break; } catch {}
    }
  }
  // Hard invariant: NEVER return with the global path unpopulated. If both
  // directions keep failing, exit(1) with the backup preserved on disk so the
  // install is recoverable — do not fall through to import a missing package.
  if (!globalPopulated(globalPkgRoot)) {
    process.stderr.write(`mixdog: update swap failed and could not be rolled back — backup preserved at ${backup}\n`);
    process.exit(1);
  }
  // Backup removal is gated on a FRESH verification that global is populated,
  // so it is unreachable from any failure path above.
  if (globalPopulated(globalPkgRoot)) rmDir(backup);
  return swappedForward;
}

// True only when the global path holds a usable package (its package.json and
// entrypoint both present). The single source of truth for "populated".
function globalPopulated(root) {
  try {
    return existsSync(join(root, 'package.json')) && existsSync(join(root, 'src', 'cli.mjs'));
  } catch {
    return false;
  }
}

/**
 * cleanupStaging(currentVersion) — remove superseded/stale staging dirs and any
 * leftover swap backups. Best-effort; never throws.
 */
function cleanupStaging(currentVersion) {
  const cur = String(currentVersion || localPackageVersion());
  try {
    for (const name of readdirSync(stagingRootDir())) {
      const dir = join(stagingRootDir(), name);
      let st;
      try { st = statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      let ver = null;
      try { ver = JSON.parse(readFileSync(markerPath(dir), 'utf8')).version; } catch {}
      if (ver) {
        if (compareSemver(ver, cur) <= 0) rmDir(dir);
      } else if (Date.now() - st.mtimeMs > 60 * 60 * 1000) {
        rmDir(dir);
      }
    }
  } catch { /* staging dir absent */ }
  // Backup sweep is gated on a FRESH check that the global package is
  // populated — a `.old-*` dir is only ever stale/deletable once a real
  // package sits at the global path (never reachable while a swap left it bare).
  try {
    const root = packageRoot();
    if (globalPopulated(root)) {
      const parent = dirname(root);
      const prefix = `${basename(root)}.old-`;
      for (const name of readdirSync(parent)) {
        if (name.startsWith(prefix)) rmDir(join(parent, name));
      }
    }
  } catch { /* best-effort */ }
}

/**
 * performPendingSwap() — the pre-import entrypoint called from cli.mjs. Returns
 * true only if the global package dir was actually swapped to a newer staged
 * version (the caller should then re-exec so the new files load cleanly).
 * Synchronous, silent, and safe: any obstacle → false, run current version.
 */
export function performPendingSwap() {
  try {
    if (process.env.MIXDOG_SWAP_REEXEC) return false;
    if (process.env.MIXDOG_DISABLE_STAGED_SWAP) return false;
    if (isDevInstall()) return false;
    const lock = join(stagingRootDir(), '.swap.lock');
    // Two rounds: round 0 is the normal attempt; if another launcher owns the
    // swap lock (a live swap may be renaming the global dir right now) we WAIT
    // for it to settle, then round 1 re-evaluates against the now-updated
    // on-disk version (it may swap again, or find nothing left to do).
    for (let round = 0; round < 2; round++) {
      const current = currentGlobalVersion();
      const best = bestStagedVersion(current);
      if (!best) { cleanupStaging(current); return false; }
      // Other live session → defer; the swap re-applies on the next clean launch.
      if (otherLiveSessionExists()) return false;
      if (claimSwapLock(lock)) {
        let done = false;
        try {
          if (!otherLiveSessionExists()) {
            done = swapStagedIntoGlobal({
              globalPkgRoot: packageRoot(),
              pkgDir: best.pkgDir,
              expectedVersion: best.version,
            });
          }
        } finally {
          try { unlinkSync(lock); } catch {}
        }
        cleanupStaging(done ? best.version : current);
        return done;
      }
      // Lost the lock. Do NOT import mid-swap — wait for the owner to finish.
      const cleared = waitForSwapLockClear(lock, 5000);
      if (!cleared) {
        // Timed out with a still-live owner mid-swap. Hard invariant: never
        // fall through to imports unless the global dir is verified present +
        // stable; otherwise the owner is still renaming — fail this launch
        // cleanly (exit 1) rather than load a half-renamed tree.
        ensureGlobalStableOrExit(packageRoot(), 3000);
        return false;
      }
      // Lock cleared → loop and re-evaluate against the winner's result.
    }
    return false;
  } catch {
    return false;
  }
}

// Hard gate for the loser-timeout path: return only when `root` holds a
// present + size-stable package; otherwise print a one-line notice and
// process.exit(1). Exported so the swap-safety proof can exercise the exact
// production decision.
function ensureGlobalStableOrExit(root, timeoutMs = 3000) {
  if (ensureGlobalStable(root, timeoutMs) && globalPopulated(root)) return true;
  process.stderr.write('mixdog: update in progress — retry in a moment.\n');
  process.exit(1);
}

// Read the CURRENT on-disk global version fresh (bypassing the cached
// localPackageVersion): after a peer's swap the package.json on disk has
// already changed, and the loser must compare staged versions against the new
// baseline to avoid a redundant re-swap.
function currentGlobalVersion() {
  try {
    return String(JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')).version || localPackageVersion());
  } catch {
    return localPackageVersion();
  }
}

// Block until the swap lock file disappears (owner finished) or the deadline
// passes. A dead/abandoned owner is reaped and treated as cleared. Returns true
// if the lock is gone, false if it timed out with a live owner still holding.
function waitForSwapLockClear(lock, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!existsSync(lock)) return true;
    let owner = 0;
    try { owner = Number.parseInt(String(readFileSync(lock, 'utf8')).trim().split(/\s+/)[0], 10); } catch {}
    if (!pidAlive(owner)) { try { unlinkSync(lock); } catch {} return true; }
    sleepSync(50);
  }
  return !existsSync(lock);
}

// Wait until the global package.json exists and its size is stable across two
// consecutive samples — a cheap proxy for "the rename settled". Best-effort.
function ensureGlobalStable(root, timeoutMs) {
  const pj = join(root, 'package.json');
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastSize = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    let size = -1;
    try { size = statSync(pj).size; } catch { size = -1; }
    if (size >= 0 && size === lastSize) { if (++stable >= 2) return true; } else { stable = 0; }
    lastSize = size;
    sleepSync(60);
  }
  return existsSync(pj);
}

function claimSwapLock(lock) {
  try { mkdirSync(dirname(lock), { recursive: true }); } catch {}
  try {
    const fd = openSync(lock, 'wx');
    try { writeSync(fd, `${process.pid} ${Date.now()}`); } finally { closeSync(fd); }
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') return false;
    let owner = 0; let ageMs = Infinity;
    try { owner = Number.parseInt(String(readFileSync(lock, 'utf8')).trim().split(/\s+/)[0], 10); } catch {}
    try { ageMs = Date.now() - statSync(lock).mtimeMs; } catch {}
    if (pidAlive(owner) && ageMs < STALE_INPROGRESS_MS) return false;
    try { unlinkSync(lock); } catch {}
    try {
      const fd = openSync(lock, 'wx');
      try { writeSync(fd, `${process.pid} ${Date.now()}`); } finally { closeSync(fd); }
      return true;
    } catch { return false; }
  }
}
