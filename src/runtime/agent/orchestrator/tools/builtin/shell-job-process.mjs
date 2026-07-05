import { spawn, spawnSync } from 'child_process';

// Process/pid lifecycle helpers for background shell jobs: liveness probing,
// tree-kill, the module-level live-job pid registry, and the CLI-shutdown exit
// hook that reaps owned children. Async jobs are intentionally CLI-owned; no
// restart replay or daemon handoff is attempted.

export function isPidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
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
export function _sweepLiveJobsSync() {
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
