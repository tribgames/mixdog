// Generic background-task tool (status/wait/cancel), extracted from bash-tool.mjs.
import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import { execShellCommand, stripAnsi } from '../shell-command.mjs';
import { wrapCommandWithSnapshot } from '../shell-snapshot.mjs';
import { getDestructiveCommandWarning } from '../destructive-warning.mjs';
import { maybeRewriteWmicProcessCommand } from '../shell-policy.mjs';
import { buildBashPolicyScanTargets, checkExecPolicyMessage } from '../bash-policy-scan.mjs';
import { markCodeGraphDirtyPaths, drainCodeGraphCache } from '../code-graph-state.mjs';
import {
    buildJobNotFoundMessage,
    startBackgroundShellJob,
    waitForShellJob,
    peekShellJob,
    killShellJob,
    watchBackgroundShellJob,
    cancelBackgroundShellJobWatch,
    beginShellJobWait,
    endShellJobWait,
    clearShellJobNotifyCtx,
    shellJobPublicTaskResult,
    attachShellJobResourceLease,
} from './shell-jobs.mjs';
import {
    analyzeShellCommandEffects,
    foregroundLongCommandHint,
    isAutobackgroundingAllowed,
    preflightPowerShellHygiene,
    shellSplitSegments,
    shellSplitPipelineSegments,
    shellTokenize,
    stripShellProbeWrappers,
} from './shell-analysis.mjs';
import {
    cancelBackgroundTask,
    completeBackgroundTask,
    getBackgroundTask,
    registerBackgroundTask,
    renderBackgroundTask,
    renderBackgroundTaskList,
    resolveExecutionMode,
} from '../../../../shared/background-tasks.mjs';
import { resolveShellFor } from './shell-runtime.mjs';
import { smartMiddleTruncate } from './shell-output.mjs';
import { normalizeOutputPath } from './path-utils.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { resolveOptionalCwd } from './cwd-utils.mjs';
import { scrubLoaderVars, scrubProviderSecrets } from '../env-scrub.mjs';
import { resolveSessionCwd, stateFilePath, wrapPowerShellWithCwdProbe, wrapBashWithCwdProbe } from '../shell-state.mjs';
import { resourceAdmission } from '../../../../shared/resource-admission.mjs';

// Post-exec drift detection. After a foreground shell command, compare the
// live mtime+size of files mixdog has already read this session against their
// pre-command state (captured just before exec). Files this command changed
// surface as ONE compact reminder so the model re-reads before editing —
// closing the "external write -> stale old_string -> code 8" gap when shell is
// routed through this tool. Bounded to the tracked-read set (capped) so cost
// stays off the whole-cwd path; emits nothing when no read file changed.

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellJobToTaskStatus(status) {
    if (status === 'completed') return 'completed';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'running') return 'running';
    return 'failed';
}

function refreshShellTask(taskId, { includeRunning = false } = {}) {
    const job = peekShellJob(taskId);
    if (!job) return null;
    const publicResult = shellJobPublicTaskResult(job);
    if (job.status !== 'running') {
        completeBackgroundTask(taskId, {
            status: shellJobToTaskStatus(job.status),
            result: publicResult,
            resultText: JSON.stringify(publicResult, null, 2),
            notify: false,
        });
    } else if (includeRunning) {
        const task = getBackgroundTask(taskId);
        if (task) {
            task.result = publicResult;
            task.resultText = JSON.stringify(publicResult, null, 2);
        }
    }
    return job;
}

async function waitForGenericTask(taskId, { timeoutMs = 30_000, pollMs = 250, context = {} } = {}) {
    const started = Date.now();
    const deadline = started + Math.max(0, Number(timeoutMs) || 0);
    let task = getBackgroundTask(taskId, { context });
    if (!task) return null;
    while (task && task.status === 'running' && Date.now() < deadline) {
        await sleep(Math.max(25, Number(pollMs) || 250));
        task = getBackgroundTask(taskId, { context });
    }
    return {
        task,
        waitedMs: Date.now() - started,
        waitTimedOut: Boolean(task && task.status === 'running'),
    };
}

function renderTaskCancelSuccess(taskId, task) {
    const surface = task?.surface || 'task';
    const operation = task?.operation || 'run';
    return [
        'status: completed',
        `task_id: ${taskId}`,
        `cancelled: ${surface}/${operation}`,
    ].join('\n');
}

export async function executeTaskTool(args, options = {}) {
    const action = typeof args.action === 'string' ? args.action.toLowerCase() : (args.task_id ? 'wait' : 'list');
    if (action === 'list') return renderBackgroundTaskList({ context: options });

    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    if (!taskId) return 'Error: task_id is required';
    // sess_* values are agent/orchestrator session ids, not background shell
    // tasks. task only resolves `shell mode=async` tasks, so surface a
    // self-correcting hint instead of the bare "task not found" that otherwise
    // invites a wrong-tool retry loop.
    if (/^sess_/.test(taskId)) {
        return `Error: "${taskId}" is an agent/session id, not a background task_id. Agent tasks deliver completion notifications; use agent list/read only for manual recovery.`;
    }

    const task = getBackgroundTask(taskId, { context: options });
    if (!task) return `Error: task not found: ${taskId}`;
    const isShellTask = task.surface === 'shell';

    if (action === 'status' || action === 'read') {
        if (isShellTask) refreshShellTask(taskId, { includeRunning: action === 'read' });
        const latest = getBackgroundTask(taskId, { context: options }) || task;
        return renderBackgroundTask(latest, { includeResult: action === 'read' });
    }

    if (action === 'cancel') {
        if (isShellTask) {
            const job = killShellJob(taskId);
            cancelBackgroundShellJobWatch(taskId);
            clearShellJobNotifyCtx(taskId);
            cancelBackgroundTask(taskId, 'cancelled by task control');
            return job ? renderTaskCancelSuccess(taskId, getBackgroundTask(taskId, { context: options }) || task) : buildJobNotFoundMessage(taskId);
        }
        cancelBackgroundTask(taskId, 'cancelled by task control');
        return renderTaskCancelSuccess(taskId, getBackgroundTask(taskId, { context: options }) || task);
    }

    if (action !== 'wait') {
        return `Error: task action must be one of list|status|read|wait|cancel (got ${JSON.stringify(args.action)})`;
    }

    if (!isShellTask) {
        const waited = await waitForGenericTask(taskId, {
            timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000,
            pollMs: typeof args.poll_ms === 'number' ? args.poll_ms : 250,
            context: options,
        });
        if (!waited?.task) return `Error: task not found: ${taskId}`;
        const rendered = renderBackgroundTask(waited.task, { includeResult: TERMINAL_TASK_STATUSES.has(waited.task.status) });
        return waited.waitTimedOut ? `${rendered}\nwait_timed_out: true\nwaited_ms: ${waited.waitedMs}` : rendered;
    }
    // Register as a synchronous waiter and cancel the armed watcher BEFORE
    // awaiting: the caller consumes the outcome via task wait, so no async
    // push is wanted, and cancelling up front closes the race where the armed
    // watcher (watch callback or 2s poll) fires during the await window. The
    // persistent notify ctx survives the cancel for a possible re-arm.
    beginShellJobWait(taskId);
    cancelBackgroundShellJobWatch(taskId);
    try {
        const job = await waitForShellJob(taskId, {
            timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000,
            pollMs: typeof args.poll_ms === 'number' ? args.poll_ms : 250,
        });
        if (!job) return buildJobNotFoundMessage(taskId);
        if (job.status !== 'running') {
            const publicResult = shellJobPublicTaskResult(job);
            completeBackgroundTask(taskId, {
                status: shellJobToTaskStatus(job.status),
                result: publicResult,
                resultText: JSON.stringify(publicResult, null, 2),
                notify: false,
            });
        }
        const latest = getBackgroundTask(taskId, { context: options }) || task;
        const rendered = renderBackgroundTask(latest, { includeResult: job.status !== 'running' });
        return job.status === 'running' ? `${rendered}\nwait_timed_out: true\nwaited_ms: ${job.waitedMs}` : rendered;
    } finally {
        // Only the LAST concurrent waiter (post-decrement count 0) may re-arm,
        // and only for a still-running job (timed-out wait). Re-arm with no ctx
        // arg — watchBackgroundShellJob falls back to the persistent ctx. This
        // prevents the concurrent-waiter double-deliver: while any other waiter
        // is still synchronously consuming the outcome, the watcher stays off.
        const remaining = endShellJobWait(taskId);
        if (remaining === 0) {
            const latest = peekShellJob(taskId);
            if (latest && latest.status === 'running') watchBackgroundShellJob(taskId);
            // LAST waiter out and the job already finished — the outcome was
            // consumed synchronously, so no re-arm. Drop the persisted ctx here
            // or it leaks (cleanup only runs on a real watcher settle, which
            // never happens for a never-re-armed entry).
            else clearShellJobNotifyCtx(taskId);
        }
    }
}
