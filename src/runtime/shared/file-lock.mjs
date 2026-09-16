import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { enforceOwnerOnlyAclWin32, enforceOwnerOnlyAclWin32Async } from './file-permissions.mjs';
import { sleep, sleepSync } from './sleep.mjs';

const LOCK_WAIT_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);
export const DEFAULT_BACKOFFS_MS = Object.freeze([25, 50, 100, 200, 400, 800, 1200, 1600]);
const configuredLockTimeoutMs = Number(process.env.MIXDOG_LOCK_TIMEOUT_MS);
const DEFAULT_LOCK_TIMEOUT_MS =
  Number.isFinite(configuredLockTimeoutMs) && configuredLockTimeoutMs >= 0 ? configuredLockTimeoutMs : 2000;
const OWNER_TOKEN = randomBytes(12).toString('hex');
const osHeldPaths = new Set();
const lockQueues = new Map();
const heldLockPaths = new AsyncLocalStorage();
const LOCK_WAIT_WARN_MS = 500;
const LOCK_WAIT_WARN_INTERVAL_MS = 10_000;
const lockWaitWarnedAt = new Map();

function readLockOwner(lockPath) {
  try {
    const parts = String(readFileSync(lockPath, 'utf8')).trim().split(/\s+/);
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

function lockOwnedBySelf(lockPath) {
  const owner = readLockOwner(lockPath);
  return owner.pid === process.pid && owner.token === OWNER_TOKEN;
}

function describeLockHolder(lockPath) {
  try {
    const stat = statSync(lockPath);
    const owner = readLockOwner(lockPath);
    const ageMs = Math.max(0, Math.round(Date.now() - stat.mtimeMs));
    const live = owner.pid === null ? 'unknown' : ownerIsLive(owner) ? 'live' : 'dead';
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

function tryAcquireReclaimGuard(lockPath) {
  const guardPath = `${lockPath}.reclaim`;
  const token = `${process.pid} ${Date.now()} ${randomBytes(8).toString('hex')}\n`;
  const stagedPath = `${guardPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(stagedPath, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    linkSync(stagedPath, guardPath);
    unlinkSync(stagedPath);
    return { guardPath };
  } catch (error) {
    try {
      unlinkSync(stagedPath);
    } catch {}
    // Published guards are not revocable: a pathname re-read cannot authorize
    // deleting a guard that another process may have acquired in the meantime.
    if (LOCK_WAIT_CODES.has(error?.code)) return null;
    throw error;
  }
}

function tryReclaimStaleLock(lockPath, staleMs) {
  let initial;
  try {
    initial = statSync(lockPath);
  } catch {
    return false;
  }
  const owner = readLockOwner(lockPath);
  const dead = owner.pid !== null && !ownerIsLive(owner);
  const pidlessStale = owner.pid === null && Date.now() - (Number(initial.mtimeMs) || 0) >= Math.max(0, staleMs);
  if (!dead && !pidlessStale) return false;
  const reclaim = tryAcquireReclaimGuard(lockPath);
  if (reclaim === null) return false;
  try {
    let current;
    try {
      current = statSync(lockPath);
    } catch {
      return false;
    }
    const currentOwner = readLockOwner(lockPath);
    if (currentOwner.pid !== owner.pid || currentOwner.token !== owner.token) return false;
    const currentDead = currentOwner.pid !== null && !ownerIsLive(currentOwner);
    const currentPidlessStale =
      currentOwner.pid === null && Date.now() - (Number(current.mtimeMs) || 0) >= Math.max(0, staleMs);
    if (currentDead || currentPidlessStale) {
      try {
        unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } finally {
    try {
      unlinkSync(reclaim.guardPath);
    } catch {}
  }
}

function releaseLock(lockPath, fd) {
  try {
    closeSync(fd);
  } catch {}
  try {
    if (lockOwnedBySelf(lockPath)) unlinkSync(lockPath);
  } catch {}
}

function writeLockOwner(lockPath, fd) {
  let created;
  try {
    created = fstatSync(fd);
    writeFileSync(fd, `${process.pid} ${Date.now()} ${OWNER_TOKEN}\n`, 'utf8');
  } catch (error) {
    // An incomplete owner record cannot authorize a mutation or normal
    // token-based release. Remove only the file opened by this attempt.
    try {
      const current = statSync(lockPath);
      if (created && current.dev === created.dev && current.ino === created.ino) {
        unlinkSync(lockPath);
      }
    } catch {}
    try {
      closeSync(fd);
    } catch {}
    throw error;
  }
}

function contentionError(lockPath, cause) {
  const error = new Error(`atomic lock contended (try-once): ${lockPath} [${describeLockHolder(lockPath)}]`);
  error.code = 'ELOCKCONTENDED';
  error.cause = cause;
  return error;
}

function timeoutError(lockPath, timeoutMs, cause) {
  const error = new Error(`atomic lock timeout after ${timeoutMs}ms: ${lockPath} [${describeLockHolder(lockPath)}]`);
  error.code = 'ELOCKTIMEOUT';
  error.cause = cause;
  return error;
}

export function withFileLockSync(lockPath, fn, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : 30000;
  // A synchronous wait prevents this process's async holder from releasing.
  if (timeoutMs > 0 && osHeldPaths.has(lockPath)) {
    const error = new Error(
      `atomic lock contended (async holder in this process): ${lockPath} [${describeLockHolder(lockPath)}]`
    );
    error.code = 'ELOCKCONTENDED';
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(lockPath), { recursive: true });
  const waitStartedAt = Date.now();
  let attempt = 0;
  let lastError = null;
  while (true) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      lastError = error;
      if (!LOCK_WAIT_CODES.has(error?.code)) throw error;
      try {
        if (tryReclaimStaleLock(lockPath, staleMs)) continue;
      } catch {}
      if (timeoutMs <= 0) throw contentionError(lockPath, error);
      if (Date.now() >= deadline) break;
      const base = DEFAULT_BACKOFFS_MS[Math.min(attempt, DEFAULT_BACKOFFS_MS.length - 1)];
      const jitter = Math.floor(Math.random() * Math.min(75, Math.max(1, base)));
      sleepSync(Math.min(Math.max(1, deadline - Date.now()), base + jitter));
      attempt += 1;
      continue;
    }
    writeLockOwner(lockPath, fd);
    reportLockWait(lockPath, Date.now() - waitStartedAt, 'sync');
    try {
      if (opts.secret === true) enforceOwnerOnlyAclWin32(lockPath, { fresh: true });
      return fn();
    } finally {
      releaseLock(lockPath, fd);
    }
  }
  throw timeoutError(lockPath, timeoutMs, lastError);
}

export async function withFileLock(lockPath, fn, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  if (heldLockPaths.getStore()?.get(lockPath)?.active) return fn();
  if (timeoutMs <= 0) return withOsFileLock(lockPath, fn, opts);
  const previous = lockQueues.get(lockPath) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => withOsFileLock(lockPath, fn, opts));
  const settled = task.then(
    () => {},
    () => {}
  );
  lockQueues.set(lockPath, settled);
  void settled.then(() => {
    if (lockQueues.get(lockPath) === settled) lockQueues.delete(lockPath);
  });
  return task;
}

async function withOsFileLock(lockPath, fn, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : 30000;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(lockPath), { recursive: true });
  const waitStartedAt = Date.now();
  let attempt = 0;
  let lastError = null;
  while (true) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      lastError = error;
      if (!LOCK_WAIT_CODES.has(error?.code)) throw error;
      try {
        if (tryReclaimStaleLock(lockPath, staleMs)) continue;
      } catch {}
      if (timeoutMs <= 0) throw contentionError(lockPath, error);
      if (Date.now() >= deadline) break;
      const base = DEFAULT_BACKOFFS_MS[Math.min(attempt, DEFAULT_BACKOFFS_MS.length - 1)];
      const jitter = Math.floor(Math.random() * Math.min(75, Math.max(1, base)));
      await sleep(Math.min(Math.max(1, deadline - Date.now()), base + jitter));
      attempt += 1;
      continue;
    }
    writeLockOwner(lockPath, fd);
    reportLockWait(lockPath, Date.now() - waitStartedAt, 'async');
    osHeldPaths.add(lockPath);
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
      osHeldPaths.delete(lockPath);
      releaseLock(lockPath, fd);
    }
  }
  throw timeoutError(lockPath, timeoutMs, lastError);
}
