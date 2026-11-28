// The swap half of the staged update of an npm install, as 1.4.5's cli.mjs did it before it imported anything.
//
// The core (the daemon's update service) checks the npm registry, and with auto-update on stages the newer version:
// `npm install mixdog@<version>` into `<data>/staging/<version>/install`, relocated into a self-contained
// `<data>/staging/<version>/mixdog` (its dependencies nested beneath), its native runtime fetched and verified into the
// user's runtime cache (bin/runtime.mjs), and only then `.staged-complete.json` is written. Nothing of the installed
// package is touched while a session runs.
//
// This runs in the launcher (`bin/mixdog.mjs`) at the next start, the one process that holds no file of the package open:
// when a completed staged version is newer than the installed one, its runtime is ready, and no other mixdog session runs
// (`<data>/live-sessions/<pid>.pid`, written by the program), `node_modules/mixdog` is renamed aside and the staged folder
// renamed into its place; the runtime of the version it replaced is removed from the cache. Any obstacle (a locked or
// unwritable folder, another session, a runtime that is not ready) leaves the installed version running and the swap tries
// again at the next start. Dependency-free: the launcher ships alone.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeSync, closeSync, openSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { nextRenameDelayMs, renameWithRetry, sleepSync } from './rename.mjs';
import { dataDir, resolveRuntime, runtimeCacheRoot } from './runtime.mjs';

export { dataDir, nextRenameDelayMs, renameWithRetry };

const MARKER_NAME = '.staged-complete.json';
const PKG_SUBDIR = 'mixdog';
const STALE_INPROGRESS_MS = 10 * 60 * 1000;
const INCOMPLETE_MAX_AGE_MS = 60 * 60 * 1000;
const LOCK_WAIT_MS = 5000;
const STABLE_WAIT_MS = 3000;

/** `isPidAlive`: a positive integer that `kill(pid, 0)` can address (EPERM: it exists, another user's). */
export function isPidAlive(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function parseSemver(value) {
  const text = String(value || '').trim().replace(/^v/i, '').split('+')[0];
  const dash = text.indexOf('-');
  const parts = (dash === -1 ? text : text.slice(0, dash)).split('.').map((part) => {
    const number = Number.parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
  });
  while (parts.length < 3) parts.push(0);
  return { parts, prerelease: dash === -1 ? [] : text.slice(dash + 1).split('.') };
}

function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const diff = BigInt(a) - BigInt(b);
    return diff === 0n ? 0 : diff > 0n ? 1 : -1;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** SemVer 2.0.0 precedence: positive when `a` is newer than `b`. */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (!pa.prerelease.length || !pb.prerelease.length) {
    return pa.prerelease.length === pb.prerelease.length ? 0 : pa.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.min(pa.prerelease.length, pb.prerelease.length); i++) {
    const diff = compareIdentifiers(pa.prerelease[i], pb.prerelease[i]);
    if (diff !== 0) return diff;
  }
  return Math.sign(pa.prerelease.length - pb.prerelease.length);
}

const isNewer = (latest, current) => Boolean(latest && current) && compareSemver(latest, current) > 0;

function rmDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** The package folder holds something the launcher can start from: its manifest and the launcher both there. */
export function packagePopulated(root) {
  return existsSync(join(root, 'package.json')) && existsSync(join(root, 'bin', 'mixdog.mjs'));
}

/**
 * A package that can run on this machine: populated, with the entry an install made by 1.4.5 links its command to
 * (src/cli.mjs: a swap never rewrites that link) and the runtime module, and the verified runtime of this host for its
 * version ready in the user's cache (`data`). Mirrors `package_complete_for` of update_installer.rs.
 */
export function packageComplete(root, { platform = process.platform, arch = process.arch, data = dataDir() } = {}) {
  if (!packagePopulated(root) || !existsSync(join(root, 'src', 'cli.mjs')) || !existsSync(join(root, 'bin', 'runtime.mjs'))) return false;
  return resolveRuntime({ packageRoot: root, platform, arch, data }).ready === true;
}

/** Waits until the package manifest exists and its size is the same across two samples: the owner's rename has settled. */
function installSettles(root, timeoutMs) {
  const manifest = join(root, 'package.json');
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    let size = -1;
    try {
      size = statSync(manifest).size;
    } catch {
      // Renamed aside at the moment.
    }
    if (size >= 0 && size === last) {
      if (++stable >= 2) return true;
    } else {
      stable = 0;
    }
    last = size;
    sleepSync(60);
  }
  return existsSync(manifest);
}

function installedVersion(packageRoot) {
  try {
    return String(readJson(join(packageRoot, 'package.json')).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/** A git checkout, or a package that is not under any `node_modules`: never replaced. */
export function isDevInstall(packageRoot) {
  if (existsSync(join(packageRoot, '.git'))) return true;
  return !/\/node_modules\//.test(`/${packageRoot.replace(/\\/g, '/').toLowerCase()}/`);
}

/** The highest completed staged version strictly newer than `current`, with its package folder in place. */
export function bestStagedVersion(staging, current, host) {
  let best = null;
  let names;
  try {
    names = readdirSync(staging);
  } catch {
    return null;
  }
  for (const name of names) {
    const verDir = join(staging, name);
    let marker;
    try {
      marker = readJson(join(verDir, MARKER_NAME));
    } catch {
      continue;
    }
    if (!marker?.version) continue;
    const pkgDir = marker.pkgDir || join(verDir, PKG_SUBDIR);
    if (!packageComplete(pkgDir, host) || !isNewer(marker.version, current)) continue;
    if (!best || compareSemver(marker.version, best.version) > 0) best = { version: marker.version, pkgDir };
  }
  return best;
}

function otherLiveSessionExists(liveDir, pid, alive) {
  let names;
  try {
    names = readdirSync(liveDir);
  } catch {
    return false;
  }
  let found = false;
  for (const name of names) {
    if (!name.endsWith('.pid')) continue;
    const other = Number.parseInt(name.slice(0, -4), 10);
    if (!Number.isInteger(other) || other <= 0 || other === pid) continue;
    if (alive(other)) {
      found = true;
    } else {
      // Reaped so a crashed session never wedges updates for good.
      try {
        unlinkSync(join(liveDir, name));
      } catch {
        // Best effort.
      }
    }
  }
  return found;
}

/** An exclusive `<pid> <ms>` lock file, taken over only from a dead owner or after ten minutes. */
function claimLock(lock, pid, alive) {
  const write = () => {
    const fd = openSync(lock, 'wx');
    try {
      writeSync(fd, `${pid} ${Date.now()}`);
    } finally {
      closeSync(fd);
    }
  };
  try {
    mkdirSync(dirname(lock), { recursive: true });
    write();
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
  }
  let owner = 0;
  let age = Infinity;
  try {
    owner = Number.parseInt(readFileSync(lock, 'utf8').trim().split(/\s+/)[0], 10);
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    // An unreadable lock is stale.
  }
  if (alive(owner) && age < STALE_INPROGRESS_MS) return false;
  try {
    unlinkSync(lock);
    write();
    return true;
  } catch {
    return false;
  }
}

function waitLockClear(lock, alive, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(lock)) return true;
    let owner = 0;
    try {
      owner = Number.parseInt(readFileSync(lock, 'utf8').trim().split(/\s+/)[0], 10);
    } catch {
      // Unreadable: stale.
    }
    if (!alive(owner)) {
      try {
        unlinkSync(lock);
      } catch {
        // Gone already.
      }
      return true;
    }
    sleepSync(50);
  }
  return !existsSync(lock);
}

function swapIntoPlace({ packageRoot, pkgDir, version, host, verify }) {
  if (!/\/node_modules\/[^/]+$/.test(packageRoot.replace(/\\/g, '/'))) return { done: false };
  if (!packageComplete(pkgDir, host)) return { done: false };
  try {
    if (String(readJson(join(pkgDir, 'package.json')).version || '') !== version) return { done: false };
  } catch {
    return { done: false };
  }
  const backup = `${packageRoot}.old-${Date.now()}`;
  try {
    renameWithRetry(packageRoot, backup);
  } catch {
    // A locked or unwritable folder: run the installed version.
    return { done: false };
  }
  // From here the package path is empty until a rename lands there.
  let forward = false;
  try {
    renameWithRetry(pkgDir, packageRoot);
    forward = true;
  } catch {
    for (let attempt = 0; attempt < 5 && !packagePopulated(packageRoot); attempt++) {
      try {
        renameWithRetry(backup, packageRoot);
        break;
      } catch {
        // Try forward instead.
      }
      try {
        renameWithRetry(pkgDir, packageRoot);
        forward = true;
        break;
      } catch {
        // Next attempt.
      }
    }
  }
  if (!packagePopulated(packageRoot)) return { done: false, stranded: backup };
  if (forward && !verify(packageRoot, host)) {
    // What landed cannot run: put the working install back, keeping the backup if that fails.
    const rejected = `${packageRoot}.rejected-${Date.now()}`;
    try {
      renameWithRetry(packageRoot, rejected);
      renameWithRetry(backup, packageRoot);
      rmDir(rejected);
      return { done: false };
    } catch {
      return { done: false, stranded: backup };
    }
  }
  rmDir(backup);
  return { done: forward };
}

/** Removes the superseded and the abandoned staging folders and the backups of earlier swaps. */
function cleanupStaging(staging, packageRoot, current, host) {
  try {
    for (const name of readdirSync(staging)) {
      const dir = join(staging, name);
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      let version = null;
      try {
        version = readJson(join(dir, MARKER_NAME)).version;
      } catch {
        // No marker: an attempt that has not completed.
      }
      if (version) {
        if (compareSemver(version, current) <= 0) rmDir(dir);
      } else if (Date.now() - stat.mtimeMs > INCOMPLETE_MAX_AGE_MS) {
        rmDir(dir);
      }
    }
  } catch {
    // No staging folder.
  }
  // Only once a real package sits at its place is a backup stale.
  try {
    if (!packageComplete(packageRoot, host)) return;
    const prefix = `${basename(packageRoot)}.old-`;
    for (const name of readdirSync(dirname(packageRoot))) {
      if (name.startsWith(prefix)) rmDir(join(dirname(packageRoot), name));
    }
  } catch {
    // Best effort.
  }
}

/**
 * `performPendingSwap()`: true only when the installed package was replaced by a newer staged version (the caller starts
 * the launcher of the new package again). Silent: any obstacle is false and the installed version runs. A swap that
 * leaves no package and cannot restore one ends the process with 1, the backup kept.
 */
export function performPendingSwap({
  packageRoot,
  env = process.env,
  data = dataDir(env),
  pid = process.pid,
  alive = isPidAlive,
  exit = (code) => process.exit(code),
  stderr = process.stderr,
  platform = process.platform,
  arch = process.arch,
  lockWaitMs = LOCK_WAIT_MS,
  stableWaitMs = STABLE_WAIT_MS,
  verify = packageComplete,
} = {}) {
  const host = { platform, arch, data };
  try {
    if (env.MIXDOG_SWAP_REEXEC || env.MIXDOG_DISABLE_STAGED_SWAP || isDevInstall(packageRoot)) return false;
    const staging = join(data, 'staging');
    const liveDir = join(data, 'live-sessions');
    const lock = join(staging, '.swap.lock');
    // Round 0 is the attempt; a start that finds another one swapping waits for it, then looks again at what is installed.
    for (let round = 0; round < 2; round++) {
      const current = installedVersion(packageRoot);
      const best = bestStagedVersion(staging, current, host);
      if (!best) {
        cleanupStaging(staging, packageRoot, current, host);
        return false;
      }
      if (otherLiveSessionExists(liveDir, pid, alive)) return false;
      if (claimLock(lock, pid, alive)) {
        let result = { done: false };
        try {
          if (!otherLiveSessionExists(liveDir, pid, alive)) {
            result = swapIntoPlace({ packageRoot, pkgDir: best.pkgDir, version: best.version, host, verify });
          }
        } finally {
          try {
            unlinkSync(lock);
          } catch {
            // Already gone.
          }
        }
        if (result.stranded) {
          stderr.write(`mixdog: update swap failed and could not be rolled back - backup preserved at ${result.stranded}\n`);
          exit(1);
          return false;
        }
        cleanupStaging(staging, packageRoot, result.done ? best.version : current, host);
        // No session of this data folder runs the replaced version's programs any more (checked under the lock).
        if (result.done) rmDir(join(runtimeCacheRoot(data), current));
        return result.done;
      }
      // Never touch the package mid-swap: wait for the owner. Timed out with a live owner: go on only when the install is
      // present and settled; otherwise the owner is still renaming, and this start fails cleanly before the launcher resolves
      // anything in a half-renamed tree.
      if (!waitLockClear(lock, alive, lockWaitMs)) {
        if (installSettles(packageRoot, stableWaitMs) && packagePopulated(packageRoot)) return false;
        stderr.write('mixdog: update in progress - retry in a moment.\n');
        exit(1);
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}
