import { spawn, spawnSync } from 'child_process';
import { tryNativeProcessSnapshot } from './native-search-client.mjs';

// Process/pid lifecycle helpers for background shell jobs: liveness probing,
// tree-kill, the module-level live-job pid registry, and the CLI-shutdown exit
// hook that reaps owned children. Async jobs are intentionally CLI-owned; no
// restart replay or daemon handoff is attempted.

export function isPidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

// Admission follows the owned process group on POSIX, not just the spawned
// shell. A shell can exit after launching a descendant which remains in its
// detached group. Windows has no process-group probe in Node; the root PID is
// the strongest non-invasive lifecycle signal available here (tree-kill still
// uses taskkill /T).
function isProcessTreeAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (process.platform === 'win32') return isPidAlive(pid);
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

const windowsSnapshotCache = { at: 0, rows: null, inFlight: null };
function windowsProcessSnapshot({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && windowsSnapshotCache.rows && now - windowsSnapshotCache.at < 750) {
        return Promise.resolve(windowsSnapshotCache.rows);
    }
    if (windowsSnapshotCache.inFlight) return windowsSnapshotCache.inFlight;
    windowsSnapshotCache.inFlight = Promise.resolve(tryNativeProcessSnapshot()).then(
        (snapshot) => {
            const rows = normalizeWindowsSnapshot(snapshot);
            if (rows) {
                windowsSnapshotCache.at = Date.now();
                windowsSnapshotCache.rows = rows;
            }
            return rows;
        },
        () => null,
    ).finally(() => {
        windowsSnapshotCache.inFlight = null;
    });
    return windowsSnapshotCache.inFlight;
}

function normalizeWindowsSnapshot(snapshot) {
    if (snapshot instanceof Map) return snapshot;
    if (!Array.isArray(snapshot)) return null;
    const rows = new Map();
    for (const row of snapshot) {
        const rowPid = Number(row?.pid);
        const parentPid = Number(row?.parentPid);
        if (!Number.isFinite(rowPid) || rowPid <= 0 || !Number.isFinite(parentPid)) continue;
        rows.set(rowPid, { pid: rowPid, parentPid, identity: String(row?.identity ?? '') });
    }
    return rows;
}

// Standby-pool support: capture every current descendant with a creation-time
// identity so a PID reused after the baseline snapshot cannot be allowlisted.
// Unknown snapshots stay conservative: callers discard instead of reusing.
export async function windowsPidDescendants(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return new Map();
    if (process.platform !== 'win32') return new Map();
    let rows = null;
    try { rows = await windowsProcessSnapshot({ fresh: true }); } catch { rows = null; }
    if (!rows) return null;
    const owned = new Set([pid]);
    const descendants = new Map();
    let discovered = true;
    while (discovered) {
        discovered = false;
        for (const row of rows.values()) {
            if (!owned.has(row.pid) && owned.has(row.parentPid)) {
                owned.add(row.pid);
                descendants.set(row.pid, row.identity);
                discovered = true;
            }
        }
    }
    return descendants;
}

export async function windowsPidHasDescendants(pid, { allowedDescendants = null } = {}) {
    const descendants = await windowsPidDescendants(pid);
    if (!descendants) return true;
    if (!(allowedDescendants instanceof Map)) return descendants.size > 0;
    for (const [descendantPid, identity] of descendants) {
        if (allowedDescendants.get(descendantPid) !== identity) return true;
    }
    return false;
}

// Invoke onQuiescent exactly once, synchronously when already quiescent or
// after positive liveness probes stop observing the owned tree/group.
export function trackProcessTreeQuiescence(
    pid,
    onQuiescent,
    {
        pollMs = process.platform === 'win32' ? 250 : 25,
        probe = null,
        platform = process.platform,
        windowsSnapshot = windowsProcessSnapshot,
        windowsSnapshotSpawn = spawn,
        waitForRootExit = false,
    } = {},
) {
    let settled = false;
    let timer = null;
    let rootExitConfirmed = !waitForRootExit;
    const rootExitCheck = Promise.withResolvers();
    let rootExitCheckComplete = false;
    const ownedWindowsProcesses = new Map();
    if (platform === 'win32') {
        // The PID returned by spawn is durable pre-exit ownership evidence.
        // Seed it before the first asynchronous snapshot so a child whose
        // parent is this PID remains attributable even if the root is already
        // absent when the native snapshot returns.
        ownedWindowsProcesses.set(pid, null);
    }
    const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        try {
            Promise.resolve(onQuiescent?.()).catch(() => {});
        } catch { /* lifecycle cleanup must not throw */ }
    };
    const markRootExitChecked = () => {
        if (!rootExitConfirmed || rootExitCheckComplete) return;
        rootExitCheckComplete = true;
        rootExitCheck.resolve();
    };
    const applyWindowsSnapshot = (snapshot) => {
        if (settled) return;
        const rows = normalizeWindowsSnapshot(snapshot);
        let alive = true;
        if (!rows) {
            const candidates = [...ownedWindowsProcesses.keys()];
            alive = candidates.some((candidatePid) => isPidAlive(candidatePid));
        } else {
            const root = rows.get(pid);
            if (root && ownedWindowsProcesses.get(pid) == null) {
                ownedWindowsProcesses.set(pid, root.identity);
            }
            let discovered = true;
            while (discovered) {
                discovered = false;
                for (const row of rows.values()) {
                    if (
                        !ownedWindowsProcesses.has(row.pid)
                        && ownedWindowsProcesses.has(row.parentPid)
                    ) {
                        ownedWindowsProcesses.set(row.pid, row.identity);
                        discovered = true;
                    }
                }
            }
            for (const [ownedPid, identity] of ownedWindowsProcesses) {
                const current = rows.get(ownedPid);
                if (!current || (identity != null && current.identity !== identity)) {
                    ownedWindowsProcesses.delete(ownedPid);
                }
            }
            alive = ownedWindowsProcesses.size > 0;
        }
        markRootExitChecked();
        if (rootExitConfirmed && !alive) finish();
    };
    const check = (fresh = false) => {
        let alive = true;
        try {
            if (typeof probe === 'function') {
                alive = probe(pid) === true;
            } else if (platform !== 'win32') {
                // The negative PID is the ownership boundary: never substitute
                // a root-only probe on POSIX.
                alive = isProcessTreeAlive(pid);
            } else {
                Promise.resolve(windowsSnapshot({ fresh, spawnFn: windowsSnapshotSpawn })).then(applyWindowsSnapshot, () => {});
                return;
            }
        } catch {
            return;
        }
        markRootExitChecked();
        if (rootExitConfirmed && !alive) finish();
    };
    check();
    if (!settled) {
        timer = setInterval(check, Math.max(1, Number(pollMs) || 25));
        if (typeof timer.unref === 'function') timer.unref();
    }
    return {
        get pending() { return !settled; },
        afterRootExitCheck() { return rootExitCheck.promise; },
        rootExited() {
            if (settled || rootExitConfirmed) return false;
            rootExitConfirmed = true;
            check(true);
            return true;
        },
        cancel() {
            if (settled) return false;
            settled = true;
            if (timer) clearInterval(timer);
            markRootExitChecked();
            return true;
        },
    };
}

export function killProcessTree(pid, signal = 'SIGTERM') {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        } else {
            try { process.kill(-pid, signal); }
            catch { process.kill(pid, signal); }
            // SIGKILL escalation: a background child that ignores SIGTERM must
            // not survive (foreground treeKill / persistent _killProcessTree
            // already do this). After a 3s grace, force-kill the group/pid.
            // unref so this backstop never holds the host process open.
            if (signal === 'SIGTERM') {
                const t = setTimeout(() => {
                    try { process.kill(-pid, 'SIGKILL'); }
                    catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
                }, 3000);
                if (t.unref) t.unref();
            }
        }
        return true;
    } catch {
        return false;
    }
}

// Module-level tracking of live background-job pids so CLI shutdown can reap
// owned children. Async jobs are intentionally CLI-owned; no restart replay or
// daemon handoff is attempted.
export const _liveJobPids = new Set();
export const _liveJobIdsByPid = new Map();
let _shellJobsExitHookInstalled = false;
export function _registerLiveJobPid(pid, jobId = null) {
    if (Number.isFinite(pid) && pid > 0) {
        _liveJobPids.add(pid);
        if (jobId) _liveJobIdsByPid.set(pid, jobId);
    }
}
export function _unregisterLiveJobPid(pid) {
    if (Number.isFinite(pid) && pid > 0) {
        _liveJobPids.delete(pid);
        _liveJobIdsByPid.delete(pid);
    }
}
export function _killLiveJobPid(pid, { sync = false } = {}) {
    try {
        if (process.platform === 'win32') {
            if (sync) {
                spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
                    windowsHide: true,
                    stdio: 'ignore',
                    timeout: 1500,
                });
            } else {
                spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
            }
        } else {
            try { process.kill(-pid, 'SIGKILL'); }
            catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
        }
        return true;
    } catch {
        return false;
    }
}
function _sweepLiveJobsSync() {
    for (const pid of _liveJobPids) {
        _killLiveJobPid(pid, { sync: true });
    }
    _liveJobPids.clear();
    _liveJobIdsByPid.clear();
}
function _ensureProcessListenerHeadroom(events, extra = 1) {
    try {
        if (typeof process.getMaxListeners !== 'function' || typeof process.setMaxListeners !== 'function') return;
        const current = process.getMaxListeners();
        if (current === 0) return;
        let needed = current;
        for (const event of events) needed = Math.max(needed, process.listenerCount(event) + extra);
        if (needed > current) process.setMaxListeners(needed);
    } catch { /* ignore */ }
}
export function _installShellJobsExitHook() {
    if (_shellJobsExitHookInstalled) return;
    _shellJobsExitHookInstalled = true;
    _ensureProcessListenerHeadroom(['exit', 'SIGTERM', 'SIGINT', 'SIGHUP'], 1);
    try { process.on('exit', _sweepLiveJobsSync); } catch { /* ignore */ }
    // For terminating signals, sweep then restore default POSIX termination
    // only when we are the last handler. A sweep-only handler swallows the
    // signal and keeps the process alive; when several such handlers coexist,
    // each removes itself and the last one to run re-raises so the default
    // action takes effect without preempting graceful-shutdown listeners.
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        const onSignal = () => {
            _sweepLiveJobsSync();
            try { process.removeListener(sig, onSignal); } catch { /* ignore */ }
            try {
                if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
            } catch { /* ignore */ }
        };
        try { process.on(sig, onSignal); } catch { /* ignore */ }
    }
}
