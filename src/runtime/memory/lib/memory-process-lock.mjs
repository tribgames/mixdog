// Process lock for the standalone memory MCP entry.
// A direct entry (including the isolated daemon child) owns this lock.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { killProcessTreesSync } from '../../agent/orchestrator/mcp/child-tree.mjs';

// Windows: the tree kill's whole pass (a table read under load included).
const PREVIOUS_SERVER_KILL_TIMEOUT_MS = 10_000;

export function parsePositivePid(value) {
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function isPidAliveLocal(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

const POSIX_ENV = () => ({ ...process.env, LC_ALL: 'C', LANG: 'C' });

// When a process was created, as epoch-ms bounds { low, high } around the true
// time, or null when it cannot be read. Linux: /proc/<pid>/stat starttime
// (clock ticks since boot) against /proc/uptime, both read at `now`; the
// margin covers one tick, uptime's centiseconds and the read skew.
export function linuxCreatedBounds(statText, uptimeText, clockTicks, now) {
  const ticks = linuxStartTicks(statText);
  const startTicks = Number(ticks);
  const uptime = Number(String(uptimeText || '').split(' ')[0]);
  if (ticks === null || !Number.isFinite(uptime) || !(clockTicks > 0)) return null;
  const created = now - (uptime - startTicks / clockTicks) * 1000;
  const margin = 1000 / clockTicks + 20;
  return { low: created - margin, high: created + margin };
}

// Elsewhere: `ps -o lstart=` under the C locale, whole seconds.
export function lstartCreatedBounds(text) {
  const started = Date.parse(String(text || '').trim());
  return Number.isFinite(started) ? { low: started, high: started + 1000 } : null;
}

// /proc/<pid>/stat's starttime field (clock ticks since boot), as its digits.
function linuxStartTicks(statText) {
  const stat = String(statText || '');
  if (!stat.includes(')')) return null;
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return /^\d+$/.test(ticks || '') ? ticks : null;
}

/** A process's start token, as recorded in the lock and compared on
 *  recovery, or null when it cannot be read: Linux `/proc/<pid>/stat`
 *  starttime, elsewhere `ps -o lstart=` under the C locale. The two sources
 *  never mix (each is prefixed), and both are read from the same host. */
export function linuxStartToken(statText) {
  const ticks = linuxStartTicks(statText);
  return ticks ? `proc:${ticks}` : null;
}
export function lstartStartToken(text) {
  const started = String(text || '').trim();
  return Number.isFinite(Date.parse(started)) ? `lstart:${started}` : null;
}

function posixStartToken(pid) {
  try {
    if (process.platform === 'linux') return linuxStartToken(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: POSIX_ENV(),
      timeout: 5000,
    });
    return lstartStartToken(r.stdout);
  } catch {
    return null;
  }
}

function posixCreatedBounds(pid) {
  const env = POSIX_ENV();
  try {
    if (process.platform === 'linux') {
      const ticks = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', env, timeout: 5000 }).stdout);
      const now = Date.now();
      return linuxCreatedBounds(
        fs.readFileSync(`/proc/${pid}/stat`, 'utf8'),
        fs.readFileSync('/proc/uptime', 'utf8'),
        ticks,
        now
      );
    }
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env, timeout: 5000 });
    return lstartCreatedBounds(r.stdout);
  } catch {
    return null;
  }
}

/** Who holds a lock's pid, from the start token the writer recorded and the
 *  pid's current one: 'writer' (the same token: the server that wrote the
 *  lock), 'other' (a different one: the writer is gone and its pid reused) or
 *  'unproven' (the current token cannot be read). */
export function lockHolderTokenVerdict(recordedToken, currentToken) {
  if (!currentToken) return 'unproven';
  return currentToken === recordedToken ? 'writer' : 'other';
}

/** The legacy verdict, for a lock written without a start token: from the
 *  holder's creation bounds, 'writer' (created before the lock was written),
 *  'other' (created after) or 'unproven' (unreadable, or too close to the
 *  write to tell). Only 'writer' may be signalled, and only 'other' or a dead
 *  pid lets the lock be recovered. */
export function lockHolderVerdict(bounds, lockWrittenAt) {
  if (!bounds) return 'unproven';
  if (bounds.high <= lockWrittenAt) return 'writer';
  if (bounds.low > lockWrittenAt) return 'other';
  return 'unproven';
}

/** The lock's text: the writer's pid, then (POSIX) its start token on the
 *  next line. */
export function formatLock(pid, token) {
  return token ? `${pid}\n${token}` : String(pid);
}
export function parseLock(text) {
  const [pidLine = '', token = ''] = String(text || '').split(/\r?\n/);
  return { pid: Number(pidLine.trim()), token: token.trim() || null };
}

// The lock names its writer only while that writer lives. A POSIX writer
// recorded its start token; the pid's holder is the writer exactly when its
// token is still the same. Accepted: lstart has whole seconds, so a writer
// that died within its first second, its pid reused in that same second,
// would pass as the writer; sequential pid allocation makes that impractical,
// and treating same-second tokens as unproven would block every restart.
// Windows compares the holder's creation time against
// the lock's write time inside the shared tree kill: its creation times are
// sub-millisecond, and a pid is only reused after the writer died, after the
// write. A lock without a token (an older writer) keeps the creation-bounds
// verdict. A pid taken over since is never signalled; one whose identity
// cannot be proven is neither signalled nor evicted (fail closed).
function killPreviousServer(pid, recordedToken, lockWrittenAt, log = () => {}) {
  if (pid <= 0 || pid === process.pid) return false;
  if (process.platform === 'win32') {
    const status = killProcessTreesSync([pid], {
      aliveAt: lockWrittenAt,
      timeoutMs: PREVIOUS_SERVER_KILL_TIMEOUT_MS,
    });
    if (status === 0) {
      log(`[memory-service] Killed previous server PID ${pid}\n`);
      return true;
    }
    if (status === 128) {
      log(`[memory-service] PID ${pid} is not the lock's writer any more (stale lock), proceeding\n`);
      return true;
    }
    log(`[memory-service] Killing previous server PID ${pid} failed (status ${status})\n`);
    return false;
  } else {
    const verdict = !isPidAliveLocal(pid)
      ? 'gone'
      : recordedToken
        ? lockHolderTokenVerdict(recordedToken, posixStartToken(pid))
        : lockHolderVerdict(posixCreatedBounds(pid), lockWrittenAt);
    if (verdict === 'gone' || verdict === 'other' || (verdict === 'unproven' && !isPidAliveLocal(pid))) {
      log(`[memory-service] PID ${pid} is not the lock's writer any more (stale lock), proceeding\n`);
      return true;
    }
    if (verdict === 'unproven') {
      log(
        `[memory-service] PID ${pid} may still be the lock's writer and cannot be proven otherwise; leaving it running\n`
      );
      return false;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    // Poll for death up to 2s
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') {
          log(`[memory-service] Killed previous server PID ${pid}\n`);
          return true;
        }
      }
      // Synchronous 50ms sleep via shared buffer spin
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    log(`[memory-service] PID ${pid} still alive after SIGKILL\n`);
    return false;
  }
}

export function acquireLock(lockFile, log = () => {}) {
  // Multi-instance mode is coordinated by the unified daemon, so a direct MCP
  // entry does not evict an already-running peer from another client.
  if (process.env.MIXDOG_MULTI_INSTANCE === '1') return;
  try {
    if (fs.existsSync(lockFile)) {
      const lockWrittenAt = fs.statSync(lockFile).mtimeMs;
      const { pid: lockedPid, token } = parseLock(fs.readFileSync(lockFile, 'utf8'));
      if (lockedPid > 0 && lockedPid !== process.pid) {
        const killed = killPreviousServer(lockedPid, token, lockWrittenAt, log);
        if (!killed) {
          log(`[memory-service] Could not kill previous server PID ${lockedPid}, aborting\n`);
          process.exit(1);
        }
        try {
          fs.unlinkSync(lockFile);
        } catch {}
      }
    }
    // Read before the lock exists: an unreadable token leaves a pid-only lock,
    // which a successor judges by the legacy verdict.
    const token = process.platform === 'win32' ? null : posixStartToken(process.pid);
    const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeSync(fd, formatLock(process.pid, token));
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e.code === 'EEXIST') {
      log(`[memory-service] Lock file exists (EEXIST) — another instance is already running, exiting\n`);
      process.exit(0);
    }
    log(`[memory-service] Lock acquisition failed: ${e.message}\n`);
    process.exit(1);
  }
}

export function releaseLock(lockFile) {
  try {
    if (parseLock(fs.readFileSync(lockFile, 'utf8')).pid === process.pid) fs.unlinkSync(lockFile);
  } catch {}
}
