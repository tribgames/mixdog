/**
 * background-task.mjs — the `background task` result envelope: parsing it,
 * merging the tool args into it and rendering its titles and detail rows.
 */
import { backgroundTaskFailureStatusLabel, isBackgroundErrorOnlyBody } from '../err-text.mjs';
import { formatElapsed } from '../time-format.mjs';
import { titleizeAgentName } from './agent-surface.mjs';
import { displayTerminalStatus, prefixElapsed } from './terminal-status.mjs';
import { parseTaskNotification } from '../task-notification-envelope.mjs';

const BACKGROUND_TASK_TOOL_NAMES = new Set(['web_search', 'shell', 'bash', 'bash_session', 'shell_command', 'task']);

export function isBackgroundTaskTool(normalizedName) {
  return BACKGROUND_TASK_TOOL_NAMES.has(String(normalizedName || '').toLowerCase());
}

export function parseBackgroundTaskResult(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const notification = parseTaskNotification(text);
  if (notification) {
    return {
      taskId: notification.taskId,
      surface: notification.surface,
      operation: '',
      label: notification.tag,
      status: notification.status,
      startedAt: '',
      finishedAt: '',
      body: notification.result,
      error: notification.error,
      hasResponse: Boolean(notification.result) && !isBackgroundErrorOnlyBody(notification.result, notification.error),
    };
  }
  const allLines = text.split('\n');
  const start = allLines.findIndex((line) => line.trim() === 'background task');
  if (start < 0) return null;
  const rest = allLines.slice(start + 1);
  const blank = rest.findIndex((line) => !line.trim());
  const headLines = blank >= 0 ? rest.slice(0, blank) : rest;
  const body =
    blank >= 0
      ? rest
          .slice(blank + 1)
          .join('\n')
          .trim()
      : '';
  const fields = {};
  for (const line of headLines) {
    const match = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  const status = String(fields.status || '').toLowerCase();
  const error = fields.error || '';
  return {
    taskId: fields.task_id || fields.taskid || '',
    surface: fields.surface || '',
    operation: fields.operation || '',
    label: fields.label || '',
    status,
    startedAt: fields.started || fields.startedat || '',
    finishedAt: fields.finished || fields.finishedat || '',
    body,
    error,
    hasResponse:
      Boolean(body) && !isBackgroundErrorOnlyBody(body, error) && !/^(running|pending|queued)$/i.test(status),
  };
}

function backgroundTaskMetaFromArgs(args = {}) {
  const taskId = String(args.task_id || args.taskId || '').trim();
  if (!taskId) return null;
  return {
    taskId,
    surface: args.surface || '',
    operation: args.operation || '',
    label: args.label || '',
    status: String(args.status || '').toLowerCase(),
    startedAt: args.startedAt || args.started || '',
    finishedAt: args.finishedAt || args.finished || '',
    error: args.error || '',
    type: args.type || args.action || '',
    body: '',
    hasResponse: false,
  };
}

export function resolveBackgroundTaskMeta(parsedArgs = {}, resultText = '') {
  const parsed = parseBackgroundTaskResult(resultText);
  if (parsed) {
    if (!parsed.error && parsedArgs?.error) parsed.error = parsedArgs.error;
    if (!parsed.status && parsedArgs?.status) parsed.status = String(parsedArgs.status).toLowerCase();
    if (!parsed.surface && parsedArgs?.surface) parsed.surface = parsedArgs.surface;
    return parsed;
  }
  return backgroundTaskMetaFromArgs(parsedArgs);
}

export function backgroundTaskElapsed(meta = {}, fallback = '') {
  const startedMs = Date.parse(meta.startedAt || '');
  const finishedMs = Date.parse(meta.finishedAt || '');
  if (Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs) {
    const elapsedMs = finishedMs - startedMs;
    return elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
  }
  return fallback || '';
}

function backgroundTaskDisplayName(normalizedName, meta = {}) {
  const surface = String(meta.surface || normalizedName || '').toLowerCase();
  if (surface === 'web_search') return 'Web Search';
  if (
    surface === 'shell' ||
    surface === 'bash' ||
    surface === 'bash_session' ||
    surface === 'shell_command' ||
    surface === 'task'
  )
    return 'Shell';
  return titleizeAgentName(surface || normalizedName || 'Task');
}

export function backgroundTaskResultTitle(normalizedName, meta = {}) {
  const display = backgroundTaskDisplayName(normalizedName, meta);
  if (display === 'Shell') return 'Shell output';
  if (display === 'Web Search') return 'Web Search results';
  return `${display} response`;
}

export function backgroundTaskActionTitle(normalizedName, meta = {}) {
  const display = backgroundTaskDisplayName(normalizedName, meta);
  if (/^(running|pending|queued)$/i.test(meta.status || '')) {
    return String(meta.type || '').toLowerCase() === 'progress' ? `${display} progress` : `Started ${display}`;
  }
  if (meta.hasResponse) return backgroundTaskResultTitle(normalizedName, meta);
  return `${display} status`;
}

export function backgroundTaskFailureDetail(meta = {}, parsedArgs = {}) {
  const status = meta.status || parsedArgs?.status;
  const error = meta.error || parsedArgs?.error;
  if (!error) return '';
  const surface = meta.surface || parsedArgs?.surface || '';
  return backgroundTaskFailureStatusLabel(status, error, { surface });
}

export function backgroundTaskDetail(meta = {}, elapsed = '', _parsedArgs = {}) {
  const parts = [];
  const status = displayTerminalStatus(meta.status);
  if (status) parts.push(status);
  if (meta.taskId) parts.push(`task_id: ${meta.taskId}`);
  const firstBodyLine =
    String(meta.body || '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || '';
  if (firstBodyLine && /^(running|pending|queued)$/i.test(meta.status || '')) parts.push(firstBodyLine);
  return prefixElapsed(parts.join(' · '), elapsed);
}

export function isBackgroundTaskResponseArgs(normalizedName, args = {}) {
  if (!isBackgroundTaskTool(normalizedName)) return false;
  const type = String(args?.type || args?.action || '').toLowerCase();
  const status = String(args?.status || '').toLowerCase();
  if (/^(running|pending|queued)$/i.test(status)) return false;
  return (
    type === 'result' ||
    type === 'completion' ||
    (/^(completed|cancelled|canceled)$/i.test(status) && Boolean(args?.task_id))
  );
}
