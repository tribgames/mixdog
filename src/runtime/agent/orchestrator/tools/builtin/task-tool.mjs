// Generic background-task tool (status/wait/cancel), extracted from bash-tool.mjs.
import {
    buildJobNotFoundMessage,
    peekShellJob,
    killShellJob,
    cancelBackgroundShellJobWatch,
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

    return `Error: task action must be one of list|status|read|check_after|cancel (got ${JSON.stringify(args.action)})`;
}
