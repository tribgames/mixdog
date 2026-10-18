import { mkdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withFileLock, withFileLockSync } from './file-lock.mjs';
import { readJsonSafe } from './json-file.mjs';
import { isPidAlive } from './pid-liveness.mjs';

// Claim-lock protocol shared by the sync and async paths: `<path>.claim.lock`
// is a file-lock.mjs lock, published atomically with its holder's pid and
// token. A holder whose pid is alive is waited out however long it holds the
// lock — a holder stalled mid-refresh still owns it: reclaiming it on age let
// a successor claim the record and the stalled refresh then overwrite it. Its
// lock is reclaimed only once that pid is dead, and only the holder's own
// acquisition (pid + token) is ever released. A lock naming no holder — the
// bare directory versions before this one took the lock with — is reclaimed
// once older than CLAIM_LOCK_STALE_MS, as those versions did.
const CLAIM_LOCK_TIMEOUT_MS = 500;
const CLAIM_LOCK_STALE_MS = 5000;
const CLAIM_LOCK_OPTS = Object.freeze({ timeoutMs: CLAIM_LOCK_TIMEOUT_MS, staleMs: CLAIM_LOCK_STALE_MS });
const BUSY = Symbol('claim lock busy');

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

// Held by another live process or this one's async holder ('busy'). Any other
// failure (an unwritable data directory) is thrown, as before.
function claimLockHeld(error) {
  return error?.code === 'ELOCKCONTENDED' || (error?.code === 'ELOCKTIMEOUT' && error.cause?.code === 'EEXIST');
}

function legacyLockStale(info) {
  return info.isDirectory() && Date.now() - info.mtimeMs > CLAIM_LOCK_STALE_MS;
}

// An older version's stale bare lock directory is removed with rmdir alone,
// never recursive or forced: between the stat and the removal a contender may
// have replaced it with a live owner-named lock file. rmdir refuses a file
// (ENOENT on Windows, ENOTDIR elsewhere) and a non-empty directory
// (ENOTEMPTY); a missing path (ENOENT) is already gone. Any refusal (EPERM
// included) leaves the path untouched to the shared acquire loop below, which
// waits a live holder out and reclaims only a dead one's lock.

// `fn()` under the claim lock, or BUSY. file-lock creates a missing data
// directory (a first boot, e.g. a daemon an ssh bootstrap starts on a fresh
// server).
function withClaimLockSync(path, fn) {
  const lockPath = `${path}.claim.lock`;
  try {
    if (legacyLockStale(statSync(lockPath))) rmdirSync(lockPath);
  } catch {}
  let entered = false;
  try {
    return withFileLockSync(
      lockPath,
      () => {
        entered = true;
        return fn();
      },
      CLAIM_LOCK_OPTS
    );
  } catch (error) {
    if (!entered && claimLockHeld(error)) return BUSY;
    throw error;
  }
}

// The same lock taken without blocking the event loop: every file operation
// and every retry wait is awaited (a synchronous refresh once held the
// daemon's loop for 20 s in one rmSync under disk contention).
async function withClaimLock(path, fn) {
  const lockPath = `${path}.claim.lock`;
  try {
    if (legacyLockStale(await stat(lockPath))) await rmdir(lockPath);
  } catch {}
  let entered = false;
  try {
    return await withFileLock(
      lockPath,
      () => {
        entered = true;
        return fn();
      },
      CLAIM_LOCK_OPTS
    );
  } catch (error) {
    if (!entered && claimLockHeld(error)) return BUSY;
    throw error;
  }
}

function namesOtherPid(record, pid) {
  return Boolean(record?.pid) && Number(record.pid) !== Number(pid);
}

async function readJsonSafeAsync(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// A live pid alone does not prove the record's process still owns it: the OS
// reuses pids. `isStale(owner)` lets a caller with a stronger proof (the
// daemon's published discovery) reject a live-pid record; `stale` reports it.
export function readSingletonOwner(path, { isStale = null } = {}) {
  const owner = readJsonSafe(path);
  if (!owner || typeof owner !== 'object') return { owner: null, alive: false, stale: false };
  const pidAlive = isPidAlive(owner.pid);
  const stale = pidAlive && typeof isStale === 'function' && isStale(owner) === true;
  return { owner, alive: pidAlive && !stale, stale };
}

export function claimSingletonOwner(path, { kind = 'runtime', pid = process.pid, meta = {}, isStale = null } = {}) {
  const owner = {
    kind,
    pid,
    claimedAt: new Date().toISOString(),
    ...meta,
  };
  const livePeer = (current) =>
    Boolean(current?.pid) &&
    Number(current.pid) !== Number(pid) &&
    isPidAlive(current.pid) &&
    !(typeof isStale === 'function' && isStale(current) === true);

  const current = readJsonSafe(path);
  if (livePeer(current)) {
    return { owned: false, owner: current };
  }

  const result = withClaimLockSync(path, () => {
    const lockedCurrent = readJsonSafe(path);
    if (livePeer(lockedCurrent)) {
      return { owned: false, owner: lockedCurrent };
    }
    writeJsonAtomic(path, owner);
    return { owned: true, owner };
  });
  return result === BUSY ? { owned: false, owner: readJsonSafe(path) } : result;
}

export function releaseSingletonOwner(path, pid = process.pid) {
  const current = readJsonSafe(path);
  if (!current?.pid || Number(current.pid) !== Number(pid)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Rewrite the caller's own record (`owner.pid`) under the claim lock: when it
// still names that pid or is gone, it becomes `owner` ('refreshed'); a record
// naming another pid is reported, never overwritten ('superseded'); a claim
// lock held past its wait leaves the record alone ('busy').
export function refreshSingletonOwner(path, owner) {
  const result = withClaimLockSync(path, () => {
    const current = readJsonSafe(path);
    if (namesOtherPid(current, owner.pid)) return { status: 'superseded', owner: current };
    writeJsonAtomic(path, owner);
    return { status: 'refreshed', owner };
  });
  return result === BUSY ? { status: 'busy', owner: null } : result;
}

/** refreshSingletonOwner without blocking the event loop: the same claim
 *  lock (mutually exclusive with the sync claim/refresh/handoff), the same
 *  verdicts, every file operation and retry wait awaited. Its awaited write
 *  may stall, so the record is read again right before it is replaced: a
 *  record another pid wrote meanwhile is reported, never overwritten. */
export async function refreshSingletonOwnerAsync(path, owner) {
  const result = await withClaimLock(path, async () => {
    const current = await readJsonSafeAsync(path);
    if (namesOtherPid(current, owner.pid)) return { status: 'superseded', owner: current };
    let tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(owner, null, 2)}\n`);
      const latest = await readJsonSafeAsync(path);
      if (namesOtherPid(latest, owner.pid)) return { status: 'superseded', owner: latest };
      await rename(tmp, path);
      tmp = null;
      return { status: 'refreshed', owner };
    } finally {
      if (tmp) await rm(tmp, { force: true }).catch(() => {});
    }
  });
  return result === BUSY ? { status: 'busy', owner: null } : result;
}

// Atomic ownership handoff: replace the owner record from fromPid to toOwner
// under the SAME claim lock, so a concurrent claimSingletonOwner() cannot slip
// between a release() and a re-claim() and fork a competing daemon. Verifies
// the current on-disk pid is still fromPid before writing; if it drifted
// (someone else won), the handoff is refused (owned:false) and the caller
// should fall back to the winner rather than overwrite it.
export function handoffSingletonOwner(path, fromPid, toOwner = {}) {
  const result = withClaimLockSync(path, () => {
    const current = readJsonSafe(path);
    if (namesOtherPid(current, fromPid)) {
      return { owned: false, owner: current };
    }
    const owner = {
      kind: 'runtime',
      claimedAt: new Date().toISOString(),
      ...toOwner,
    };
    writeJsonAtomic(path, owner);
    return { owned: true, owner };
  });
  return result === BUSY ? { owned: false, owner: readJsonSafe(path) } : result;
}
