// Result-rendering + finish-classification helpers extracted from the
// agent-tool facade. Pure functions; behavior-preserving (bodies identical to
// the originals, only cross-module deps are now imported).
import { appendAgentProgressKv } from '../agent-task-status.mjs';
import { compactIso, elapsedFromStamps, stripFinalAnswerWrapper } from './helpers.mjs';

// A worker that hits the loop iteration ceiling, gets truncated mid-synthesis,
// or produces an empty terminal turn returns content:'' but never throws — so
// the background task would otherwise reconcile as a benign `completed` empty
// success. That is wrong: an empty final answer is an error. loop.mjs is the
// single classifier: it tags result.terminationReason for abnormal finishes
// (carried through manager.mjs terminalResultPreview). We key purely off that
// here. iteration_cap / truncated are real problems for EVERY agent (hidden
// too). The plain `empty` case is tagged by the loop ONLY for public agents;
// hidden agents (explorer/cycle/…) legitimately emit empty terminal turns and
// are left untagged, so they stay benign.
export function abnormalEmptyFinishError(result, agent) {
  // The loop (loop.mjs) is the single classifier: it tags terminationReason
  // ONLY for abnormal finishes, and gates the `empty` case behind !hidden.
  // So we key purely off terminationReason here — no separate content/hidden
  // check, which previously (a) exempted hidden agents from cap/truncated and
  // (b) let a capped tool-call turn with preamble text slip through as success.
  const reason = result?.terminationReason;
  if (!reason) return null;
  const iterations = result?.iterations ?? 0;
  const toolCallsTotal = result?.toolCallsTotal ?? 0;
  const maxLoopIterations = result?.maxLoopIterations ?? 0;
  const stopReason = result?.stopReason ?? result?.stop_reason ?? null;
  switch (reason) {
    case 'iteration_cap':
      // Real problem for EVERY agent (hidden too): the loop never terminated on
      // its own contract, so any preamble text is not a trustworthy final answer.
      return `agent '${agent}' hit the loop iteration ceiling (${maxLoopIterations} iterations, ${toolCallsTotal} tool calls) without producing a final answer`;
    case 'truncated':
      return `agent '${agent}' response was truncated (stopReason=${stopReason}) before a final answer (${iterations} iterations, ${toolCallsTotal} tool calls)`;
    case 'empty':
      // Only tagged for PUBLIC agents (hidden agents legitimately emit empty
      // terminal turns and are left untagged by the loop).
      return `agent '${agent}' finished without a final answer (stopReason=${stopReason ?? 'none'}, ${iterations} iterations, ${toolCallsTotal} tool calls)`;
    default:
      return null;
  }
}

export function renderResult(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const lines = [];

    if (Array.isArray(value.workers) || Array.isArray(value.jobs)) {
      const workers = Array.isArray(value.workers) ? value.workers : [];
      lines.push(`agents: ${workers.length}`);
      for (const worker of workers) {
        const tokens = worker.windowTokens ? ` ctx=${worker.windowTokens}${worker.windowCap ? `/${worker.windowCap}` : ''}` : '';
        const terminal = worker.clientHostPid ? ` term=${worker.clientHostPid}` : '';
        const base = `- ${worker.tag} ${worker.agent || 'agent'} ${worker.status || 'idle'}/${worker.worker_stage || worker.stage || 'idle'} ${worker.provider}/${worker.model}${terminal}${tokens}`;
        lines.push(appendAgentProgressKv(base, worker));
      }
      const jobs = Array.isArray(value.jobs) ? value.jobs : [];
      lines.push(`tasks: ${jobs.length}`);
      for (const job of jobs) {
        const target = job.tag || job.sessionId || '-';
        const terminal = job.clientHostPid ? ` term=${job.clientHostPid}` : '';
        const base = `- ${job.task_id} ${job.type} ${job.status} target=${target}${terminal}${job.error ? ` error=${job.error}` : ''}`;
        lines.push(appendAgentProgressKv(base, job));
      }
      if (workers.length === 0 && jobs.length === 0) lines.push('(no agents or tasks)');
      return lines.join('\n');
    }

    if (value.task_id) {
      lines.push(`agent task: ${value.task_id}`);
      lines.push(`status: ${value.status}`);
      if (value.type) lines.push(`type: ${value.type}`);
      if (value.reused) lines.push('reused: true');
      if (value.tag || value.sessionId) lines.push(`target: ${value.tag || '-'} ${value.sessionId || ''}`.trim());
      if (value.agent) lines.push(`agent: ${value.agent}`);
      if (value.provider && value.model) lines.push(`model: ${value.provider}/${value.model}`);
      if (value.effort) lines.push(`effort: ${value.effort}`);
      if (value.fast === true || value.fast === false) lines.push(`fast: ${value.fast ? 'on' : 'off'}`);
      if (value.maxLoopIterations) {
        const limitParts = [];
        if (value.maxLoopIterations) limitParts.push(`loop=${value.maxLoopIterations}`);
        lines.push(`limits: ${limitParts.join(' ')}`);
      }
      if (value.stage || value.workerStatus) lines.push(`worker: ${value.workerStatus || 'unknown'}/${value.stage || 'unknown'}`);
      if (value.worker_stage) lines.push(`worker_stage: ${value.worker_stage}`);
      if (value.last_progress) lines.push(`last_progress: ${value.last_progress}`);
      if (Number.isFinite(value.silent_for)) lines.push(`silent_for: ${value.silent_for}s`);
      if (value.watchdog) lines.push(`watchdog: ${value.watchdog}`);
      if (Number.isFinite(value.queued_followups)) lines.push(`queued_followups: ${value.queued_followups}`);
      if (value.diagnostic) lines.push(`diagnostic: ${value.diagnostic}`);
      if (value.startedAt) lines.push(`started: ${compactIso(value.startedAt)}`);
      if (value.finishedAt) lines.push(`finished: ${compactIso(value.finishedAt)}`);
      {
        const elapsed = elapsedFromStamps(value.startedAt, value.finishedAt, value.status);
        if (elapsed) lines.push(`elapsed: ${elapsed}`);
      }
      if (value.error) lines.push(`error: ${value.error}`);
      if (value.status === 'running') lines.push('notification: completion will be delivered to the owner session; use read/status only for manual recovery.');
      if (value.result !== undefined) {
        const result = value.result;
        const content = typeof result === 'string' ? result : result?.content;
        if (content) lines.push('', stripFinalAnswerWrapper(content));
        else lines.push('', JSON.stringify(result, null, 2));
      }
      return lines.join('\n');
    }

    if (value.queued) {
      return [
        'agent message queued',
        value.reused ? 'reused: true' : null,
        `target: ${value.tag || '-'} ${value.sessionId || ''}`.trim(),
        value.agent ? `agent: ${value.agent}` : null,
        `queueDepth: ${value.queueDepth ?? 1}`,
      ].filter(Boolean).join('\n');
    }

    if (value.closed !== undefined) {
      return [
        `agent close: ${value.closed ? 'ok' : 'not closed'}`,
        value.tag ? `tag: ${value.tag}` : null,
        value.sessionId ? `sessionId: ${value.sessionId}` : null,
        value.task_id ? `task_id: ${value.task_id}` : null,
        value.forgotten ? 'forgotten: true' : null,
      ].filter(Boolean).join('\n');
    }

    if (value.content !== undefined) {
      const header = [
        value.respawned ? 'agent respawned' : 'agent result',
        value.tag ? `tag=${value.tag}` : null,
        value.agent ? `agent=${value.agent}` : null,
        value.provider && value.model ? `${value.provider}/${value.model}` : null,
      ].filter(Boolean).join(' ');
      return `${header}\n${stripFinalAnswerWrapper(value.content)}`;
    }
  }
  return JSON.stringify(value, null, 2);
}
