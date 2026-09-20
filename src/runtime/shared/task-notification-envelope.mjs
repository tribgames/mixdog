// Shared wire format. Scalar fields are escaped; result text is verbatim.
export {
  isInternalRuntimeNotificationText,
  isBracketedShellNotificationEnvelope,
  backgroundTaskHeaderStatus,
} from './tool-execution-contract.mjs';
import { displayShellCommand } from './shell-display.mjs';

function escapeField(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function decodeField(value) {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function field(name, value) {
  return `<${name}>${escapeField(value)}</${name}>`;
}

export function taskCompletionSummary({ surface = 'tool', id, tag, status, error, detail } = {}) {
  const subject = surface === 'agent' ? `Agent "${tag || id}"` : `${surface === 'shell' ? 'Shell' : surface} task`;
  const outcome = status === 'cancelled' || status === 'canceled' ? 'was cancelled' : status || 'completed';
  return `${subject} ${outcome}${status === 'failed' && error ? `: ${error}` : ''}${detail ? ` (${detail})` : ''}`;
}

export function renderTaskCompletionEnvelope({ surface = 'tool', id, tag, status, result = '', error } = {}) {
  return [
    '<task-notification>',
    field('task-id', id),
    tag ? field('tag', tag) : null,
    field('status', status),
    field('summary', taskCompletionSummary({ surface, id, tag, status, error })),
    result ? `<result>\n${result}\n</result>` : null,
    status === 'failed' && error ? field('error', error) : null,
    '</task-notification>',
  ].filter((line) => line !== null).join('\n');
}

export function renderAgentCompletionEnvelope(options = {}) {
  return renderTaskCompletionEnvelope({ ...options, surface: 'agent' });
}

// Parse only the outer fields. A result may itself contain tags (including
// task notifications), so never search its contents for metadata.
export function parseTaskNotification(text) {
  const value = String(text ?? '').trim();
  if (!value.startsWith('<task-notification>\n') || !value.endsWith('\n</task-notification>')) return null;
  let fieldsText = value.slice('<task-notification>\n'.length, -'\n</task-notification>'.length);
  let result = '';
  const start = fieldsText.indexOf('\n<result>\n');
  if (start >= 0) {
    const end = fieldsText.lastIndexOf('\n</result>');
    if (end < start) return null;
    result = fieldsText.slice(start + '\n<result>\n'.length, end);
    fieldsText = fieldsText.slice(0, start) + fieldsText.slice(end + '\n</result>'.length);
  }
  const fields = {};
  for (const match of fieldsText.matchAll(/^<([\w-]+)>([^<]*)<\/\1>$/gm)) {
    fields[match[1]] = decodeField(match[2]);
  }
  if (!fields['task-id'] || !/^(completed|failed|cancelled)$/.test(fields.status || '') || !fields.summary) return null;
  const surface = fields.summary.startsWith('Agent "') ? 'agent' : fields.summary.startsWith('Shell task ')
    ? 'shell' : /^(\S+) task /.exec(fields.summary)?.[1] || 'tool';
  return {
    taskId: fields['task-id'],
    tag: fields.tag || '',
    surface,
    status: fields.status,
    summary: fields.summary,
    result,
    error: fields.error || '',
    exitCode: /^-?\d+$/.test(fields['exit-code'] || '') ? Number(fields['exit-code']) : null,
    outputFile: fields['output-file'] || '',
  };
}

export function taskNotificationHasBody(text) {
  const parsed = parseTaskNotification(text);
  return parsed ? Boolean(parsed.result || parsed.error) : /\n\s*\n[\s\S]*\S/.test(String(text || ''));
}

// Used for identity across persisted legacy wrappers and current envelopes.
export function taskNotificationId(text) {
  const parsed = parseTaskNotification(text);
  if (parsed) return parsed.taskId;
  const value = String(text ?? '');
  return /^(?:> )?(?:\[?task_id:|agent task:)\s*([^\s\]]+)/im.exec(value)?.[1]
    || /^Async \S+ task (\S+) /i.exec(value)?.[1] || '';
}

// The full command is already visible in the start response / task record;
// the envelope only needs an identifying prefix. Flatten whitespace and cap
// so multi-line commands do not re-echo hundreds of chars per notification.
function compactCommand(command) {
  if (!command) return null;
  const flat = displayShellCommand(command).replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

export function renderShellCompletionEnvelope({
  jobId,
  status,
  exitCode = null,
  command = null,
  summary = null,
  stdoutPreview = null,
  stderrPreview = null,
  mergeStderr = false,
  outputFile = null,
  error = null,
  result = null,
} = {}) {
  // `<exit-code>` is the verdict; a completed run with a non-zero exit is the
  // command's own result, so no explanatory banner is added to the body.
  const normalizedStatus = status === 'canceled' ? 'cancelled' : String(status || '').toLowerCase();
  const bodySections = [
    summary ? `Summary: ${summary}` : null,
    stdoutPreview ? `\n[stdout preview]\n${stdoutPreview}` : null,
    mergeStderr !== true && stderrPreview ? `\n[stderr preview]\n${stderrPreview}` : null,
  ].filter((l) => l !== null);
  const body = result ?? bodySections.join('\n');
  const commandText = compactCommand(command);
  const summaryText = shellCompletionInstruction({ jobId, status: normalizedStatus, exitCode });
  return [
    '<task-notification>',
    field('task-id', jobId),
    field('status', normalizedStatus),
    exitCode !== null ? field('exit-code', exitCode) : null,
    field('summary', `${summaryText}${commandText ? `: ${commandText}` : ''}`),
    outputFile ? field('output-file', outputFile) : null,
    body ? `<result>\n${body}\n</result>` : null,
    normalizedStatus === 'failed' && error ? field('error', error) : null,
    '</task-notification>',
  ].filter((line) => line !== null).join('\n');
}

export function shellCompletionInstruction({ jobId, status, exitCode = null } = {}) {
  return taskCompletionSummary({
    surface: 'shell',
    id: jobId,
    status,
    detail: `exit ${exitCode === null ? 'n/a' : exitCode}`,
  });
}
