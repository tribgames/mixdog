// Generic background-task tool (status/wait/cancel), extracted from bash-tool.mjs.
import {
    buildJobNotFoundMessage,
    peekShellJob,
    killShellJob,
    cancelBackgroundShellJobWatch,
    clearShellJobNotifyCtx,
    shellJobPublicTaskResult,
    shellJobTaskStatus,
    waitForShellJob,
} from './shell-jobs.mjs';

// Ceiling for confirming that a cancelled task's process really exited. The
// wait returns the moment the native task settles, so this only bounds a
// process that ignores the kill.
const TASK_CANCEL_CONFIRM_MS = 5_000;
import {
    TASK_WAIT_TIMEOUT_DEFAULT_MS,
    TASK_WAIT_TIMEOUT_MAX_MS,
    TASK_WAIT_TIMEOUT_MIN_MS,
} from './builtin-tools.mjs';
import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import {
    acknowledgeBackgroundTaskCompletion,
    cancelBackgroundTask,
    completeBackgroundTask,
    getBackgroundTask,
    renderBackgroundTask,
    renderBackgroundTaskList,
} from '../../../../shared/background-tasks.mjs';
import { recordDeliveredCompletion } from '../../session/manager/delivered-completions.mjs';
import {
    listShellJobRecords,
    readShellJobRecord,
} from './lib/shell-job-records.mjs';

function recoveredTaskMatches(record, options = {}) {
    const context = options?.context && typeof options.context === 'object'
        ? { ...options.context, ...options }
        : options;
    const sessionIds = new Set([
        context?.callerSessionId,
        context?.routingSessionId,
        context?.sessionId,
    ].filter(Boolean).map(String));
    const clientHostPid = Number(context?.clientHostPid) || null;
    if (sessionIds.size === 0 && !clientHostPid) return true;
    if (!record?.ownerSessionId && !record?.ownerHostPid) return true;
    // A caller WITH session identity is authorized by session identity ONLY.
    // In a pooled host every pane shares one claude.exe pid, so the host pid
    // can neither widen a session mismatch nor stand in for a record that
    // never recorded an owner session — both kept other panes' commands and
    // results visible. The pid path remains for callers that have no session
    // identity at all, where it is the only identity available.
    if (sessionIds.size > 0) {
        return Boolean(record.ownerSessionId) && sessionIds.has(String(record.ownerSessionId));
    }
    return Boolean(clientHostPid && Number(record.ownerHostPid) === clientHostPid);
}

function renderRecoveredShellTask(record) {
    const result = shellJobPublicTaskResult(record);
    return [
        'background task',
        `task_id: ${record.jobId}`,
        `status: ${record.status}`,
        'recovered: true',
        '',
        JSON.stringify(result, null, 2),
    ].join('\n');
}

function refreshShellTask(taskId, { includeRunning = false } = {}) {
    const job = peekShellJob(taskId);
    if (!job) return null;
    const publicResult = shellJobPublicTaskResult(job);
    if (job.status !== 'running') {
        completeBackgroundTask(taskId, {
            // Same mapping as the completion notification, so a non-zero exit
            // reads as a completed task in both surfaces.
            status: shellJobTaskStatus(job),
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

function renderTaskCancelSuccess(taskId, task) {
    const surface = task?.surface || 'task';
    const operation = task?.operation || 'run';
    return [
        'status: completed',
        `task_id: ${taskId}`,
        `cancelled: ${surface}/${operation}`,
    ].join('\n');
}

// Clamp lives next to the caller; the bounds themselves are published by the
// tool schema, so an out-of-range request is corrected rather than rejected.
function resolveTaskWaitTimeoutMs(value) {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return TASK_WAIT_TIMEOUT_DEFAULT_MS;
    return Math.min(TASK_WAIT_TIMEOUT_MAX_MS, Math.max(TASK_WAIT_TIMEOUT_MIN_MS, Math.floor(raw)));
}

export async function executeTaskTool(args, options = {}) {
    const action = typeof args.action === 'string' ? args.action.toLowerCase() : '';
    if (!action) return 'Error: task action is required';
    if (action === 'list') {
        const rendered = renderBackgroundTaskList({ context: options });
        const liveIds = new Set([...rendered.matchAll(/^-\s+(\S+)/gm)].map((match) => match[1]));
        const recovered = (await listShellJobRecords())
            .filter((record) => recoveredTaskMatches(record, options) && !liveIds.has(record.jobId));
        if (recovered.length === 0) return rendered;
        const rows = recovered.map((record) =>
            `- ${record.jobId} shell ${record.terminal ? record.status : 'state-unavailable'} recovered=true command=${JSON.stringify(record.command || '')}`);
        return `${rendered}\n[recovered shell tasks]\n${rows.join('\n')}`;
    }

    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    if (!taskId) return 'Error: task_id is required';
    // sess_* values are agent/orchestrator session ids, not background shell
    // tasks. task only resolves `shell mode=async` tasks, so surface a
    // self-correcting hint instead of the bare "task not found" that otherwise
    // invites a wrong-tool retry loop.
    if (/^sess_/.test(taskId)) {
        return `Error: "${taskId}" is an agent/session id, not a background task_id. Agent tasks deliver completion notifications; use agent list/read only for manual recovery.`;
    }
    if (action !== 'read' && action !== 'wait' && action !== 'cancel') {
        return `Error: task action must be one of list|read|wait|cancel (got ${JSON.stringify(args.action)})`;
    }

    const task = getBackgroundTask(taskId, { context: options });
    if (!task) {
        const recovered = await readShellJobRecord(taskId);
        if (!recovered || !recoveredTaskMatches(recovered, options)) {
            return `Error: task not found: ${taskId}`;
        }
        if (action === 'read' || action === 'wait') {
            // Nothing to wait ON after a restart: the process is gone, so wait
            // degrades to the recovered snapshot rather than blocking.
            if (!recovered.terminal) return `Error: task state is unavailable after restart: ${taskId}`;
            recordDeliveredCompletion({ executionId: taskId });
            return renderRecoveredShellTask(recovered);
        }
        if (action === 'cancel') {
            return recovered.terminal
                ? `Error: task already ${recovered.status}: ${taskId}`
                : `Error: task process control is unavailable after restart: ${taskId}`;
        }
    }
    const isShellTask = task.surface === 'shell';

    if (action === 'read' || action === 'wait') {
        if (action === 'wait') {
            if (!isShellTask) return `Error: task wait is only available for shell tasks: ${taskId}`;
            // The turn's abort signal must cut the wait short; a cancelled turn
            // cannot sit out the remaining ceiling.
            let waitSignal = null;
            try { waitSignal = (await getAbortSignalForSession(options?.sessionId)) || null; }
            catch { waitSignal = null; }
            const waitTimeoutMs = resolveTaskWaitTimeoutMs(args.timeout_ms);
            // A shell task whose descendants outlived the shell process has no
            // native job to subscribe to — the process it belonged to is gone.
            // Its registry promise (resolved by the descendant observer) is the
            // completion event in that case.
            if (!peekShellJob(taskId) && task.status === 'running' && task.promise) {
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, waitTimeoutMs);
                    timer.unref?.();
                    const done = () => { clearTimeout(timer); resolve(); };
                    task.promise.then(done, done);
                    if (waitSignal) {
                        if (waitSignal.aborted) done();
                        else waitSignal.addEventListener('abort', done, { once: true });
                    }
                });
            } else {
                await waitForShellJob(taskId, {
                    timeoutMs: waitTimeoutMs,
                    signal: waitSignal,
                });
            }
        }
        if (isShellTask) refreshShellTask(taskId, { includeRunning: true });
        const latest = getBackgroundTask(taskId, { context: options }) || task;
        const rendered = renderBackgroundTask(latest, { includeResult: true });
        if (acknowledgeBackgroundTaskCompletion(taskId, { context: options })) {
            recordDeliveredCompletion({ executionId: taskId });
        }
        return rendered;
    }

    if (action === 'cancel') {
        if (isShellTask) {
            // A tracked task with no native job is still cancellable: the
            // registry's own cancel hook owns it (descendants that outlived
            // their shell). Remember that it WAS live so the outcome is
            // reported as a cancellation rather than "task not found".
            const wasRunning = task.status === 'running';
            const job = killShellJob(taskId);
            if (job) {
                // Confirm the process actually terminated before reporting a
                // terminal status. Removing the watcher on the strength of a
                // delivered signal left a live, unmonitored process behind a
                // false 'cancelled'.
                const confirmed = await waitForShellJob(taskId, { timeoutMs: TASK_CANCEL_CONFIRM_MS });
                if (confirmed && confirmed.status === 'running') {
                    // Watcher and notify context stay armed: the eventual exit
                    // must still reach the owner.
                    return [
                        'status: cancel-unconfirmed',
                        `task_id: ${taskId}`,
                        'the cancellation was delivered but the process has not exited yet. It stays tracked and its completion is still delivered; re-run task cancel or task read to check again.',
                    ].join('\n');
                }
                if (!confirmed) {
                    // No terminal event and no observable task: absence of
                    // state is not proof of termination. Stop tracking it so it
                    // cannot hang as 'running' forever, but never claim it died.
                    cancelBackgroundShellJobWatch(taskId);
                    clearShellJobNotifyCtx(taskId);
                    cancelBackgroundTask(taskId, 'cancelled by task control; termination unconfirmed');
                    return [
                        'status: cancel-unconfirmed',
                        `task_id: ${taskId}`,
                        'the cancellation was delivered but this task is no longer observable, so its termination could not be confirmed. Verify the process directly if it must be gone.',
                    ].join('\n');
                }
            }
            cancelBackgroundShellJobWatch(taskId);
            clearShellJobNotifyCtx(taskId);
            cancelBackgroundTask(taskId, 'cancelled by task control');
            return (job || wasRunning)
                ? renderTaskCancelSuccess(taskId, getBackgroundTask(taskId, { context: options }) || task)
                : buildJobNotFoundMessage(taskId);
        }
        cancelBackgroundTask(taskId, 'cancelled by task control');
        return renderTaskCancelSuccess(taskId, getBackgroundTask(taskId, { context: options }) || task);
    }

    return `Error: task action must be one of list|read|wait|cancel (got ${JSON.stringify(args.action)})`;
}
