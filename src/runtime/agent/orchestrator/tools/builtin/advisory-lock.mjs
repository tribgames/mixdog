// Cross-process advisory lock for write/edit operations. Uses a sibling
// lockfile written exclusively (`wx`) and a process.kill(pid, 0) liveness
// check to clean up after crashed holders. Pair with the in-process
// withPathLock for the same target: in-process serialises async callers
// in this Node, advisory lock serialises across Node processes.
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, basename, join } from 'path';
import { randomBytes } from 'crypto';

function lockFileFor(targetPath) {
    return join(dirname(targetPath), `.${basename(targetPath)}.mixdog-lock`);
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
        // Token format: `${pid}.${hex}`. Fall back to legacy bare-pid contents.
        const dot = raw.indexOf('.');
        if (dot > 0) {
            const pid = parseInt(raw.slice(0, dot), 10);
            return { pid: Number.isInteger(pid) ? pid : 0, token: raw };
        }
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
        try { closeSync(fd); } catch { /* fd may already be closed */ }
        try { unlinkSync(lockFile); } catch { /* best-effort cleanup */ }
        throw err;
    }
    return true;
}

export async function acquireAdvisoryLock(targetPath, { timeoutMs = 5000, pollMs = 25 } = {}) {
    const lockFile = lockFileFor(targetPath);
    // Ensure parent directory exists before openSync('wx'); the lockfile lives
    // next to the target, so writes to new files in missing parent dirs would
    // otherwise fail with ENOENT here.
    mkdirSync(dirname(lockFile), { recursive: true });
    const token = `${process.pid}.${randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + timeoutMs;
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
            await new Promise((r) => setTimeout(r, 50));
            const second = readLockInfo(lockFile);
            if (second.pid !== holderPid || second.token !== holderToken) {
                // Another contender already touched the lock; resync.
                continue;
            }
            if (!isPidAlive(holderPid)) {
                unlinkIfOwned(lockFile, holderToken);
                // Small jitter to avoid avalanche of contenders racing into
                // tryCreateLock simultaneously after the unlink.
                await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5) + 1));
            }
            continue;
        }
        if (Date.now() >= deadline) {
            const err = new Error(`advisory lock timeout: ${lockFile} held by pid ${holderPid}`);
            err.code = 'EAGAIN';
            throw err;
        }
        await new Promise((r) => setTimeout(r, pollMs));
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
    ordered.sort((a, b) => {
        const ka = _lockSortKey(a), kb = _lockSortKey(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const acquired = [];
    try {
        for (const p of ordered) {
            acquired.push(await acquireAdvisoryLock(p));
        }
        return await fn();
    } finally {
        // Release in reverse acquisition order.
        for (let i = acquired.length - 1; i >= 0; i -= 1) {
            try { acquired[i].release(); } catch { /* best-effort */ }
        }
    }
}
