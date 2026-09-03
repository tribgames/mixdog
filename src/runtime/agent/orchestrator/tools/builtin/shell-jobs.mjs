import os from 'node:os';
import {
    modelVisibleToolCompletionMessage,
    normalizeToolNotifyContext,
    notifyToolCompletion,
} from '../../../../shared/tool-execution-contract.mjs';
// Runtime-only bindings (used inside completion delivery, never at module
// eval), so the static cycle through session/manager.mjs is safe — same
// pattern as loop/tool-exec.mjs.
import {
    enqueuePendingMessage,
    markCompletionEntry,
} from '../../session/manager.mjs';
import {
    completeBackgroundTask,
    getBackgroundTask,
} from '../../../../shared/background-tasks.mjs';
import {
    cancelNativeTask,
    getNativeTask,
    listNativeTasks,
    promoteNativeTask,
    releaseNativeTask,
    setNativeTaskStartedAt,
    subscribeNativeTask,
    trackNativeForegroundTask,
    waitNativeTask,
} from '../lib/native-spawn-client.mjs';
import {
    attachJobInsights,
    shellJobPublicTaskResult,
} from './lib/shell-job-insights.mjs';
import {
    completeShellJobRecord,
    listShellJobRecords,
    pidAlive,
    publishShellJobRecord,
    retireShellJobRecord,
} from './lib/shell-job-records.mjs';
import {
    renderShellCompletionEnvelope,
    shellCompletionInstruction,
} from '../../../../shared/task-notification-envelope.mjs';

export { shellJobPublicTaskResult } from './lib/shell-job-insights.mjs';

globalThis.__mixdogShellJobsRuntimeLoaded = true;

export const TIMER_MAX_MS = 2_147_483_647;

export function buildJobNotFoundMessage(jobId) {
    return `Error: task not found: ${jobId}`;
}

const backgroundShellJobWatchers = new Map();
const jobNotifyCtxByJobId = new Map();
const jobWaitWaiterCountByJobId = new Map();
const shellJobResourceLeases = new Map();
const shellJobResourceLeaseSubscriptions = new Map();

function demoteBackgroundShellPriority(pid) {
    if (process.env.MIXDOG_BG_PRIORITY === '0') return;
    if (!Number.isFinite(pid) || pid <= 0) return;
    try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
}

// Live tasks exist only in the spawning process's memory, so every running job
// also publishes a disk record for the out-of-process shell-count readers
// (desktop pane chip, CLI statusline). The record is retired the moment the job
// settles — completed, timed out, or killed.
function trackShellJobRecord(task, options) {
    const jobId = String(task?.jobId || '').trim();
    if (!jobId) return;
    publishShellJobRecord(task, options);
    let unsubscribe = null;
    const settle = (detail) => {
        if (!detail || detail.status === 'running') return;
        try { unsubscribe?.(); } catch {}
        void completeShellJobRecord(jobId, normalizeShellJobDetail(detail));
    };
    unsubscribe = subscribeNativeTask(jobId, settle);
    settle(getNativeTask(jobId) || task);
}

function releaseShellJobResourceLease(jobId) {
    const unsubscribe = shellJobResourceLeaseSubscriptions.get(jobId);
    shellJobResourceLeaseSubscriptions.delete(jobId);
    try { unsubscribe?.(); } catch {}
    const lease = shellJobResourceLeases.get(jobId);
    if (!lease) return false;
    shellJobResourceLeases.delete(jobId);
    try { Promise.resolve(lease.release()).catch(() => {}); } catch {}
    return true;
}

/** Native task status → background-task status. A non-zero exit is a COMMAND
 *  result, not a task failure: the identical run in the foreground reports
 *  `[exit code: N]` and stays a success, so crossing the promotion threshold
 *  must not flip it to failed. Only control-plane outcomes (spawn/server
 *  error, timeout kill, cancellation) are terminal failures. */
export function shellJobTaskStatus(detail) {
    const status = typeof detail === 'string' ? detail : String(detail?.status || '');
    if (status === 'running') return 'running';
    if (status === 'completed') return 'completed';
    if (status === 'cancelled') return 'cancelled';
    // ONLY a real numeric non-zero exit normalizes. A signal death / null exit
    // (SIGSEGV, SIGKILL, a lost process) is a genuine failure and must never
    // be reported as success — `Number(null)` is 0, so an integer test on the
    // coerced value silently turned every crash into a completed task.
    const exitCode = (detail && typeof detail === 'object') ? detail.exitCode : null;
    if (
        status === 'failed'
        && detail && typeof detail === 'object'
        && !detail.timedOut
        && !detail.killed
        && !detail.error
        && !detail.signal
        && typeof exitCode === 'number'
        && Number.isInteger(exitCode)
        && exitCode !== 0
    ) return 'completed';
    return 'failed';
}

/** Canonical shell-job detail. Every surface — wrapper task status, completion
 *  notification, public task result, disk record, insights summary — reads
 *  `status` from this one mapping, so a promoted non-zero command can never be
 *  reported completed by one surface and failed by another. The raw native
 *  value is kept as `nativeStatus` for diagnostics. */
export function normalizeShellJobDetail(detail) {
    if (!detail || typeof detail !== 'object') return detail;
    const nativeStatus = String(detail.status || '');
    const status = shellJobTaskStatus(detail);
    // `nativeStatus` belongs to the contract even when the mapping is identity
    // (a signal death stays `failed`): every surface must be able to read the
    // raw value the canonical status came from.
    if (detail.status === status && detail.nativeStatus === nativeStatus) return detail;
    return { ...detail, status, nativeStatus: detail.nativeStatus || nativeStatus };
}

/** Cause line for a failed job. The native side fills `error` only for its own
 *  control-plane failures, so a signal death or a status-less exit arrived with
 *  a null cause and the completion said "failed" while explaining nothing. */
export function shellJobFailureCause(detail) {
    const explicit = String(detail?.error || '').trim();
    if (explicit) return explicit;
    const exitCode = typeof detail?.exitCode === 'number' ? detail.exitCode : null;
    const exitDetail = exitCode == null ? '' : ` (exit ${exitCode})`;
    if (detail?.timedOut) return `timed out before completing${exitDetail}`;
    if (detail?.signal) return `terminated by signal ${detail.signal}${exitDetail}`;
    if (detail?.killed) return `terminated before completing${exitDetail}`;
    if (exitCode == null) return 'ended without an exit status';
    return `exited with code ${exitCode}`;
}

export function buildShellCompletion(jobId, detail) {
    const startedAtMs = Date.parse(detail?.startedAt || '');
    const finishedAtMs = Date.parse(detail?.finishedAt || '') || Date.now();
    const elapsedMs = Number.isFinite(startedAtMs)
        ? Math.max(0, finishedAtMs - startedAtMs)
        : null;
    const exitCode = typeof detail?.exitCode === 'number' ? detail.exitCode : null;
    const status = detail?.status || 'unknown';
    const taskStatus = shellJobTaskStatus(detail);
    // A failure always carries its cause — including a signal death, where the
    // native task has no `error` of its own.
    const failureCause = taskStatus === 'failed' ? shellJobFailureCause(detail) : null;
    const reported = (failureCause && !detail?.error) ? { ...detail, error: failureCause } : detail;
    const body = renderShellCompletionEnvelope({
        jobId,
        status,
        exitCode,
        elapsedMs,
        command: detail?.command,
        summary: detail?.summary || failureCause || null,
        stdoutPreview: detail?.stdoutPreview,
        stderrPreview: detail?.stderrPreview,
        mergeStderr: detail?.mergeStderr,
    });
    return {
        taskStatus,
        body,
        instruction: shellCompletionInstruction({ jobId, status, exitCode }),
        result: shellJobPublicTaskResult(reported),
        error: failureCause,
    };
}

export async function waitForShellJob(jobId, { timeoutMs = 30_000, signal = null } = {}) {
    const started = Date.now();
    const detail = normalizeShellJobDetail(await waitNativeTask(jobId, timeoutMs, signal));
    const withInsights = attachJobInsights(detail);
    if (!withInsights) return null;
    withInsights.waitedMs = Date.now() - started;
    if (withInsights.status === 'running') withInsights.waitTimedOut = true;
    return withInsights;
}

export function peekShellJob(jobId) {
    return attachJobInsights(normalizeShellJobDetail(getNativeTask(jobId)));
}

/** True while the job's process is still alive in this daemon. Owners of
 *  in-use artifacts consult it before a fallback cleanup fires. */
export function isShellJobRunning(jobId) {
    return getNativeTask(String(jobId || ''))?.status === 'running';
}

/** Run `onSettled` once the job leaves 'running' (immediately when it already
 *  has). Owners of per-command artifacts (hoisted script files, tee captures,
 *  cache invalidation) use this instead of a fixed timer, which either fired
 *  under a still-running command or never at all. Returns an unsubscribe, or
 *  null when the job is unknown here — the caller then keeps its own fallback. */
export function subscribeShellJobSettled(jobId, onSettled) {
    const key = String(jobId || '').trim();
    if (!key || typeof onSettled !== 'function') return null;
    const current = getNativeTask(key);
    if (!current) return null;
    if (current.status !== 'running') {
        queueMicrotask(() => { try { onSettled(current); } catch {} });
        return () => {};
    }
    let done = false;
    let unsubscribe = () => {};
    const fire = (task) => {
        if (done || !task || task.status === 'running') return;
        done = true;
        try { unsubscribe(); } catch {}
        try { onSettled(task); } catch {}
    };
    unsubscribe = subscribeNativeTask(key, fire);
    return () => {
        done = true;
        try { unsubscribe(); } catch {}
    };
}

export function refreshShellJob(jobId) {
    return normalizeShellJobDetail(getNativeTask(jobId));
}

export function killShellJob(jobId) {
    const detail = cancelNativeTask(jobId);
    if (!detail) return null;
    const wasRunning = detail.status === 'running';
    return { ...attachJobInsights(normalizeShellJobDetail(detail)), killed: wasRunning };
}

export function attachShellJobResourceLease(jobId, lease) {
    if (!jobId || !lease || typeof lease.release !== 'function') return false;
    const detail = getNativeTask(jobId);
    if (!detail || detail.status !== 'running') {
        try { Promise.resolve(lease.release()).catch(() => {}); } catch {}
        return false;
    }
    releaseShellJobResourceLease(jobId);
    shellJobResourceLeases.set(jobId, lease);
    const unsubscribe = subscribeNativeTask(jobId, (task) => {
        if (task?.status !== 'running') releaseShellJobResourceLease(jobId);
    });
    shellJobResourceLeaseSubscriptions.set(jobId, unsubscribe);
    return true;
}

export function beginShellJobWait(jobId) {
    jobWaitWaiterCountByJobId.set(jobId, (jobWaitWaiterCountByJobId.get(jobId) || 0) + 1);
}

export function endShellJobWait(jobId) {
    const next = (jobWaitWaiterCountByJobId.get(jobId) || 0) - 1;
    if (next <= 0) {
        jobWaitWaiterCountByJobId.delete(jobId);
        return 0;
    }
    jobWaitWaiterCountByJobId.set(jobId, next);
    return next;
}

export function clearShellJobNotifyCtx(jobId) {
    jobNotifyCtxByJobId.delete(jobId);
}

export function cancelBackgroundShellJobWatch(jobId) {
    const entry = backgroundShellJobWatchers.get(jobId);
    if (!entry) return null;
    entry.cancel?.();
    return entry.notifyCtx || null;
}

export function watchBackgroundShellJob(jobId, notifyCtx) {
    const ctx = notifyCtx && typeof notifyCtx.notifyFn === 'function'
        ? normalizeToolNotifyContext(notifyCtx)
        : jobNotifyCtxByJobId.get(jobId);
    if (!jobId || !getNativeTask(jobId) || backgroundShellJobWatchers.has(jobId)) return;
    if (ctx) jobNotifyCtxByJobId.set(jobId, ctx);
    let settled = false;
    let unsubscribe = () => {};
    const cancel = () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        backgroundShellJobWatchers.delete(jobId);
    };
    const finish = (detail) => {
        if (settled || !detail || detail.status === 'running') return;
        settled = true;
        unsubscribe();
        backgroundShellJobWatchers.delete(jobId);
        jobNotifyCtxByJobId.delete(jobId);
        releaseShellJobResourceLease(jobId);
        const enriched = attachJobInsights(normalizeShellJobDetail(detail));
        const completion = buildShellCompletion(jobId, enriched);
        const completedTask = completeBackgroundTask(jobId, {
            status: completion.taskStatus,
            result: completion.result,
            resultText: completion.body,
            error: completion.error,
            resultType: 'shell_task_result',
            instruction: completion.instruction,
            terminalReason: 'shell-native-event',
        });
        if (!completedTask) {
            // Delivery order: owner notifyFn when present, else the owner
            // session's pending queue. A ctx-less finish (daemon restarted
            // between job start and completion, or a watcher armed without a
            // notify context) previously dropped the completion silently.
            const owner = String(ctx?.callerSessionId || detail.ownerSessionId || '');
            notifyToolCompletion({
                surface: 'shell',
                id: jobId,
                status: completion.taskStatus,
                text: completion.body,
                resultType: 'shell_task_result',
                instruction: completion.instruction,
                context: ctx || { callerSessionId: owner },
                enqueueFallback: (sessionId, message, meta) => {
                    let visible = modelVisibleToolCompletionMessage(message, meta);
                    // Bodyless envelopes (a finished command with no output)
                    // fail the persistence gate's result-body requirement;
                    // retry with an explicit "(no output)" section rather
                    // than dropping the completion.
                    if (!visible && !/\n\s*\n/.test(String(message || ''))) {
                        visible = modelVisibleToolCompletionMessage(`${message}\n\n(no output)`, meta);
                    }
                    if (!visible) return false;
                    return enqueuePendingMessage(sessionId, markCompletionEntry(visible, {
                        executionId: meta?.execution_id,
                        meta,
                    })) > 0;
                },
                logPrefix: 'shell-jobs',
            });
        }
    };
    unsubscribe = subscribeNativeTask(jobId, finish);
    if (!settled) {
        backgroundShellJobWatchers.set(jobId, { cancel, notifyCtx: ctx });
    }
    queueMicrotask(() => finish(getNativeTask(jobId)));
}

export async function trackForegroundShellJob({
    command,
    cwd,
    child,
    jobId,
    clientHostPid,
    ownerSessionId,
}) {
    return trackNativeForegroundTask({
        child,
        jobId,
        command,
        cwd,
        ownerSessionId,
        clientHostPid,
    });
}

export async function promoteForegroundShellJob({
    command,
    cwd,
    pid,
    jobId,
    timeoutMs,
    clientHostPid,
    ownerSessionId,
    startedAtMs = 0,
}) {
    const native = await promoteNativeTask({
        jobId,
        command,
        cwd,
        timeoutMs,
        ownerSessionId,
        clientHostPid,
    });
    if (!native) return null;
    demoteBackgroundShellPriority(pid);
    // Promotion refreshes the task at transition time, and a promoted standby
    // shell carries its process-creation time. Neither is when this command started,
    // so the runner's own start moment is registered before anything reads the
    // task — the record, the completion elapsed and the live readouts then all
    // measure the command itself.
    const started = Math.floor(Number(startedAtMs)) || 0;
    if (started > 0) {
        setNativeTaskStartedAt(native.jobId, started);
        native.startedAt = new Date(started).toISOString();
    }
    trackShellJobRecord(native, { ownerSessionId, clientHostPid, startedAtMs: started });
    return native;
}

/** Live record for a command still running in the FOREGROUND. Background jobs
 *  publish through trackShellJobRecord and settle into a terminal record; a
 *  foreground command has no task id and no completion notice, so its record
 *  is purely the "running right now" marker every out-of-process shell readout
 *  scans. Retired by retireForegroundShellRecord the moment it settles. */
export function publishForegroundShellRecord({
    jobId,
    command,
    cwd,
    pid,
    shellType = null,
    startedAtMs = 0,
    ownerSessionId = null,
    clientHostPid = null,
}) {
    if (!jobId || !Number.isFinite(Number(pid)) || Number(pid) <= 0) return;
    publishShellJobRecord({ jobId, command, cwd, pid: Number(pid), shellType }, {
        ownerSessionId,
        clientHostPid,
        startedAtMs,
        foreground: true,
    });
}

export function retireForegroundShellRecord(jobId) {
    if (!jobId) return;
    retireShellJobRecord(jobId);
}

// Daemon-restart recovery: records left 'running' by a dead daemon can never
// finish through the live watcher path — their completion (and output) used to
// vanish silently. Finalize each dead-pid record and push one completion
// notice to the owner session's pending queue. Content-addressed completion
// ids keep multi-shard reconciliation idempotent.
let _recoveredCompletionsReconciled = false;
export async function reconcileRecoveredShellJobCompletions() {
    if (_recoveredCompletionsReconciled) return 0;
    _recoveredCompletionsReconciled = true;
    let records = [];
    try { records = await listShellJobRecords(); } catch { return 0; }
    let notified = 0;
    for (const record of records) {
        if (!record || record.terminal) continue;
        // A foreground record is a liveness marker, not a task: it has no
        // task id a caller could query and no waiter expecting a completion.
        if (record.foreground) continue;
        if (getNativeTask(record.jobId)) continue; // live in this daemon
        if (pidAlive(Number(record.pid) || 0)) continue; // survived the restart
        const detail = {
            ...record,
            status: 'failed',
            error: 'daemon restarted while this shell task was running; its outcome was lost. Re-run the command if the result is still needed.',
        };
        try { await completeShellJobRecord(record.jobId, detail); } catch { /* best-effort */ }
        const owner = String(record.ownerSessionId || '');
        if (!owner) continue;
        try {
            const completion = buildShellCompletion(record.jobId, detail);
            const delivered = notifyToolCompletion({
                surface: 'shell',
                id: record.jobId,
                status: completion.taskStatus,
                // The pending-queue persistence gate requires a blank-line
                // separated result body; a bodyless bracketed envelope would
                // be dropped. The restart notice IS the result here.
                text: `${completion.body}\n\n${detail.error}`,
                resultType: 'shell_task_result',
                instruction: completion.instruction,
                context: { callerSessionId: owner },
                enqueueFallback: (sessionId, message, meta) => {
                    const visible = modelVisibleToolCompletionMessage(message, meta);
                    if (!visible) return false;
                    return enqueuePendingMessage(sessionId, markCompletionEntry(visible, {
                        executionId: meta?.execution_id,
                        meta,
                    })) > 0;
                },
                logPrefix: 'shell-jobs-recovery',
            });
            if (delivered) notified += 1;
        } catch { /* best-effort */ }
    }
    return notified;
}

export async function shutdownShellJobs(_reason = 'runtime-close', { scope = null } = {}) {
    const scoped = Boolean(scope);
    const ownerSessionId = scoped ? String(scope.ownerSessionId || '') : '';
    if (scoped && !ownerSessionId) {
        return { killed: 0, cancelledJobs: 0, cancelledWatchers: 0 };
    }
    const jobs = listNativeTasks().filter((task) => (
        task.status === 'running'
        && (!scoped || String(task.ownerSessionId || '') === ownerSessionId)
    ));
    let cancelledWatchers = 0;
    for (const task of jobs) {
        if (cancelBackgroundShellJobWatch(task.jobId)) cancelledWatchers += 1;
        try { cancelNativeTask(task.jobId); } catch {}
        jobNotifyCtxByJobId.delete(task.jobId);
        jobWaitWaiterCountByJobId.delete(task.jobId);
    }
    const settled = await Promise.all(
        jobs.map((task) => waitNativeTask(task.jobId, 1_200).catch(() => null)),
    );
    for (const task of jobs) releaseShellJobResourceLease(task.jobId);
    if (scoped) {
        // The owning session is gone: nothing can query its tasks again, so
        // drop ALL of its retained state — not only the ones that happened to
        // be running when shutdown began. releaseNativeTask refuses a task
        // that is still alive, and disk records still serve a post-restart
        // recovery read.
        for (const task of listNativeTasks()) {
            if (String(task.ownerSessionId || '') !== ownerSessionId) continue;
            try { releaseNativeTask(task.jobId); } catch {}
        }
    }
    if (!scoped) {
        for (const jobId of [...shellJobResourceLeases.keys()]) {
            releaseShellJobResourceLease(jobId);
        }
        jobNotifyCtxByJobId.clear();
        jobWaitWaiterCountByJobId.clear();
    }
    return {
        killed: jobs.length,
        cancelledJobs: jobs.length,
        confirmedJobs: settled.filter((task) => task && task.status !== 'running').length,
        cancelledWatchers,
    };
}

// Compatibility exports for callers built against the former file-backed
// implementation. Native task events now provide the lifecycle boundary.
export function reconcileShellJobAfterQuiescence(jobId) {
    return getNativeTask(jobId);
}

export function releaseShellJobOwnershipWhenQuiescent(jobId, _pid, { onConfirmed = null } = {}) {
    const current = getNativeTask(jobId);
    if (!current || current.status !== 'running') {
        queueMicrotask(() => onConfirmed?.());
        releaseShellJobResourceLease(jobId);
        return Boolean(current);
    }
    let unsubscribe = () => {};
    unsubscribe = subscribeNativeTask(jobId, (task) => {
        if (task?.status === 'running') return;
        unsubscribe();
        releaseShellJobResourceLease(jobId);
        onConfirmed?.();
    });
    return true;
}

export function trackChildUntilConfirmedExit(child, jobId, onConfirmed = null) {
    if (!child || typeof child.once !== 'function') return false;
    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        releaseShellJobResourceLease(jobId);
        onConfirmed?.();
    };
    child.once('exit', finish);
    child.once('close', finish);
    child.once('error', finish);
    return true;
}
