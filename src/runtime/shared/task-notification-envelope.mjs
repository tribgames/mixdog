// Shared wire format. Scalar fields are escaped; result text is verbatim.
export {
  isInternalRuntimeNotificationText,
  isBracketedShellNotificationEnvelope,
  backgroundTaskHeaderStatus,
} from './tool-execution-contract.mjs';
import { displayShellCommand } from './shell-display.mjs';

function escapeField(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function decodeField(value) {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function field(name, value) {
  return `<${name}>${escapeField(value)}</${name}>`;
}

export function taskCompletionSummary({ surface = 'tool', id, tag, status, error, detail } = {}) {
  let subject;
  if (surface === 'agent') subject = `Agent "${tag || id}"`;
  else if (surface === 'shell') subject = 'Shell task';
  else subject = `${surface} task`;
  const outcome = status === 'cancelled' || status === 'canceled' ? 'was cancelled' : status || 'completed';
  return `${subject} ${outcome}${status === 'failed' && error ? `: ${error}` : ''}${detail ? ` (${detail})` : ''}`;
}

export function renderTaskCompletionEnvelope({
  surface = 'tool',
  id,
  tag,
  status,
  result = '',
  error,
  detail,
  outputFile,
} = {}) {
  return [
    '<task-notification>',
    field('task-id', id),
    tag ? field('tag', tag) : null,
    field('status', status),
    field('summary', taskCompletionSummary({ surface, id, tag, status, detail })),
    outputFile ? field('output-file', outputFile) : null,
    result ? `<result>\n${result}\n</result>` : null,
    status === 'failed' && error ? field('error', error) : null,
    '</task-notification>',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

// A delivered report stays in the parent's context until the next compaction, so
// each one is bounded on its own. Observed agent reports average ~1k tokens
// (~4k chars) and peak near 3k tokens; oh-my-pi previews 5k chars and Hermes
// floors a summary at 2k. 4k keeps the typical report whole and halves the
// outliers; head and tail are both kept (as Hermes does) so a closing `Open:`
// section survives. The limit is a hard ceiling on the whole preview.
export const TASK_REPORT_LIMIT = 4000;
const STATUS_LINE_MAX = 200;
const TAIL_SHARE = 0.35;
const OPEN_SHARE = 0.5;
const STATUS_LINE_RE = /^[ \t>*#_-]*Status:.*$/m;
const OPEN_LINE_RE = /^[ \t>*#_-]*Open:/gm;

// A slice must not start or end inside a surrogate pair.
function wholeChars(value) {
  return value.replace(/^[\uDC00-\uDFFF]/, '').replace(/[\uD800-\uDBFF]$/, '');
}

function openOverflowNote(omitted) {
  return `\n[… Open: ${omitted} more chars omitted — see the full report]`;
}

/** `report` unchanged when within `limit`; otherwise a preview of at most
 *  `limit` chars in total: the (clipped) `Status:` line, the head, a marker
 *  carrying `pointer`, then the tail. When the report has an `Open:` section
 *  the tail is that section (clipped with an overflow note only when it is
 *  huge), else the last chars. A preview is itself within `limit`, so bounding
 *  twice changes nothing. */
export function boundTaskReport(report, { limit = TASK_REPORT_LIMIT, pointer = '' } = {}) {
  const text = String(report ?? '');
  if (text.length <= limit) return text;
  const markerFor = (omitted) =>
    `[… ${omitted} of ${text.length} chars omitted${pointer ? `; ${pointer}` : ''}]`;

  let statusBlock = '';
  let body = text;
  const statusMatch = STATUS_LINE_RE.exec(text);
  if (statusMatch) {
    const line = statusMatch[0];
    statusBlock = `${line.length > STATUS_LINE_MAX ? `${wholeChars(line.slice(0, STATUS_LINE_MAX - 1))}…` : line}\n`;
    body = text.slice(0, statusMatch.index) + text.slice(statusMatch.index + line.length).replace(/^\n/, '');
  }
  let openAt = -1;
  for (const match of body.matchAll(OPEN_LINE_RE)) openAt = match.index;

  const fixed =
    statusBlock.length + markerFor(text.length).length + 4 + (openAt >= 0 ? openOverflowNote(text.length).length : 0);
  const avail = Math.max(0, limit - fixed);

  const tailBudget = Math.floor(avail * TAIL_SHARE);
  let tail = body.slice(body.length - tailBudget);
  const tailBreak = tail.indexOf('\n');
  if (tailBreak >= 0 && tailBreak < tailBudget / 2) tail = tail.slice(tailBreak + 1);
  tail = wholeChars(tail);
  let tailStart = body.length - tail.length;
  let note = '';
  if (openAt >= 0 && body.length - openAt > tail.length) {
    const open = body.slice(openAt);
    const openBudget = Math.floor(avail * OPEN_SHARE);
    tailStart = openAt;
    if (open.length <= openBudget) tail = open;
    else {
      tail = wholeChars(open.slice(0, openBudget));
      note = openOverflowNote(open.length - tail.length);
    }
  }

  const headLimit = Math.min(Math.max(0, avail - tail.length), tailStart);
  let head = body.slice(0, headLimit);
  const headBreak = head.lastIndexOf('\n');
  if (headLimit < tailStart && headBreak > headLimit / 2) head = head.slice(0, headBreak);
  head = wholeChars(head);

  const shown = head.length + (note ? tail.length : body.length - tailStart) + statusBlock.length;
  const omitted = Math.max(0, text.length - shown);
  return `${statusBlock}${head}\n\n${markerFor(omitted)}\n\n${tail}${note}`;
}

/** `text` (a tagged notification) with its `<result>` body replaced, and an
 *  `<output-file>` field naming where the complete body is kept when given. */
export function replaceTaskNotificationResult(text, result, outputFile = '') {
  const value = String(text ?? '');
  const open = '\n<result>\n';
  const start = value.indexOf(open);
  const end = value.lastIndexOf('\n</result>');
  if (start < 0 || end < start) return value;
  const fileField = outputFile ? `\n${field('output-file', outputFile)}` : '';
  return `${value.slice(0, start)}${fileField}${open}${result}${value.slice(end)}`;
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
  let surface;
  if (fields.summary.startsWith('Agent "')) surface = 'agent';
  else if (fields.summary.startsWith('Shell task ')) surface = 'shell';
  else surface = /^(\S+) task /.exec(fields.summary)?.[1] || 'tool';
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
  return (
    /^(?:> )?(?:\[?task_id:|agent task:)\s*([^\s\]]+)/im.exec(value)?.[1] ||
    /^Async \S+ task (\S+) /i.exec(value)?.[1] ||
    ''
  );
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
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function renderShellCompletionNotice(options) {
  return renderShellCompletionEnvelope({
    ...options,
    summary: null,
    stdoutPreview: null,
    stderrPreview: null,
    result: `Retrieve output with task read (task_id: ${options.jobId}) only if it has not already been received.`,
  });
}

export function shellCompletionInstruction({ jobId, status, exitCode = null } = {}) {
  return taskCompletionSummary({
    surface: 'shell',
    id: jobId,
    status,
    detail: `exit ${exitCode === null ? 'n/a' : exitCode}`,
  });
}
