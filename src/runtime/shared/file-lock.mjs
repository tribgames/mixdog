import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  link as linkAsync,
  mkdir as mkdirAsync,
  open as openAsync,
  readFile as readFileAsync,
  stat as statAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { enforceOwnerOnlyAclWin32, enforceOwnerOnlyAclWin32Async } from './file-permissions.mjs';
import { createKeyedSerialQueue } from './keyed-serial-queue.mjs';
import { sleep, sleepSync } from './sleep.mjs';

const LOCK_WAIT_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);
export const DEFAULT_BACKOFFS_MS = Object.freeze([25, 50, 100, 200, 400, 800, 1200, 1600]);
const configuredLockTimeoutMs = Number(process.env.MIXDOG_LOCK_TIMEOUT_MS);
const DEFAULT_LOCK_TIMEOUT_MS =
  Number.isFinite(configuredLockTimeoutMs) && configuredLockTimeoutMs >= 0 ? configuredLockTimeoutMs : 2000;
const OWNER_TOKEN = randomBytes(12).toString('hex');
// lockPath → number of async acquisitions of this process that are opening or
// holding the OS lock. The async path yields while it opens, records its owner
// and releases, so a synchronous waiter must see those windows too: it would
// otherwise block the only thread that can finish them.
const osHeldPaths = new Map();
// In-process waiters queue per lock path before contending for the OS lock.
const lockQueue = createKeyedSerialQueue();
const heldLockPaths = new AsyncLocalStorage();
// A reclaim guard is held for a few metadata calls; one older than this whose
// owner is dead was stranded by a process that died inside the reclaim.
const RECLAIM_GUARD_STALE_MS = 30_000;
const LOCK_WAIT_WARN_MS = 500;
const LOCK_WAIT_WARN_INTERVAL_MS = 10_000;
const lockWaitWarnedAt = new Map();

function markOsHeld(lockPath) {
  osHeldPaths.set(lockPath, (osHeldPaths.get(lockPath) || 0) + 1);
}

function unmarkOsHeld(lockPath) {
  const count = (osHeldPaths.get(lockPath) || 0) - 1;
  if (count > 0) osHeldPaths.set(lockPath, count);
  else osHeldPaths.delete(lockPath);
}

// The lock protocol is written once as generators that yield filesystem
// operations. withFileLockSync runs them with synchronous calls; withFileLock
// runs the same steps with promise-based calls, so its open/read/stat/unlink
// work never runs on the event loop and the two paths cannot drift apart.
const SYNC_IO = {
  stat: (path) => statSync(path),
  statId: (path) => statSync(path, { bigint: true }),
  rename: (from, to) => renameSync(from, to),
  read: (path) => readFileSync(path, 'utf8'),
  mkdirp: (path) => mkdirSync(path, { recursive: true }),
  openExclusive: (path) => openSync(path, 'wx'),
  fstat: (fd) => fstatSync(fd),
  writeHandle: (fd, data) => writeFileSync(fd, data, 'utf8'),
  close: (fd) => closeSync(fd),
  createExclusive: (path, data) => writeFileSync(path, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  link: (from, to) => linkSync(from, to),
  unlink: (path) => unlinkSync(path),
  sleep: (ms) => sleepSync(ms),
};

const ASYNC_IO = {
  stat: (path) => statAsync(path),
  read: (path) => readFileAsync(path, 'utf8'),
  mkdirp: (path) => mkdirAsync(path, { recursive: true }),
  openExclusive: (path) => openAsync(path, 'wx'),
  fstat: (handle) => handle.stat(),
  writeHandle: (handle, data) => writeFileAsync(handle, data, 'utf8'),
  close: (handle) => handle.close(),
  createExclusive: (path, data) => writeFileAsync(path, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  link: (from, to) => linkAsync(from, to),
  unlink: (path) => unlinkAsync(path),
  sleep: (ms) => sleep(ms),
};

function runSync(steps) {
  let step = steps.next();
  while (!step.done) {
    const [op, ...args] = step.value;
    let value;
    try {
      value = SYNC_IO[op](...args);
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next(value);
  }
  return step.value;
}

async function runAsync(steps) {
  let step = steps.next();
  while (!step.done) {
    const [op, ...args] = step.value;
    let value;
    try {
      value = await ASYNC_IO[op](...args);
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next(value);
  }
  return step.value;
}

function* readLockOwner(lockPath) {
  try {
    const parts = String(yield ['read', lockPath]).trim().split(/\s+/);
    const pid = Number.parseInt(parts[0], 10);
    return {
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      token: parts.length >= 3 ? parts[2] : null,
    };
  } catch {
    return { pid: null, token: null };
  }
}

function ownerIsLive(owner) {
  if (owner.pid === null) return false;
  // Worker threads share this pid. A foreign or missing token is not proof of death.
  if (owner.pid === process.pid) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function* lockOwnedBySelf(lockPath) {
  const owner = yield* readLockOwner(lockPath);
  return owner.pid === process.pid && owner.token === OWNER_TOKEN;
}

function* describeLockHolder(lockPath) {
  try {
    const stat = yield ['stat', lockPath];
    const owner = yield* readLockOwner(lockPath);
    const ageMs = Math.max(0, Math.round(Date.now() - stat.mtimeMs));
    let live = 'unknown';
    if (owner.pid !== null) live = ownerIsLive(owner) ? 'live' : 'dead';
    const token = owner.token === null ? '?' : String(owner.token).slice(0, 8);
    return `holder pid=${owner.pid ?? '?'} token=${token} age=${ageMs}ms ${live}`;
  } catch {
    return 'holder unknown (lock file unreadable/absent)';
  }
}

function reportLockWait(lockPath, waitedMs, mode) {
  if (waitedMs < LOCK_WAIT_WARN_MS) return;
  const now = Date.now();
  if (now - (lockWaitWarnedAt.get(lockPath) || 0) < LOCK_WAIT_WARN_INTERVAL_MS) return;
  lockWaitWarnedAt.set(lockPath, now);
  if (lockWaitWarnedAt.size > 64) {
    for (const [path, at] of lockWaitWarnedAt) {
      if (now - at >= LOCK_WAIT_WARN_INTERVAL_MS * 6) lockWaitWarnedAt.delete(path);
    }
  }
  try {
    process.stderr.write(`[atomic-file] ${mode} lock wait ${waitedMs}ms: ${lockPath}\n`);
  } catch {
    /* diagnostics only */
  }
}

function* tryAcquireReclaimGuard(lockPath) {
  const guardPath = `${lockPath}.reclaim`;
  const token = `${process.pid} ${Date.now()} ${randomBytes(8).toString('hex')}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stagedPath = `${guardPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      yield ['createExclusive', stagedPath, token];
      yield ['link', stagedPath, guardPath];
      yield ['unlink', stagedPath];
      return { guardPath, token };
    } catch (error) {
      try {
        yield ['unlink', stagedPath];
      } catch {}
      if (!LOCK_WAIT_CODES.has(error?.code)) throw error;
      if (attempt > 0 || !(yield* revokeDeadReclaimGuard(guardPath))) return null;
    }
  }
  return null;
}

// A pathname re-read cannot authorize deleting a guard another process may
// have published in the meantime. Revoke only a guard whose owner is proven
// dead and which is older than any live reclaim, and move it aside first:
// if the moved file is not the one inspected, a newer guard was displaced and
// is linked back.
function* revokeDeadReclaimGuard(guardPath) {
  let before;
  try {
    before = yield ['statId', guardPath];
  } catch {
    return false;
  }
  if (Date.now() - Number(before.mtimeMs) < RECLAIM_GUARD_STALE_MS) return false;
  const owner = yield* readLockOwner(guardPath);
  if (owner.pid !== null && ownerIsLive(owner)) return false;
  const tombPath = `${guardPath}.${process.pid}.${randomBytes(8).toString('hex')}.revoked`;
  try {
    yield ['rename', guardPath, tombPath];
  } catch {
    return false;
  }
  let moved = null;
  try {
    moved = yield ['statId', tombPath];
  } catch {}
  const revoked = moved !== null && moved.dev === before.dev && moved.ino === before.ino;
  if (!revoked) {
    try {
      yield ['link', tombPath, guardPath];
    } catch {}
  }
  try {
    yield ['unlink', tombPath];
  } catch {}
  return revoked;
}

// Remove the guard only while it is still this reclaim's own file.
function* releaseReclaimGuard(reclaim) {
  try {
    if ((yield ['read', reclaim.guardPath]) === reclaim.token) yield ['unlink', reclaim.guardPath];
  } catch {}
}

// A lock is reclaimable when its recorded owner is dead, or when it names no
// owner at all and has outlived the stale window.
function lockReclaimable(owner, stat, staleMs) {
  if (owner.pid !== null) return !ownerIsLive(owner);
  return Date.now() - (Number(stat.mtimeMs) || 0) >= Math.max(0, staleMs);
}

function* tryReclaimStaleLock(lockPath, staleMs) {
  let initial;
  try {
    initial = yield ['stat', lockPath];
  } catch {
    return false;
  }
  const owner = yield* readLockOwner(lockPath);
  if (!lockReclaimable(owner, initial, staleMs)) return false;
  const reclaim = yield* tryAcquireReclaimGuard(lockPath);
  if (reclaim === null) return false;
  try {
    let current;
    try {
      current = yield ['stat', lockPath];
    } catch {
      return false;
    }
    const currentOwner = yield* readLockOwner(lockPath);
    if (currentOwner.pid !== owner.pid || currentOwner.token !== owner.token) return false;
    if (lockReclaimable(currentOwner, current, staleMs)) {
      try {
        yield ['unlink', lockPath];
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } finally {
    yield* releaseReclaimGuard(reclaim);
  }
}

// Jittered backoff for one lock-acquisition attempt, never past the deadline.
// Shared so the sync and async acquisition loops cannot drift apart.
function lockRetryDelayMs(attempt, deadline) {
  const base = DEFAULT_BACKOFFS_MS[Math.min(attempt, DEFAULT_BACKOFFS_MS.length - 1)];
  const jitter = Math.floor(Math.random() * Math.min(75, Math.max(1, base)));
  return Math.min(Math.max(1, deadline - Date.now()), base + jitter);
}

function* releaseLock(lockPath, handle) {
  try {
    yield ['close', handle];
  } catch {}
  try {
    if (yield* lockOwnedBySelf(lockPath)) yield ['unlink', lockPath];
  } catch {}
}

function* writeLockOwner(lockPath, handle) {
  let created;
  try {
    created = yield ['fstat', handle];
    yield ['writeHandle', handle, `${process.pid} ${Date.now()} ${OWNER_TOKEN}\n`];
  } catch (error) {
    // An incomplete owner record cannot authorize a mutation or normal
    // token-based release. Remove only the file opened by this attempt.
    try {
      const current = yield ['stat', lockPath];
      if (created && current.dev === created.dev && current.ino === created.ino) {
        yield ['unlink', lockPath];
      }
    } catch {}
    try {
      yield ['close', handle];
    } catch {}
    throw error;
  }
}

function contentionError(lockPath, cause, holder) {
  const error = new Error(`atomic lock contended (try-once): ${lockPath} [${holder}]`);
  error.code = 'ELOCKCONTENDED';
  error.cause = cause;
  return error;
}

function timeoutError(lockPath, timeoutMs, cause, holder) {
  const error = new Error(`atomic lock timeout after ${timeoutMs}ms: ${lockPath} [${holder}]`);
  error.code = 'ELOCKTIMEOUT';
  error.cause = cause;
  return error;
}

function lockTimeoutMs(opts) {
  return Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
}

function lockStaleMs(opts) {
  return Number.isFinite(opts.staleMs) ? opts.staleMs : 30000;
}

// Acquire the OS lock; returns the open handle with the owner record written.
// `markHeld` (async runs only) publishes each open/owner-write window in
// osHeldPaths; on success the mark stays until the caller has released.
function* acquireLock(lockPath, opts, mode, markHeld) {
  const timeoutMs = lockTimeoutMs(opts);
  const staleMs = lockStaleMs(opts);
  const deadline = Date.now() + timeoutMs;
  yield ['mkdirp', dirname(lockPath)];
  const waitStartedAt = Date.now();
  let attempt = 0;
  let lastError = null;
  while (true) {
    let handle;
    if (markHeld) markOsHeld(lockPath);
    try {
      handle = yield ['openExclusive', lockPath];
    } catch (error) {
      if (markHeld) unmarkOsHeld(lockPath);
      lastError = error;
      if (!LOCK_WAIT_CODES.has(error?.code)) throw error;
      // The reclaim runs synchronously in both modes: it is a few metadata
      // calls, and an await inside it would let a process exit strand its guard.
      try {
        if (runSync(tryReclaimStaleLock(lockPath, staleMs))) continue;
      } catch {}
      if (timeoutMs <= 0) throw contentionError(lockPath, error, yield* describeLockHolder(lockPath));
      if (Date.now() >= deadline) break;
      yield ['sleep', lockRetryDelayMs(attempt, deadline)];
      attempt += 1;
      continue;
    }
    try {
      yield* writeLockOwner(lockPath, handle);
    } catch (error) {
      if (markHeld) unmarkOsHeld(lockPath);
      throw error;
    }
    reportLockWait(lockPath, Date.now() - waitStartedAt, mode);
    return handle;
  }
  throw timeoutError(lockPath, timeoutMs, lastError, yield* describeLockHolder(lockPath));
}

export function withFileLockSync(lockPath, fn, opts = {}) {
  // A synchronous wait prevents this process's async holder from releasing.
  if (lockTimeoutMs(opts) > 0 && osHeldPaths.has(lockPath)) {
    const error = new Error(
      `atomic lock contended (async holder in this process): ${lockPath} [${runSync(describeLockHolder(lockPath))}]`
    );
    error.code = 'ELOCKCONTENDED';
    throw error;
  }
  const fd = runSync(acquireLock(lockPath, opts, 'sync', false));
  try {
    if (opts.secret === true) enforceOwnerOnlyAclWin32(lockPath, { fresh: true });
    return fn();
  } finally {
    runSync(releaseLock(lockPath, fd));
  }
}

export async function withFileLock(lockPath, fn, opts = {}) {
  if (heldLockPaths.getStore()?.get(lockPath)?.active) return fn();
  if (lockTimeoutMs(opts) <= 0) return withOsFileLock(lockPath, fn, opts);
  return lockQueue(lockPath, () => withOsFileLock(lockPath, fn, opts));
}

async function withOsFileLock(lockPath, fn, opts = {}) {
  const handle = await runAsync(acquireLock(lockPath, opts, 'async', true));
  const lease = { active: false };
  try {
    if (opts.secret === true) await enforceOwnerOnlyAclWin32Async(lockPath, { fresh: true });
    // Async descendants inherit a reference to this lease, not permanent
    // ownership. Releasing it invalidates detached work as well as this caller.
    const held = new Map(heldLockPaths.getStore() || []);
    held.set(lockPath, lease);
    lease.active = true;
    return await heldLockPaths.run(held, fn);
  } finally {
    lease.active = false;
    try {
      await runAsync(releaseLock(lockPath, handle));
    } finally {
      // Unmark only once the lock file is gone: a sync waiter arriving while
      // the release is still pending must fail fast, not block its completion.
      unmarkOsHeld(lockPath);
    }
  }
}
