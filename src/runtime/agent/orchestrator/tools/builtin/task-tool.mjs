// Generic background-task tool (status/wait/cancel), extracted from bash-tool.mjs.
import {
    buildJobNotFoundMessage,
    waitForShellJob,
    peekShellJob,
    killShellJob,
    watchBackgroundShellJob,
    cancelBackgroundShellJobWatch,
    beginShellJobWait,
    endShellJobWait,
    clearShellJobNotifyCtx,
    shellJobPublicTaskResult,
} from './shell-jobs.mjs';
import {
    cancelBackgroundTask,
    completeBackgroundTask,
    getBackgroundTask,
    notifyBackgroundTaskProgress,
    renderBackgroundTask,
    renderBackgroundTaskList,
} from '../../../../shared/background-tasks.mjs';

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

function scheduleShellProgressCheck(task, afterMs) {
    const replaced = Boolean(task.progressCheckTimer);
    if (task.progressCheckTimer) {
        try { clearTimeout(task.progressCheckTimer); } catch {}
    }
    const scheduledAt = Date.now();
    const timer = setTimeout(() => {
        const current = getBackgroundTask(task.taskId);
        if (!current || current.progressCheckTimer !== timer) return;
        current.progressCheckTimer = null;
        if (current.status !== 'running') return;
        const job = peekShellJob(task.taskId);
        if (!job || job.status !== 'running') return;
        const snapshot = shellJobPublicTaskResult(job);
        notifyBackgroundTaskProgress(current, {
            text: [
                renderBackgroundTask(current),
                '',
                JSON.stringify(snapshot, null, 2),
            ].join('\n'),
            resultType: 'shell_task_progress',
            instruction: `The scheduled progress check for shell task ${task.taskId} is ready; inspect this snapshot and schedule another check_after only if needed.`,
            key: `scheduled-progress-${scheduledAt}`,
        });
    }, afterMs);
    if (typeof timer.unref === 'function') timer.unref();
    task.progressCheckTimer = timer;
    return replaced;
}

export async function executeTaskTool(args, options = {}) {
    const action = typeof args.action === 'string' ? args.action.toLowerCase() : (args.task_id ? 'status' : 'list');
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

    if (action === 'check_after') {
        if (!Number.isInteger(args.after_ms) || args.after_ms <= 0 || args.after_ms > 2_147_483_647) {
            return 'Error: task action "check_after" requires explicit positive integer "after_ms"';
        }
        if (!isShellTask) return 'Error: task action "check_after" supports shell task_id values only';
        const job = peekShellJob(taskId);
        if (!job) return buildJobNotFoundMessage(taskId);
        if (job.status !== 'running') {
            refreshShellTask(taskId);
            return renderBackgroundTask(getBackgroundTask(taskId, { context: options }) || task, { includeResult: true });
        }
        const replaced = scheduleShellProgressCheck(task, args.after_ms);
        return [
            'status: running',
            `task_id: ${taskId}`,
            'progress_check_scheduled: true',
            `after_ms: ${args.after_ms}`,
            replaced ? 'replaced_previous_check: true' : null,
        ].filter(Boolean).join('\n');
    }

    if (action !== 'wait') {
        return `Error: task action must be one of list|status|read|check_after|cancel (got ${JSON.stringify(args.action)})`;
    }
    if (!Number.isInteger(args.timeout_ms) || args.timeout_ms <= 0) {
        return 'Error: task action "wait" requires explicit positive integer "timeout_ms"';
    }
    const waitTimeoutMs = args.timeout_ms;

    if (!isShellTask) {
        const waited = await waitForGenericTask(taskId, {
            timeoutMs: waitTimeoutMs,
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
            timeoutMs: waitTimeoutMs,
            pollMs: typeof args.poll_ms === 'number' ? args.poll_ms : 250,
        });
        if (!job) return buildJobNotFoundMessage(taskId);
        const publicResult = shellJobPublicTaskResult(job);
        if (job.status !== 'running') {
            completeBackgroundTask(taskId, {
                status: shellJobToTaskStatus(job.status),
                result: publicResult,
                resultText: JSON.stringify(publicResult, null, 2),
                notify: false,
            });
        } else {
            const runningTask = getBackgroundTask(taskId, { context: options });
            if (runningTask) {
                runningTask.result = publicResult;
                runningTask.resultText = JSON.stringify(publicResult, null, 2);
            }
        }
        const latest = getBackgroundTask(taskId, { context: options }) || task;
        const rendered = renderBackgroundTask(latest, { includeResult: true });
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
            // EXCEPT when this wait's tool call was aborted: its result was
            // discarded, so nobody consumed the outcome — re-arm so the
            // watcher delivers the completion notification instead of
            // swallowing it.
            else if (options?.signal?.aborted) watchBackgroundShellJob(taskId);
            else clearShellJobNotifyCtx(taskId);
        }
    }
}
