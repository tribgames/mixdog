// Generic background-task tool (status/wait/cancel), extracted from bash-tool.mjs.
import {
    buildJobNotFoundMessage,
    peekShellJob,
    killShellJob,
    cancelBackgroundShellJobWatch,
    configureBackgroundShellJobMonitor,
    clearShellJobNotifyCtx,
    shellJobPublicTaskResult,
} from './shell-jobs.mjs';
import {
    isValidShellMonitorIntervalMs,
    SHELL_MONITOR_INTERVAL_MAX_MS,
    SHELL_MONITOR_INTERVAL_MIN_MS,
} from './shell-monitor.mjs';
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
    if (record.ownerSessionId && sessionIds.has(String(record.ownerSessionId))) return true;
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
    if (action !== 'read' && action !== 'monitor' && action !== 'cancel') {
        return `Error: task action must be one of list|read|monitor|cancel (got ${JSON.stringify(args.action)})`;
    }

    const task = getBackgroundTask(taskId, { context: options });
    if (!task) {
        const recovered = await readShellJobRecord(taskId);
        if (!recovered || !recoveredTaskMatches(recovered, options)) {
            return `Error: task not found: ${taskId}`;
        }
        if (action === 'read') {
            if (!recovered.terminal) return `Error: task state is unavailable after restart: ${taskId}`;
            recordDeliveredCompletion({ executionId: taskId });
            return renderRecoveredShellTask(recovered);
        }
        if (action === 'cancel') {
            return recovered.terminal
                ? `Error: task already ${recovered.status}: ${taskId}`
                : `Error: task process control is unavailable after restart: ${taskId}`;
        }
        if (action === 'monitor') {
            return `Error: task monitoring is unavailable after restart: ${taskId}`;
        }
    }
    const isShellTask = task.surface === 'shell';

    if (action === 'read') {
        if (isShellTask) refreshShellTask(taskId, { includeRunning: true });
        const latest = getBackgroundTask(taskId, { context: options }) || task;
        const rendered = renderBackgroundTask(latest, { includeResult: true });
        if (acknowledgeBackgroundTaskCompletion(taskId, { context: options })) {
            recordDeliveredCompletion({ executionId: taskId });
        }
        return rendered;
    }

    if (action === 'monitor') {
        const intervalMs = args.monitor_interval_ms;
        if (!isValidShellMonitorIntervalMs(intervalMs)) {
            return `Error: task monitor_interval_ms must be 0 or an integer from ${SHELL_MONITOR_INTERVAL_MIN_MS} to ${SHELL_MONITOR_INTERVAL_MAX_MS} ms`;
        }
        if (!isShellTask) return `Error: task monitoring is only available for shell tasks: ${taskId}`;
        const configured = configureBackgroundShellJobMonitor(taskId, intervalMs);
        if (configured == null) return `Error: shell task is not running: ${taskId}`;
        return [
            'status: running',
            `task_id: ${taskId}`,
            `monitoring: ${configured === 0 ? 'off' : 'on'}`,
            `monitor_interval_ms: ${configured}`,
        ].join('\n');
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

    return `Error: task action must be one of list|read|monitor|cancel (got ${JSON.stringify(args.action)})`;
}
