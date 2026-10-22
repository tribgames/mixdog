// Cross-process advisory lock for patch/write operations. Uses a lockfile
// written exclusively (`wx`) and a process.kill(pid, 0) liveness check to
// clean up after crashed holders. Pair with the in-process withPathLock for
// the same target: in-process serialises async callers in this Node, advisory
// lock serialises across Node processes.
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { compareCodePoints } from '../../../../shared/code-point-order.mjs';
import { ensurePrivateRuntimeRoot } from '../../../../shared/runtime-root.mjs';
import { sleep } from '../../../../shared/sleep.mjs';
import { homedir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// The deepest existing component (the target itself when present, so a leaf
// symlink shares its referent's lock like atomicWrite writes through it) is
// resolved; components not created yet are appended as given.
function canonicalLockTarget(targetPath) {
  const resolved = resolve(targetPath);
  const tail = [];
  let dir = resolved;
  for (;;) {
    try {
      return join(realpathSync.native(dir), ...tail.reverse());
    } catch {
      if (dirname(dir) === dir) return resolved;
      tail.push(basename(dir));
      dir = dirname(dir);
    }
  }
}

// External files can be shared by profiles, so neither MIXDOG_HOME/DATA_DIR
// nor MIXDOG_RUNTIME_ROOT may choose this namespace. Temp directories can
// differ between processes too. Keep locks in the OS user's local home,
// never beside the target: sync drives such as MYBOX refuse sibling dotfiles.
// The pid liveness check coordinates only processes on this host.
function lockDirectory() {
  const root =
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'mixdog')
      : join(homedir(), '.mixdog');
  return join(root, 'locks');
}

function lockFileFor(targetPath) {
  const canonical = canonicalLockTarget(targetPath);
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const hash = createHash('sha256').update(key).digest('hex');
  return join(lockDirectory(), `${hash}.mixdog-lock`);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Triple-check: process.kill(pid, 0) can return transient ESRCH under
  // heavy multi-process spawn pressure on Windows even when the target
  // process is actually alive. Any one of three rapid probes returning
  // success (or EPERM = exists-but-no-access) classifies as alive. Three
  // consecutive ESRCH replies classify as dead. Each probe is a single
  // syscall (microseconds) so total cost is negligible vs the race risk.
  for (let i = 0; i < 3; i += 1) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if (err && err.code === 'EPERM') return true;
      // ESRCH or other → continue probing.
    }
  }
  return false;
}

function readLockInfo(lockFile) {
  try {
    const raw = readFileSync(lockFile, 'utf-8').trim();
    // Token format: `${pid}.${hex}`, or legacy bare-pid contents. parseInt
    // stops at the dot, so both read the leading pid.
    const pid = parseInt(raw, 10);
    return { pid: Number.isInteger(pid) ? pid : 0, token: raw };
  } catch {
    return { pid: 0, token: '' };
  }
}

function unlinkIfOwned(lockFile, expectedToken) {
  try {
    const { token } = readLockInfo(lockFile);
    if (token !== expectedToken) return false;
    unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

function tryCreateLock(lockFile, token) {
  let fd;
  try {
    fd = openSync(lockFile, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
  // Once the lockfile exists on disk, any failure in writeSync/closeSync
  // would leak the lockfile if we returned without cleanup.
  try {
    writeSync(fd, token);
    closeSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* fd may already be closed */
    }
    try {
      unlinkSync(lockFile);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
  return true;
}

async function acquireAdvisoryLock(targetPath, { timeoutMs = 5000, pollMs = 25 } = {}) {
  const lockFile = lockFileFor(targetPath);
  ensurePrivateRuntimeRoot(dirname(lockFile));
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + timeoutMs;
  let stalePostDeadlineRetryUsed = false;
  const timeoutError = (holderPid) => {
    const err = new Error(`advisory lock timeout: ${targetPath} (${lockFile}) held by pid ${holderPid}`);
    err.code = 'EAGAIN';
    return err;
  };
  for (;;) {
    if (tryCreateLock(lockFile, token)) {
      return {
        lockFile,
        release() {
          // Verify ownership token before unlinking to avoid
          // unlinking another process's live lock after a stale
          // cleanup race.
          unlinkIfOwned(lockFile, token);
        },
      };
    }
    // Lock exists — check liveness for stale cleanup.
    const { pid: holderPid, token: holderToken } = readLockInfo(lockFile);
    if (!isPidAlive(holderPid)) {
      // DOUBLE-CHECK: under heavy multi-process load, process.kill(pid,0)
      // can return false-negative (transient ESRCH) for an active
      // holder, causing this branch to unlink an in-use lock and break
      // mutual exclusion. Verified empirically by s13 stress test —
      // two workers were observed holding the same lock for 119ms.
      //
      // Mitigation: re-read the lockfile after a short delay; if pid
      // or token changed, another contender already handled cleanup
      // and we should re-poll. Otherwise re-test liveness; only when
      // BOTH checks agree the holder is dead do we cleanup. The
      // sleep also absorbs the OS-level race window where the
      // original kill(0) returned ESRCH before the holder fully
      // exited the spawn/registration window.
      await sleep(50);
      const second = readLockInfo(lockFile);
      if (second.pid !== holderPid || second.token !== holderToken) {
        // Another contender already touched the lock; resync — but the
        // deadline governs this branch too. Without the check a lock
        // that keeps changing hands (or a holder that keeps failing the
        // first liveness probe) spun here forever instead of raising
        // the documented EAGAIN timeout.
        if (Date.now() >= deadline) throw timeoutError(second.pid || holderPid);
        continue;
      }
      if (!isPidAlive(holderPid)) {
        unlinkIfOwned(lockFile, holderToken);
        // Small jitter to avoid avalanche of contenders racing into
        // tryCreateLock simultaneously after the unlink.
        await sleep(Math.floor(Math.random() * 5) + 1);
        // The stale lock is gone: retry the create. Past the deadline
        // exactly ONE such attempt is granted — a lock repeatedly taken
        // and abandoned by dying holders would otherwise livelock here
        // instead of raising the documented timeout.
        if (Date.now() < deadline) continue;
        if (!stalePostDeadlineRetryUsed) {
          stalePostDeadlineRetryUsed = true;
          continue;
        }
        throw timeoutError(holderPid);
      }
      // Second probe says the holder is alive after all — fall through to
      // the live-holder wait so the same deadline applies.
      if (Date.now() >= deadline) throw timeoutError(holderPid);
      await sleep(pollMs);
      continue;
    }
    if (Date.now() >= deadline) throw timeoutError(holderPid);
    await sleep(pollMs);
  }
}

export async function withAdvisoryLocks(paths, fn) {
  const seen = new Set();
  const ordered = [];
  for (const p of Array.isArray(paths) ? paths : [paths]) {
    if (!p) continue;
    const key = process.platform === 'win32' ? String(p).toLowerCase() : String(p);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(String(p));
  }
  // Acquire in a casing-canonical order so two callers locking the same set
  // with different path casing on Windows cannot acquire in opposite orders
  // and deadlock. (The dedup above already keys on the canonical form.)
  const _lockSortKey = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  ordered.sort((a, b) => compareCodePoints(_lockSortKey(a), _lockSortKey(b)));
  const acquired = [];
  try {
    for (const p of ordered) {
      acquired.push(await acquireAdvisoryLock(p));
    }
    return await fn();
  } finally {
    // Release in reverse acquisition order.
    for (let i = acquired.length - 1; i >= 0; i -= 1) {
      try {
        acquired[i].release();
      } catch {
        /* best-effort */
      }
    }
  }
}
