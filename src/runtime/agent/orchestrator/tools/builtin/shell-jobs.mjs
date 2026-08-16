import os from 'node:os';
import {
    normalizeToolNotifyContext,
    notifyToolCompletion,
} from '../../../../shared/tool-execution-contract.mjs';
import {
    completeBackgroundTask,
} from '../../../../shared/background-tasks.mjs';
import {
    adoptNativeTaskByPid,
    cancelNativeTask,
    getNativeTask,
    listNativeTasks,
    startNativeTask,
    subscribeNativeTask,
    waitNativeTask,
} from '../lib/native-spawn-client.mjs';
import {
    attachJobInsights,
    shellJobPublicTaskResult,
    SHELL_JOB_OUTPUT_DISK_CAP,
} from './lib/shell-job-insights.mjs';
import {
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
        retireShellJobRecord(jobId);
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

function shellJobTaskStatus(status) {
    if (status === 'completed') return 'completed';
    if (status === 'cancelled') return 'cancelled';
    return 'failed';
}

function buildShellCompletion(jobId, detail) {
    const startedAtMs = Date.parse(detail?.startedAt || '');
    const finishedAtMs = Date.parse(detail?.finishedAt || '') || Date.now();
    const elapsedMs = Number.isFinite(startedAtMs)
        ? Math.max(0, finishedAtMs - startedAtMs)
        : null;
    const exitCode = typeof detail?.exitCode === 'number' ? detail.exitCode : null;
    const status = detail?.status || 'unknown';
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
        taskStatus,
        body,
        instruction: shellCompletionInstruction({ jobId, status, exitCode }),
        result: shellJobPublicTaskResult(detail),
        error: taskStatus === 'failed' ? (detail?.error || null) : null,
    };
}

export async function waitForShellJob(jobId, { timeoutMs = 30_000 } = {}) {
    const started = Date.now();
    const detail = await waitNativeTask(jobId, timeoutMs);
    const withInsights = attachJobInsights(detail);
    if (!withInsights) return null;
    withInsights.waitedMs = Date.now() - started;
    if (withInsights.status === 'running') withInsights.waitTimedOut = true;
    return withInsights;
}

export function peekShellJob(jobId) {
    return attachJobInsights(getNativeTask(jobId));
}

export function refreshShellJob(jobId) {
    return getNativeTask(jobId);
}

export function killShellJob(jobId) {
    const detail = cancelNativeTask(jobId);
    if (!detail) return null;
    return { ...attachJobInsights(detail), killed: detail.status === 'running' };
}

export async function startBackgroundShellJob(options = {}) {
    const {
        command,
        timeoutMs,
        workDir,
        mergeStderr,
        spawnEnv,
        shell,
        shellArg,
        shellArgs,
        shellType,
        clientHostPid,
        ownerSessionId,
    } = options;
    const argv = [
        ...(Array.isArray(shellArgs) && shellArgs.length > 0 ? shellArgs : [shellArg]),
        command,
    ].filter((value) => value != null && String(value).length > 0);
    const task = await startNativeTask({
        program: shell,
        argv,
        cwd: workDir,
        env: spawnEnv,
        timeoutMs,
        mergeStderr,
        command,
        shellType,
        clientHostPid,
        ownerSessionId,
        outputLimit: SHELL_JOB_OUTPUT_DISK_CAP,
    });
    trackShellJobRecord(task, { ownerSessionId, clientHostPid });
    return task;
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
        const enriched = attachJobInsights(detail);
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
        if (!completedTask && ctx && typeof ctx.notifyFn === 'function') {
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
        }
    };
    unsubscribe = subscribeNativeTask(jobId, finish);
    backgroundShellJobWatchers.set(jobId, { cancel, notifyCtx: ctx });
    queueMicrotask(() => finish(getNativeTask(jobId)));
}

export async function adoptForegroundShellJob({
    command,
    cwd,
    pid,
    timeoutMs,
    clientHostPid,
    ownerSessionId,
}) {
    const native = await adoptNativeTaskByPid({
        pid,
        command,
        cwd,
        timeoutMs,
        ownerSessionId,
        clientHostPid,
    });
    if (!native) return null;
    demoteBackgroundShellPriority(pid);
    trackShellJobRecord(native, { ownerSessionId, clientHostPid });
    return native;
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
