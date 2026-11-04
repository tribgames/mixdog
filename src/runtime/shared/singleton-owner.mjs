import { rmdirSync, rmSync, statSync } from 'node:fs';
import { writeJsonAtomicSync } from './atomic-file.mjs';
import { withFileLockSync } from './file-lock.mjs';
import { readJsonSafe } from './json-file.mjs';
import { isPidAlive } from './pid-liveness.mjs';

// Claim-lock protocol shared by the sync and async paths: `<path>.claim.lock`
// is a file-lock.mjs lock, published atomically with its holder's pid and
// token. A holder whose pid is alive is waited out however long it holds the
// lock — a holder stalled mid-write still owns it: reclaiming it on age let
// a successor claim the record and the stalled write then overwrite it. Its
// lock is reclaimed only once that pid is dead, and only the holder's own
// acquisition (pid + token) is ever released. A lock naming no holder — the
// bare directory versions before this one took the lock with — is reclaimed
// once older than CLAIM_LOCK_STALE_MS, as those versions did.
const CLAIM_LOCK_TIMEOUT_MS = 500;
const CLAIM_LOCK_STALE_MS = 5000;
const CLAIM_LOCK_OPTS = Object.freeze({ timeoutMs: CLAIM_LOCK_TIMEOUT_MS, staleMs: CLAIM_LOCK_STALE_MS });
const BUSY = Symbol('claim lock busy');

// Held by another live process ('busy'). Any other
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

function namesOtherPid(record, pid) {
  return Boolean(record?.pid) && Number(record.pid) !== Number(pid);
}

export function readSingletonOwner(path) {
  const owner = readJsonSafe(path);
  if (!owner || typeof owner !== 'object') return { owner: null, alive: false };
  return { owner, alive: isPidAlive(owner.pid) };
}

export function claimSingletonOwner(path, { kind = 'runtime', pid = process.pid, meta = {} } = {}) {
  const owner = {
    kind,
    pid,
    claimedAt: new Date().toISOString(),
    ...meta,
  };
  const livePeer = (current) =>
    Boolean(current?.pid) && Number(current.pid) !== Number(pid) && isPidAlive(current.pid);

  const current = readJsonSafe(path);
  if (livePeer(current)) {
    return { owned: false, owner: current };
  }

  const result = withClaimLockSync(path, () => {
    const lockedCurrent = readJsonSafe(path);
    if (livePeer(lockedCurrent)) {
      return { owned: false, owner: lockedCurrent };
    }
    writeJsonAtomicSync(path, owner);
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
    writeJsonAtomicSync(path, owner);
    return { owned: true, owner };
  });
  return result === BUSY ? { owned: false, owner: readJsonSafe(path) } : result;
}
