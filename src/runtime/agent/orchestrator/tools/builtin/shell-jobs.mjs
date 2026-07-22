import { spawn } from 'child_process';
import { existsSync, readFileSync, statSync, unlinkSync, watch as fsWatch, writeFileSync } from 'fs';
import { basename } from 'path';
import { scrubLoaderVars, scrubProviderSecrets } from '../env-scrub.mjs';
import {
    normalizeToolNotifyContext,
    notifyToolCompletion,
} from '../../../../shared/tool-execution-contract.mjs';
import {
    renderShellCompletionEnvelope,
    shellCompletionInstruction,
    renderShellPromptStallEnvelope,
    shellPromptStallInstruction,
} from '../../../../shared/task-notification-envelope.mjs';
import {
    completeBackgroundTask,
    notifyBackgroundTaskProgress,
    getBackgroundTask,
} from '../../../../shared/background-tasks.mjs';
import { startChildGuardian } from '../../../../shared/child-guardian.mjs';
import { _startBackgroundShellJobImpl } from './shell-job-spawn.mjs';
import { detachedSpawnOpts } from '../../../../shared/spawn-flags.mjs';
import {
    getShellJobsDir,
    shellJobStdoutPath,
    shellJobStderrPath,
    shellJobExitPath,
    shellJobDonePath,
    shellJobEnforcedPath,
    resolveJobOwnerHostPid,
    trimShellJobSpill,
    writeShellJobDetail,
    readShellJobDetail,
} from './shell-job-paths.mjs';
import {
    isPidAlive,
    trackProcessTreeQuiescence,
    killProcessTree,
    _unregisterLiveJobPid,
    _installShellJobsExitHook,
    _registerLiveJobPid,
    _liveJobPids,
    _liveJobIdsByPid,
    _killLiveJobPid,
} from './shell-job-process.mjs';
import {
    attachJobInsights,
    looksLikeInteractivePrompt,
    readPromptTail,
    shellJobOutputBytes,
    shellJobPublicTaskResult,
    SHELL_JOB_OUTPUT_DISK_CAP,
} from './lib/shell-job-insights.mjs';
import {
    sleep,
    awaitSpawnReady,
    adoptSpawnErrorHandler,
    discardSpawnErrorGuard,
    rollbackSpawnedChild,
    shellQuoteSingle,
    psSingleQuote,
    isPowerShellShell,
} from './lib/shell-spawn-helpers.mjs';

// Facade re-exports: path/detail helpers and the job-not-found message moved
// to sibling modules; keep existing importers of shell-jobs.mjs resolving.
export { buildJobNotFoundMessage } from './shell-job-paths.mjs';
export { shellJobPublicTaskResult } from './lib/shell-job-insights.mjs';

globalThis.__mixdogShellJobsRuntimeLoaded = true;


// Poll cadence for the adopted-job output-cap self-tick (mirrors the
// foreground sizeWatchdog in shell-command.mjs).
const ADOPTED_JOB_CAP_POLL_MS = 1_000;

const SHELL_JOB_PROMPT_STALL_MS = 45_000;

export async function waitForShellJob(jobId, { timeoutMs = 30_000, pollMs = 250 } = {}) {
    const started = Date.now();
    const deadline = started + Math.max(0, timeoutMs);
    let detail = refreshShellJob(jobId);
    if (!detail) return null;
    while (detail && detail.status === 'running' && Date.now() < deadline) {
        await sleep(Math.max(25, pollMs));
        detail = refreshShellJob(jobId);
    }
    const withInsights = attachJobInsights(detail);
    if (!withInsights) return null;
    withInsights.waitedMs = Date.now() - started;
    if (withInsights.status === 'running') withInsights.waitTimedOut = true;
    return withInsights;
}

// Non-blocking peek at a background task (CC BashOutput analogue): refresh its
// status and return current stdout/stderr tail preview WITHOUT waiting for
// completion. Returns null if the job id is unknown.
export function peekShellJob(jobId) {
    const detail = refreshShellJob(jobId);
    if (!detail) return null;
    return attachJobInsights(detail);
}

// Terminate a running background task (CC KillShell analogue): kill the process
// tree and mark the job failed/137. Returns null if unknown; a detail with
// killed:false if it had already finished.
export function killShellJob(jobId) {
    const detail = readShellJobDetail(jobId);
    if (!detail) return null;
    if (detail.status !== 'running') {
        if (detail.terminationPending === true) {
            killProcessTree(detail.pid, 'SIGKILL');
            armShellJobLeaseReapDeadline(jobId);
            return { ...detail, killed: true, note: 'termination still awaiting confirmed process exit' };
        }
        releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid);
        return { ...detail, killed: false, note: `task already ${detail.status}` };
    }
    killProcessTree(detail.pid, 'SIGTERM');
    detail.status = 'failed';
    detail.exitCode = 137;
    detail.error = 'killed by user (KillShell)';
    detail.finishedAt = new Date().toISOString();
    trimShellJobSpill(detail);
    detail.terminationPending = true;
    writeShellJobDetail(detail);
    releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid, {
        onConfirmed: () => {
            detail.terminationPending = false;
            try { writeShellJobDetail(detail); } catch {}
        },
    });
    armShellJobLeaseReapDeadline(jobId);
    return { ...attachJobInsights(detail), killed: true };
}

export function refreshShellJob(jobId) {
    const detail = readShellJobDetail(jobId);
    if (!detail) return null;
    if (detail.status !== 'running') return detail;
    const exitPath = shellJobExitPath(jobId);
    const donePath = shellJobDonePath(jobId);
    // Gate completion on donePath existence. The wrapper writes the
    // exit-code file FIRST and `touch donePath` strictly AFTER, so a
    // visible donePath proves the exit file is fully flushed. Reading
    // exit before donePath landed produced empty-string -> NaN ->
    // exitCode=null -> spurious 'failed' status for processes that
    // actually exited 0.
    if (existsSync(donePath)) {
        let exitCode = null;
        try {
            const raw = readFileSync(exitPath, 'utf-8').trim();
            const parsed = parseInt(raw, 10);
            exitCode = Number.isFinite(parsed) ? parsed : null;
        } catch { /* ignore */ }
        let finishedAt = new Date().toISOString();
        try {
            finishedAt = new Date(statSync(donePath).mtimeMs).toISOString();
        } catch { /* ignore */ }
        detail.status = exitCode === 0 ? 'completed' : 'failed';
        detail.exitCode = exitCode;
        detail.finishedAt = finishedAt;
        // Job finished: cap its spill to a bounded tail so a flooding
        // producer can't leave a 100MB stdout/stderr log behind.
        trimShellJobSpill(detail);
        writeShellJobDetail(detail);
        releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid);
        return detail;
    }
    const timeoutMs = Number(detail.timeoutMs || 0);
    const startedAtMs = Date.parse(detail.startedAt || '');
    if (timeoutMs > 0 && Number.isFinite(startedAtMs) && Date.now() - startedAtMs > timeoutMs) {
        killProcessTree(detail.pid, 'SIGTERM');
        detail.status = 'failed';
        detail.exitCode = 124;
        detail.finishedAt = new Date().toISOString();
        detail.error = `timed out after ${timeoutMs} ms`;
        trimShellJobSpill(detail);
        detail.terminationPending = true;
        writeShellJobDetail(detail);
        releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid, {
            onConfirmed: () => {
                detail.terminationPending = false;
                try { writeShellJobDetail(detail); } catch {}
            },
        });
        return detail;
    }
    // Output size watchdog: cap the job's spilled stdout/stderr at the same
    // ceiling as foreground runs. Past it, SIGKILL the tree and flag the job
    // so a runaway producer cannot fill the filesystem.
    if (shellJobOutputBytes(detail) > SHELL_JOB_OUTPUT_DISK_CAP) {
        killProcessTree(detail.pid, 'SIGKILL');
        detail.status = 'failed';
        detail.exitCode = 137;
        detail.finishedAt = new Date().toISOString();
        detail.error = `output exceeded ${SHELL_JOB_OUTPUT_DISK_CAP} byte cap`;
        trimShellJobSpill(detail);
        detail.terminationPending = true;
        writeShellJobDetail(detail);
        releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid, {
            onConfirmed: () => {
                detail.terminationPending = false;
                try { writeShellJobDetail(detail); } catch {}
            },
        });
        return detail;
    }
    if (detail.pid && !isPidAlive(detail.pid)) {
        detail.status = 'failed';
        detail.finishedAt = new Date().toISOString();
        detail.error = 'process exited without completion marker';
        writeShellJobDetail(detail);
        releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid);
    }
    return detail;
}

export async function startBackgroundShellJob(options) {
    return _startBackgroundShellJobImpl(options || {});
}

// In-process completion watcher. After a background shell task is spawned the
// Lead session has no way to learn the task finished (no polling tool is
// auto-driven), so this registers an fs.watch on the shell-jobs dir filtered
// to `<jobId>.done` plus a ~2s polling fallback (fs.watch misses on some
// network / overlay filesystems) and a hard stop at timeoutMs + grace. When
// the job completes it reads the finished detail and delivers a shared async
// execution notification with type 'shell_task_result'.
//
// CLI-owned by design. If the CLI/runtime process exits, no notification is
// replayed or recovered later; shutdown cancels live jobs instead of handing
// them to a daemon.
//
// All timers are unref()'d and fs.watch is closed on completion/stop, so the
// watcher never keeps the host process alive.
const SHELL_JOB_WATCH_POLL_MS = 2000;
const SHELL_JOB_WATCH_GRACE_MS = 5000;
// 32-bit timer ceiling: setTimeout delays above 2^31-1 wrap to a tiny value
// and fire immediately. The resolved timeout is already clamped at parse time
// (bash-tool.mjs TIMER_MAX_MS), but sites that add grace to it can still exceed
// the ceiling, so clamp the summed delay here too.
const TIMER_MAX_MS = 2_147_483_647;
// Registry of armed background-job watchers keyed by jobId. task wait
// and `kill` actions already hold the completed outcome, so they cancel the
// armed watcher here to prevent a double-notify when its next poll fires.
const backgroundShellJobWatchers = new Map();
// Registry-level safety net keyed by jobId. It is intentionally independent of
// the fs.watch watcher below: if the watcher is cancelled, misses an event, or
// cannot be armed because the direct notifyFn is unavailable, this poller still
// reconciles the shell job into the shared background-task row.
const shellTaskSafetyPollers = new Map();
const shellJobResourceLeases = new Map();
const unpersistedTerminalJobs = new Set();
const shellJobQuiescenceTrackers = new Map();
function releaseShellJobResourceLease(jobId) {
    const lease = shellJobResourceLeases.get(jobId);
    if (!lease) return false;
    shellJobResourceLeases.delete(jobId);
    try { Promise.resolve(lease.release()).catch(() => {}); } catch { /* admission cleanup must not mask job state */ }
    return true;
}
// After a kill, the admission lease must not stay held forever by a process
// tree that refuses to die (crashpad-style daemons survive taskkill /T and
// keep the quiescence tracker pending). The tree stays tracked for cleanup;
// only the admission capacity is reclaimed so new shell work cannot deadlock
// on a saturated lane. 0 disables.
const _envLeaseReap = Math.floor(Number(process.env.MIXDOG_SHELL_LEASE_REAP_MS));
const SHELL_LEASE_REAP_MS = Number.isFinite(_envLeaseReap) && _envLeaseReap >= 0
    ? _envLeaseReap
    : 30_000;
function armShellJobLeaseReapDeadline(jobId) {
    if (!(SHELL_LEASE_REAP_MS > 0) || !shellJobResourceLeases.has(jobId)) return;
    const timer = setTimeout(() => {
        if (releaseShellJobResourceLease(jobId)) {
            console.warn(`[shell] task ${jobId}: admission lease force-released ${SHELL_LEASE_REAP_MS}ms after kill; process tree still not quiescent.`);
        }
    }, SHELL_LEASE_REAP_MS);
    if (typeof timer.unref === 'function') timer.unref();
}
export function attachShellJobResourceLease(jobId, lease, { allowUnpersisted = false } = {}) {
    if (!jobId || !lease || typeof lease.release !== 'function') return false;
    if (allowUnpersisted && unpersistedTerminalJobs.delete(jobId)) {
        try { Promise.resolve(lease.release()).catch(() => {}); } catch {}
        return false;
    }
    const detail = readShellJobDetail(jobId);
    if ((!detail && !allowUnpersisted) || (detail && detail.status !== 'running')) {
        try { Promise.resolve(lease.release()).catch(() => {}); } catch {}
        return false;
    }
    releaseShellJobResourceLease(jobId);
    shellJobResourceLeases.set(jobId, lease);
    return true;
}
export function releaseShellJobOwnershipWhenQuiescent(jobId, pid, {
    onConfirmed = null,
    allowLateLease = false,
    deferUntilRootExit = false,
} = {}) {
    const numericPid = Number(pid);
    if (!jobId || !Number.isFinite(numericPid) || numericPid <= 0) return false;
    const existing = shellJobQuiescenceTrackers.get(jobId);
    if (existing) {
        if (onConfirmed) existing.callbacks.add(onConfirmed);
        if (allowLateLease) existing.allowLateLease = true;
        if (!deferUntilRootExit) existing.tracker?.rootExited?.();
        return true;
    }
    const entry = {
        callbacks: new Set(onConfirmed ? [onConfirmed] : []),
        allowLateLease,
        tracker: null,
    };
    shellJobQuiescenceTrackers.set(jobId, entry);
    entry.tracker = trackProcessTreeQuiescence(numericPid, () => {
        shellJobQuiescenceTrackers.delete(jobId);
        _unregisterLiveJobPid(numericPid);
        for (const callback of entry.callbacks) {
            try { callback(); } catch {}
        }
        if (!releaseShellJobResourceLease(jobId) && entry.allowLateLease) {
            unpersistedTerminalJobs.add(jobId);
        }
    }, { waitForRootExit: deferUntilRootExit });
    return true;
}
export function trackChildUntilConfirmedExit(child, jobId, onConfirmed = null) {
    const pid = Number(child?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    _installShellJobsExitHook();
    _registerLiveJobPid(pid, jobId);
    let settled = false;
    const onError = () => {};
    const finish = () => {
        if (settled) return;
        settled = true;
        child.removeListener('exit', finish);
        child.removeListener('close', finish);
        child.removeListener('error', onError);
        releaseShellJobOwnershipWhenQuiescent(jobId, pid, {
            onConfirmed,
            allowLateLease: true,
        });
    };
    child.on('error', onError);
    child.once('exit', finish);
    child.once('close', finish);
    return true;
}
// Persistent notify ctx per jobId, set at FIRST arm and surviving cancel — so a
// re-arm after a task wait timeout can reconstruct the notify wiring without the
// caller threading the ctx back in. Deleted only in the watcher's cleanup() on
// settle (and explicitly in the kill path) so it cannot leak for entries that
// never complete.
const jobNotifyCtxByJobId = new Map();
// Live task waiter count per jobId. While >0 a synchronous caller is
// consuming the outcome, so the watcher must stay cancelled; the last waiter to
// leave (count===0) owns the decision to re-arm a still-running job.
const jobWaitWaiterCountByJobId = new Map();
const SHELL_TASK_SAFETY_POLL_MS = 5_000;
function shellJobTaskStatus(status) {
    if (status === 'completed') return 'completed';
    if (status === 'cancelled') return 'cancelled';
    return 'failed';
}
function buildShellCompletion(jobId, detail, reason) {
    const startedAtMs = Date.parse(detail?.startedAt || '');
    const finishedAtMs = Date.parse(detail?.finishedAt || '') || Date.now();
    const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, finishedAtMs - startedAtMs) : null;
    const exitCode = (typeof detail?.exitCode === 'number') ? detail.exitCode : null;
    const status = detail?.status || (reason === 'timeout' ? 'running' : 'unknown');
    const body = renderShellCompletionEnvelope({
        jobId,
        status,
        exitCode,
        elapsedMs,
        command: detail?.command,
        summary: detail?.summary,
        stdoutPreview: detail?.stdoutPreview,
        stderrPreview: detail?.stderrPreview,
        mergeStderr: detail?.mergeStderr,
    });
    const taskStatus = shellJobTaskStatus(status);
    return {
        status,
        taskStatus,
        exitCode,
        body,
        instruction: shellCompletionInstruction({ jobId, status, exitCode }),
        result: shellJobPublicTaskResult(detail),
        error: taskStatus === 'failed'
            ? (detail?.error || (status === 'running' ? 'background shell watcher deadline reached' : null))
            : null,
    };
}
function clearShellTaskSafetyNet(jobId) {
    const timer = shellTaskSafetyPollers.get(jobId);
    if (!timer) return;
    try { clearInterval(timer); } catch { /* ignore */ }
    shellTaskSafetyPollers.delete(jobId);
}
function armShellTaskSafetyNet(jobId) {
    if (!jobId || shellTaskSafetyPollers.has(jobId)) return;
    const tick = () => {
        try {
            const task = getBackgroundTask(jobId);
            if (!task || task.status !== 'running') {
                clearShellTaskSafetyNet(jobId);
                return;
            }
            const detail = attachJobInsights(refreshShellJob(jobId)) || readShellJobDetail(jobId);
            if (!detail) {
                completeBackgroundTask(jobId, {
                    status: 'failed',
                    error: 'shell job detail missing during safety reconciliation',
                    resultType: 'shell_task_result',
                    terminalReason: 'shell-safety-missing-detail',
                });
                clearShellTaskSafetyNet(jobId);
                return;
            }
            if (detail.status === 'running') return;
            // While a manual `task wait` caller is consuming the result
            // synchronously, do not send the async completion. The wait path
            // marks the task terminal with notify:false, and this poller will
            // stop on its next tick.
            if ((jobWaitWaiterCountByJobId.get(jobId) || 0) > 0) return;
            const completion = buildShellCompletion(jobId, detail, 'safety');
            completeBackgroundTask(jobId, {
                status: completion.taskStatus,
                result: completion.result,
                resultText: completion.body,
                error: completion.error,
                resultType: 'shell_task_result',
                instruction: completion.instruction,
                terminalReason: 'shell-safety-reconcile',
            });
            clearShellTaskSafetyNet(jobId);
        } catch (err) {
            try { process.stderr.write(`[shell-jobs] shell task safety poll failed: jobId=${jobId} err=${err?.message ?? String(err)}\n`); } catch { /* ignore */ }
        }
    };
    const timer = setInterval(tick, SHELL_TASK_SAFETY_POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    shellTaskSafetyPollers.set(jobId, timer);
}
function markShellJobCancelledByShutdown(jobId, reason = 'shutdown') {
    const detail = readShellJobDetail(jobId);
    if (!detail || detail.status !== 'running') return false;
    detail.status = 'cancelled';
    detail.exitCode = 137;
    detail.killed = true;
    detail.error = `cancelled by runtime shutdown (${reason})`;
    detail.finishedAt = new Date().toISOString();
    try { writeFileSync(detail.exitPath || shellJobExitPath(jobId), '137'); } catch { /* ignore */ }
    try { writeFileSync(detail.donePath || shellJobDonePath(jobId), ''); } catch { /* ignore */ }
    detail.terminationPending = true;
    writeShellJobDetail(detail);
    releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid, {
        onConfirmed: () => {
            detail.terminationPending = false;
            try { writeShellJobDetail(detail); } catch {}
        },
    });
    return true;
}
// Register a synchronous task waiter. Paired with endShellJobWait in a
// finally so the count can't leak on throw.
export function beginShellJobWait(jobId) {
    jobWaitWaiterCountByJobId.set(jobId, (jobWaitWaiterCountByJobId.get(jobId) || 0) + 1);
}
// Deregister a synchronous task waiter; returns the POST-decrement count so
// the last leaver (0) can decide whether to re-arm.
export function endShellJobWait(jobId) {
    const next = (jobWaitWaiterCountByJobId.get(jobId) || 0) - 1;
    if (next <= 0) { jobWaitWaiterCountByJobId.delete(jobId); return 0; }
    jobWaitWaiterCountByJobId.set(jobId, next);
    return next;
}
// Drop the persistent notify ctx for a jobId. Called from the kill path after
// cancel so a killed-but-never-fired entry can't leak its ctx.
export function clearShellJobNotifyCtx(jobId) {
    jobNotifyCtxByJobId.delete(jobId);
}
export function shutdownShellJobs(reason = 'runtime-close', { sync = false } = {}) {
    const livePids = [..._liveJobPids];
    const jobIds = new Set([..._liveJobIdsByPid.values()].filter(Boolean));
    const watcherJobIds = [...backgroundShellJobWatchers.keys()];
    for (const jobId of watcherJobIds) {
        jobIds.add(jobId);
        try { cancelBackgroundShellJobWatch(jobId); } catch { /* ignore */ }
    }
    for (const pid of livePids) _killLiveJobPid(pid, { sync });
    let marked = 0;
    for (const jobId of jobIds) {
        try { if (markShellJobCancelledByShutdown(jobId, reason)) marked += 1; } catch { /* ignore */ }
    }
    unpersistedTerminalJobs.clear();
    backgroundShellJobWatchers.clear();
    for (const jobId of [...shellTaskSafetyPollers.keys()]) clearShellTaskSafetyNet(jobId);
    jobNotifyCtxByJobId.clear();
    jobWaitWaiterCountByJobId.clear();
    return { killed: livePids.length, cancelledJobs: marked, cancelledWatchers: watcherJobIds.length };
}
// Cancel (and unregister) an armed watcher without notifying. Idempotent: a
// no-op when no watcher is armed, and the per-watcher cancel respects the
// `settled` guard so it cannot race a real completion notify. The persistent
// notify ctx survives cancel (see jobNotifyCtxByJobId) so a re-arm can recover
// it; return value is no longer relied upon by callers.
export function cancelBackgroundShellJobWatch(jobId) {
    const entry = backgroundShellJobWatchers.get(jobId);
    if (!entry) return null;
    if (typeof entry.cancel === 'function') entry.cancel();
    return entry.notifyCtx || null;
}
// notifyCtx may be omitted on RE-ARM — it then falls back to the persistent
// ctx captured at first arm (jobNotifyCtxByJobId).
export function watchBackgroundShellJob(jobId, notifyCtx) {
    armShellTaskSafetyNet(jobId);
    const ctx = (notifyCtx && typeof notifyCtx.notifyFn === 'function')
        ? normalizeToolNotifyContext(notifyCtx)
        : (jobId ? jobNotifyCtxByJobId.get(jobId) : null);
    if (!jobId || !ctx || typeof ctx.notifyFn !== 'function') {
        // Direct/non-dispatch callers have no push target; the task still runs
        // and remains pollable via task control, so this is not a failure.
        return;
    }
    // Idempotent arm: if a watcher is already registered for this jobId, leave
    // it in place. Lets task wait's re-arm-after-timeout path call this
    // unconditionally without stacking duplicate watchers.
    if (backgroundShellJobWatchers.has(jobId)) return;
    // Persist the notify ctx on FIRST arm so a later re-arm can recover it even
    // after cancel cleared the live watcher entry.
    jobNotifyCtxByJobId.set(jobId, ctx);
    let settled = false;
    // Distinguishes a bare cancel (keep ctx for re-arm) from a real settle
    // (fire/timeout/hard-stop → drop ctx). cleanup() reads this.
    let cancelled = false;
    let watcher = null;
    let pollTimer = null;
    let hardStopTimer = null;
    let lastOutputBytes = null;
    let lastOutputAtMs = Date.now();
    let promptStallNotified = false;
    const cleanup = () => {
        if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
        if (pollTimer) { try { clearInterval(pollTimer); } catch { /* ignore */ } pollTimer = null; }
        if (hardStopTimer) { try { clearTimeout(hardStopTimer); } catch { /* ignore */ } hardStopTimer = null; }
        backgroundShellJobWatchers.delete(jobId);
        // Drop the persistent ctx only on a real settle (fire/timeout/hard-stop)
        // — NOT on a bare cancel, which keeps it for a possible re-arm.
        if (settled && !cancelled) jobNotifyCtxByJobId.delete(jobId);
    };
    // Cancel without notifying — used by task wait/cancel paths, which
    // already hold the completed outcome. Idempotent via the `settled` guard
    // so it can never race or double-fire against a real completion notify.
    const cancel = () => {
        if (settled) return;
        settled = true;
        cancelled = true;
        cleanup();
    };
    backgroundShellJobWatchers.set(jobId, { cancel, notifyCtx: ctx });
    const fire = (reason) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
            const detail = attachJobInsights(refreshShellJob(jobId)) || readShellJobDetail(jobId);
            if (!detail) return;
            const completion = buildShellCompletion(jobId, detail, reason);
            const completedTask = completeBackgroundTask(jobId, {
                status: completion.taskStatus,
                result: completion.result,
                resultText: completion.body,
                error: completion.error,
                resultType: 'shell_task_result',
                instruction: completion.instruction,
                terminalReason: `shell-watcher-${reason || 'done'}`,
            });
            clearShellTaskSafetyNet(jobId);
            if (completedTask) return;
            notifyToolCompletion({
                surface: 'shell',
                id: jobId,
                status: completion.taskStatus,
                text: completion.body,
                resultType: 'shell_task_result',
                instruction: completion.instruction,
                context: ctx,
                logPrefix: 'shell-jobs',
            });
        } catch (err) {
            try { process.stderr.write(`[shell-jobs] watchBackgroundShellJob fire failed: jobId=${jobId} err=${err?.message ?? String(err)}\n`); } catch { /* ignore */ }
        }
    };
    const maybeNotifyPromptStall = (detail) => {
        if (settled || promptStallNotified || !detail || detail.status !== 'running') return;
        const tail = readPromptTail(detail);
        const now = Date.now();
        if (lastOutputBytes === null || tail.bytes !== lastOutputBytes) {
            lastOutputBytes = tail.bytes;
            lastOutputAtMs = now;
            return;
        }
        if (now - lastOutputAtMs < SHELL_JOB_PROMPT_STALL_MS) return;
        if (!looksLikeInteractivePrompt(tail.text)) return;
        const elapsedMs = now - (Date.parse(detail.startedAt || '') || now);
        const body = renderShellPromptStallEnvelope({
            jobId,
            stalledMs: now - lastOutputAtMs,
            elapsedMs,
            command: detail.command,
            tailText: tail.text,
        });
        const instruction = shellPromptStallInstruction({ jobId });
        // Prefer the progress-notify path when a background task row exists.
        // Its once-key ('interactive-prompt-stall') dedupe returns false after
        // a re-arm even though the row is present — do NOT fall back to
        // notifyToolCompletion in that case (it would fire a duplicate). Only
        // use the completion fallback when the task row is absent (progress
        // path unavailable).
        const sent = getBackgroundTask(jobId)
            ? notifyBackgroundTaskProgress(jobId, {
                text: body,
                resultType: 'shell_task_progress',
                instruction,
                key: 'interactive-prompt-stall',
                status: null,
            })
            : notifyToolCompletion({
                surface: 'shell',
                id: jobId,
                status: null,
                text: body,
                resultType: 'shell_task_progress',
                instruction,
                context: ctx,
                logPrefix: 'shell-jobs',
            });
        if (sent) promptStallNotified = true;
    };
    const checkDone = (reason) => {
        if (settled) return;
        const detail = refreshShellJob(jobId);
        // refreshShellJob flips status off 'running' once donePath/exit/timeout
        // is observed; only fire once the job is no longer running.
        if (!detail || detail.status !== 'running') fire(reason);
        else maybeNotifyPromptStall(detail);
    };
    try {
        const donePath = shellJobDonePath(jobId);
        // Already finished between spawn and watcher arm — fire immediately.
        if (existsSync(donePath)) { fire('already-done'); return; }
        const dir = getShellJobsDir();
        const doneName = `${jobId}.done`;
        try {
            watcher = fsWatch(dir, (_event, filename) => {
                if (!filename) { checkDone('watch'); return; }
                if (String(filename) === doneName) checkDone('watch');
            });
            // Don't let the FSWatcher pin the event loop — the poll fallback
            // and hard-stop timer are already unref()'d, so the watcher must
            // be too or the host process can't exit until the job completes.
            if (watcher && typeof watcher.unref === 'function') watcher.unref();
            // A watcher error (e.g. dir removed) must not crash the host; rely
            // on the poll fallback instead.
            if (watcher && typeof watcher.on === 'function') {
                watcher.on('error', () => { try { watcher.close(); } catch { /* ignore */ } watcher = null; });
            }
        } catch { watcher = null; }
        pollTimer = setInterval(() => checkDone('poll'), SHELL_JOB_WATCH_POLL_MS);
        if (typeof pollTimer.unref === 'function') pollTimer.unref();
        const timeoutMs = Number(readShellJobDetail(jobId)?.timeoutMs || 0);
        // Only arm the hard-stop when a timeout is enforced. timeoutMs<=0 means
        // unlimited: arming it would fire ~grace ms after arm and mark the job
        // failed. fs.watch + poll remain the completion paths for such jobs.
        if (timeoutMs > 0) {
            const startedAtMs = Date.parse(readShellJobDetail(jobId)?.startedAt || '') || Date.now();
            const hardStopMs = Math.min(TIMER_MAX_MS, Math.max(0, (startedAtMs + timeoutMs + SHELL_JOB_WATCH_GRACE_MS) - Date.now()));
            hardStopTimer = setTimeout(() => fire('timeout'), hardStopMs);
            if (typeof hardStopTimer.unref === 'function') hardStopTimer.unref();
        }
    } catch (err) {
        cleanup();
        try { process.stderr.write(`[shell-jobs] watchBackgroundShellJob arm failed: jobId=${jobId} err=${err?.message ?? String(err)}\n`); } catch { /* ignore */ }
    }
}

// Adopt a still-running FOREGROUND child into the shell-jobs registry. Used
// by execShellCommand's auto-background transition: the foreground one-shot
// path spawned a piped child whose stdout/stderr were already being captured
// to TaskOutput spill files. When the auto-background timer fires we do NOT
// re-spawn or wrap — the child keeps running as-is — we only publish a job
// detail so task control / refreshShellJob can track it to completion.
//
// The caller owns the child.on('close') lifecycle wiring (writing the exit
// file FIRST, donePath AFTER) so the ordering invariant refreshShellJob()
// depends on holds for adopted jobs exactly as it does for staged wrappers.
// This function only allocates the jobId/paths and writes the initial
// 'running' detail.
export function adoptForegroundShellJob({ command, cwd, pid, timeoutMs, mergeStderr, stdoutPath, stderrPath, clientHostPid }) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const exitPath = shellJobExitPath(jobId);
    const donePath = shellJobDonePath(jobId);
    const detail = {
        jobId,
        kind: 'bash',
        status: 'running',
        adopted: true,
        command,
        cwd,
        pid,
        mergeStderr: mergeStderr === true,
        timeoutMs: Number(timeoutMs) || 0,
        // Point the registry at the live TaskOutput spill files so
        // peek/wait previews read the same bytes the foreground capture is
        // still appending. mergeStderr collapses both onto stdoutPath.
        stdoutPath: stdoutPath || null,
        stderrPath: mergeStderr === true ? (stdoutPath || null) : (stderrPath || null),
        exitPath,
        donePath,
        // Per-terminal session stamp: the threaded clientHostPid is the
        // dispatching terminal's claude.exe pid (resolveJobOwnerHostPid falls
        // back to the single-client env only when unset).
        ownerHostPid: resolveJobOwnerHostPid(clientHostPid),
        startedAt: new Date().toISOString(),
    };
    writeShellJobDetail(detail);
    if (Number.isFinite(pid) && pid > 0) {
        _installShellJobsExitHook();
        _registerLiveJobPid(pid, jobId);
        // Adopted jobs have no staged wrapper timer and may have no active
        // task waiter, so nothing would call refreshShellJob() to enforce the
        // output cap / timeout. Drive a periodic tick until the job settles.
        _armAdoptedJobCapPoll(jobId);
    }
    return { ...detail, exitPath, donePath };
}

// Periodic self-tick for adopted (auto-backgrounded) jobs: refreshShellJob
// runs the SHELL_JOB_OUTPUT_DISK_CAP + timeout watchdogs. Stops once the job
// leaves 'running'. unref()'d so it never pins the host process.
function _armAdoptedJobCapPoll(jobId) {
    const tick = setInterval(() => {
        let detail = null;
        try { detail = refreshShellJob(jobId); } catch { /* ignore */ }
        if (!detail || detail.status !== 'running') {
            clearInterval(tick);
        }
    }, ADOPTED_JOB_CAP_POLL_MS);
    if (typeof tick.unref === 'function') tick.unref();
    return tick;
}
