// Pure result-rendering and finish-classification helpers.
import { oneLine } from '../../../runtime/shared/clean.mjs';
import { isActiveWorkerRow } from './job-views/agent-list.mjs';
import { isTerminalJobStatus } from './job-views/session-progress.mjs';
import { compactIso, elapsedFromStamps, stripFinalAnswerWrapper } from './helpers.mjs';

// A worker that gets truncated mid-synthesis or produces an empty terminal
// turn can return content:'' without throwing — so
// the background task would otherwise reconcile as a benign `completed` empty
// success. That is wrong: an empty final answer is an error. loop.mjs is the
// single classifier: it tags result.terminationReason for abnormal finishes
// (carried through manager.mjs terminalResultPreview). We key purely off that
// here. Truncation is a real problem for EVERY agent (hidden too). The plain
// `empty` case is tagged by the loop ONLY for public agents;
// hidden agents (cycle/…) legitimately emit empty terminal turns and
// are left untagged, so they stay benign.
export function abnormalEmptyFinishError(result, agent) {
  const reason = result?.terminationReason;
  if (!reason) return null;
  const iterations = result?.iterations ?? 0;
  const toolCallsTotal = result?.toolCallsTotal ?? 0;
  const stopReason = result?.stopReason ?? result?.stop_reason ?? null;
  switch (reason) {
    case 'truncated':
      return `agent '${agent}' response was truncated (stopReason=${stopReason}) before a final answer (${iterations} iterations, ${toolCallsTotal} tool calls)`;
    case 'empty':
      // Only tagged for PUBLIC agents (hidden agents legitimately emit empty
      // terminal turns and are left untagged by the loop).
      return `agent '${agent}' finished without a final answer (stopReason=${stopReason ?? 'none'}, ${iterations} iterations, ${toolCallsTotal} tool calls)`;
    case 'refusal':
      return `agent '${agent}' response was refused by the safety classifier (${iterations} iterations, ${toolCallsTotal} tool calls)`;
    default:
      return null;
  }
}

const ROSTER_TAIL = 5;
const ROSTER_MATCH_CAP = 25;

function workerLine(worker) {
  const status = worker.status || 'idle';
  const stage = worker.worker_stage || worker.stage;
  const progress = oneLine(worker.last_progress);
  const summary = progress.length > 60 ? `${progress.slice(0, 59)}…` : progress;
  return `- ${worker.tag}  ${status}${stage && stage !== status ? `/${stage}` : ''}${summary ? `  ${summary}` : ''}`;
}

function jobLine(job) {
  const error = job.status === 'failed' ? oneLine(job.error) : '';
  return `- ${job.task_id}  ${job.type}  ${job.status}  ${job.tag || '-'}${error ? ` error=${error}` : ''}`;
}

const stamp = (row) => String(row.updatedAt || row.lastUsedAt || row.finishedAt || row.startedAt || '');

// Inactive rows: newest first (stable for rows without stamps).
const newestFirst = (rows) => rows.slice().sort((a, b) => stamp(b).localeCompare(stamp(a)));

// Inactive rows collapse to a count plus a short tail. A `tag` filter lists the
// matching inactive rows (bounded) so a specific one can still be found.
function inactiveSection(label, rows, render, tagOf, filter) {
  if (rows.length === 0) return [];
  const needle = filter.toLowerCase();
  const matched = needle
    ? rows.filter((row) =>
        String(tagOf(row) ?? '')
          .toLowerCase()
          .includes(needle)
      )
    : null;
  const shown = newestFirst(matched ?? rows).slice(0, matched ? ROSTER_MATCH_CAP : ROSTER_TAIL);
  const shownFilter = filter.replace(/\s+/g, ' ');
  const head = matched
    ? `${label}: ${rows.length} (${matched.length} match tag "${shownFilter}", showing ${shown.length})`
    : `${label}: ${rows.length} (latest ${shown.length}; pass tag=<text> to find one)`;
  // Bulleted: a non-bullet line would make the list read as an authored response.
  return [`- ${head}`, ...shown.map(render)];
}

// The /agents roster: active workers and running tasks in full; idle/closed
// workers and finished tasks as counts with a bounded tail.
function renderRoster(value, filter = '') {
  const workers = Array.isArray(value.workers) ? value.workers : [];
  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  const lines = [`agents: ${workers.length} · tasks: ${jobs.length}`];
  const isActive = (worker) => Boolean(worker.awaitingUser) || isActiveWorkerRow(worker);
  const isRunning = (job) => !isTerminalJobStatus(job.status);
  // Keep list bullets: agent cards distinguish these rows from authored responses.
  lines.push(...workers.filter(isActive).map(workerLine));
  lines.push(...jobs.filter(isRunning).map(jobLine));
  lines.push(
    ...inactiveSection(
      'idle/closed agents',
      workers.filter((w) => !isActive(w)),
      workerLine,
      (w) => w.tag,
      filter
    )
  );
  lines.push(
    ...inactiveSection(
      'finished tasks',
      jobs.filter((j) => !isRunning(j)),
      jobLine,
      (j) => j.tag || j.task_id,
      filter
    )
  );
  if (workers.length === 0 && jobs.length === 0) lines.push('(no agents or tasks)');
  return lines.join('\n');
}

// Runtime diagnostics of a task envelope: everything a fresh start ack omits.
function taskDiagnosticLines(value) {
  const lines = [];
  if (value.agent) lines.push(`agent: ${value.agent}`);
  if (value.provider && value.model) lines.push(`model: ${value.provider}/${value.model}`);
  if (value.effort) lines.push(`effort: ${value.effort}`);
  if (value.fast === true || value.fast === false) lines.push(`fast: ${value.fast ? 'on' : 'off'}`);
  if (value.stage || value.workerStatus)
    lines.push(`worker: ${value.workerStatus || 'unknown'}/${value.stage || 'unknown'}`);
  if (value.worker_stage) lines.push(`worker_stage: ${value.worker_stage}`);
  if (value.last_progress) lines.push(`last_progress: ${value.last_progress}`);
  if (Number.isFinite(value.silent_for)) lines.push(`silent_for: ${value.silent_for}s`);
  if (value.watchdog) lines.push(`watchdog: ${value.watchdog}`);
  if (Number.isFinite(value.queued_followups)) lines.push(`queued_followups: ${value.queued_followups}`);
  if (value.diagnostic) lines.push(`diagnostic: ${value.diagnostic}`);
  if (value.startedAt) lines.push(`started: ${compactIso(value.startedAt)}`);
  if (value.finishedAt) lines.push(`finished: ${compactIso(value.finishedAt)}`);
  const elapsed = elapsedFromStamps(value.startedAt, value.finishedAt);
  if (elapsed) lines.push(`elapsed: ${elapsed}`);
  return lines;
}

// A background task envelope (spawn/send/status/cancel ack, with or without a
// finished result).
function renderTask(value, includeDiagnostics) {
  // Spawn/send acks: the task just started, so runtime diagnostics
  // (worker_stage/last_progress/diagnostic/watchdog/silent_for) are
  // always in their "not started yet" placeholder state — pure token
  // cost for the model. Keep the ack minimal (existing surface rule:
  // minimum characters, maximum information); full diagnostics remain
  // on explicit status/read recovery calls.
  const isStartAck =
    !includeDiagnostics && value.status === 'running' && (value.type === 'spawn' || value.type === 'send');
  const lines = [`agent task: ${value.task_id}`];
  // Cancel/close acks can carry no status; never serialize a literal
  // "status: undefined" into the envelope (the TUI card would titleize it).
  if (value.status != null && String(value.status).trim() !== '') {
    lines.push(`status: ${value.status}`);
  }
  if (value.type) lines.push(`type: ${value.type}`);
  if (value.reused) lines.push('reused: true');
  if (value.respawned) lines.push('respawned: true');
  if (value.note) lines.push(`note: ${value.note}`);
  if (value.tag || value.sessionId) lines.push(`target: ${value.tag || '-'} ${value.sessionId || ''}`.trim());
  if (!isStartAck) lines.push(...taskDiagnosticLines(value));
  if (value.error) lines.push(`error: ${value.error}`);
  if (value.status === 'running') lines.push('notification: completion will be delivered; end the turn.');
  if (value.result !== undefined) {
    const result = value.result;
    const content = typeof result === 'string' ? result : result?.content;
    if (content) lines.push('', stripFinalAnswerWrapper(content));
    else lines.push('', JSON.stringify(result, null, 2));
  }
  return lines.join('\n');
}

function renderQueued(value) {
  return [
    'agent message queued',
    value.reused ? 'reused: true' : null,
    `target: ${value.tag || '-'} ${value.sessionId || ''}`.trim(),
    value.agent ? `agent: ${value.agent}` : null,
    `queueDepth: ${value.queueDepth ?? 1}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderClosed(value) {
  return [
    `agent close: ${value.closed ? 'ok' : 'not closed'}`,
    value.tag ? `tag: ${value.tag}` : null,
    value.sessionId ? `sessionId: ${value.sessionId}` : null,
    value.task_id ? `task_id: ${value.task_id}` : null,
    value.forgotten ? 'forgotten: true' : null,
  ]
    .filter(Boolean)
    .join('\n');
}

// An agent's authored answer, optionally headed by its identity.
function renderContent(value) {
  if (value.handoffOnly === true) {
    return stripFinalAnswerWrapper(value.content);
  }
  const header = [
    value.respawned ? 'agent respawned' : 'agent result',
    value.tag ? `tag=${value.tag}` : null,
    value.agent ? `agent=${value.agent}` : null,
    value.provider && value.model ? `${value.provider}/${value.model}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return `${header}\n${stripFinalAnswerWrapper(value.content)}`;
}

export function renderResult(value, { includeDiagnostics = false, listFilter = '' } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (Array.isArray(value.workers) || Array.isArray(value.jobs)) return renderRoster(value, listFilter);
    // close-flow results carry `closed` plus task_id: render the close outcome.
    // close-flow results carry `closed` plus task_id: render the close outcome.
    if (value.closed !== undefined) return renderClosed(value);
    if (value.task_id) return renderTask(value, includeDiagnostics);
    if (value.queued) return renderQueued(value);
    if (value.content !== undefined) return renderContent(value);
  }
  return JSON.stringify(value, null, 2);
}
