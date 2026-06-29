import {
  agentWatchdogPolicyActive,
  evaluateAgentWatchdogAbort,
} from '../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';

const ACTIVE_RUNTIME_STAGES = new Set([
  'connecting',
  'requesting',
  'streaming',
  'tool_running',
  'running',
  'cancelling',
]);

function positiveSeconds(now, ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, Math.floor((now - n) / 1000));
}

export function formatAgentWatchdogSummary(policy) {
  if (!policy || !agentWatchdogPolicyActive(policy)) return null;
  const parts = [];
  if (policy.firstResponseMs > 0) parts.push(`first=${Math.round(policy.firstResponseMs / 1000)}s`);
  if (policy.idleStaleMs > 0) parts.push(`idle=${Math.round(policy.idleStaleMs / 1000)}s`);
  if (policy.toolRunningMs > 0) parts.push(`tool=${Math.round(policy.toolRunningMs / 1000)}s`);
  return parts.length ? `armed ${parts.join(' ')}` : null;
}

export function resolveSilentForSeconds(now, snapshot, runtime) {
  const last = Math.max(
    snapshot?.lastProgressAt || 0,
    runtime?.lastProgressAt || 0,
    snapshot?.lastStreamDeltaAt || 0,
    runtime?.lastStreamDeltaAt || 0,
    snapshot?.toolStartedAt || 0,
    runtime?.toolStartedAt || 0,
    snapshot?.askStartedAt || 0,
    runtime?.askStartedAt || 0,
  );
  return positiveSeconds(now, last);
}

export function buildAgentTaskProgressFields({
  now = Date.now(),
  sessionStatus = null,
  runtimeStage = null,
  snapshot = null,
  runtime = null,
  policy = null,
  queuedFollowups = null,
  taskStatus = null,
  lastToolCall = null,
} = {}) {
  const stage = cleanStage(runtimeStage || snapshot?.stage || sessionStatus || 'unknown');
  const workerStage = stage;
  const silentFor = resolveSilentForSeconds(now, snapshot, runtime);
  const watchdog = formatAgentWatchdogSummary(policy);
  const queued = Number.isFinite(Number(queuedFollowups)) && Number(queuedFollowups) > 0
    ? Math.floor(Number(queuedFollowups))
    : null;

  const lastProgress = describeLastProgress({
    stage,
    snapshot,
    runtime,
    silentFor,
    lastToolCall: lastToolCall || runtime?.lastToolCall || null,
    now,
  });

  const diagnostic = describeAgentDiagnostic({
    taskStatus,
    sessionStatus,
    stage,
    snapshot,
    silentFor,
    queued,
    policy,
    now,
  });

  const out = {
    worker_stage: workerStage,
    last_progress: lastProgress,
    diagnostic,
  };
  if (silentFor != null && ACTIVE_RUNTIME_STAGES.has(stage)) out.silent_for = silentFor;
  if (watchdog) out.watchdog = watchdog;
  if (queued != null) out.queued_followups = queued;
  return out;
}

function cleanStage(value) {
  return String(value ?? '').trim() || 'unknown';
}

function describeLastProgress({ stage, snapshot, runtime, silentFor, lastToolCall, now }) {
  if (snapshot?.waitingForFirstActivity) return 'awaiting first model response';
  if (stage === 'tool_running') {
    const tool = cleanStage(lastToolCall);
    return tool && tool !== 'unknown' ? `tool: ${tool}` : 'tool running';
  }
  if (stage === 'connecting' || stage === 'requesting') return 'connecting to model';
  if (stage === 'streaming') {
    const streamSilent = positiveSeconds(
      now,
      snapshot?.lastStreamDeltaAt || runtime?.lastStreamDeltaAt || 0,
    );
    if (streamSilent != null && streamSilent >= 5) {
      return `streaming (no stream delta for ${streamSilent}s)`;
    }
    return 'streaming';
  }
  if (stage === 'cancelling') return 'cancelling';
  if (stage === 'done' || stage === 'idle') {
    if (runtime?.emptyFinal) return 'finished empty';
    return 'idle';
  }
  if (stage === 'error') return 'error';
  if (stage === 'closed') return 'closed';
  if (silentFor != null && ACTIVE_RUNTIME_STAGES.has(stage)) {
    return `active (${silentFor}s since last progress)`;
  }
  return stage;
}

function describeAgentDiagnostic({
  taskStatus,
  sessionStatus,
  stage,
  snapshot,
  silentFor,
  queued,
  policy,
  now,
}) {
  const normalizedTask = cleanStage(taskStatus).toLowerCase();
  if (normalizedTask === 'cancelled' || normalizedTask === 'canceled') return 'task cancelled';
  if (normalizedTask === 'failed' || normalizedTask === 'error') return 'task failed';
  if (normalizedTask === 'completed') {
    return sessionStatus === 'error' ? 'task completed (worker error)' : 'task completed; worker idle';
  }

  if (queued) {
    if (ACTIVE_RUNTIME_STAGES.has(stage)) {
      return `${stage}, ${queued} follow-up${queued === 1 ? '' : 's'} queued`;
    }
    return `idle, ${queued} follow-up${queued === 1 ? '' : 's'} queued`;
  }

  if (snapshot?.waitingForFirstActivity) return 'waiting for first response';

  if (stage === 'streaming') {
    const streamSilent = positiveSeconds(
      now,
      snapshot?.lastStreamDeltaAt || 0,
    );
    if (streamSilent != null && streamSilent >= 5) {
      return `streaming, no visible output yet (${streamSilent}s)`;
    }
    return 'streaming';
  }

  if (stage === 'tool_running') return 'tool running';
  if (stage === 'connecting' || stage === 'requesting') return 'waiting for first response';

  if (silentFor != null && policy && ACTIVE_RUNTIME_STAGES.has(stage)) {
    const abortErr = evaluateAgentWatchdogAbort(
      snapshot || { stage, lastProgressAt: now - silentFor * 1000 },
      now,
      policy,
    );
    if (abortErr) {
      return `stale: ${abortErr.message.replace(/^agent /i, '')}`;
    }
    if (silentFor >= 30) {
      return `stale: no stream/tool progress for ${silentFor}s`;
    }
  }

  if (normalizedTask === 'running' && (stage === 'idle' || stage === 'done')) {
    return 'task running; worker turn finished, awaiting job reconciliation';
  }

  if (stage === 'idle' || stage === 'done') return 'idle';
  if (stage === 'cancelling') return 'cancelling';
  if (stage === 'error') return 'worker error';
  if (stage === 'closed') return 'closed';

  return stage;
}

export function appendAgentProgressKv(line, fields = {}) {
  const parts = [line];
  if (fields.worker_stage) parts.push(`stage=${fields.worker_stage}`);
  if (fields.last_progress) parts.push(`last_progress=${fields.last_progress}`);
  if (Number.isFinite(fields.silent_for)) parts.push(`silent_for=${fields.silent_for}s`);
  if (fields.watchdog) parts.push(`watchdog=${fields.watchdog}`);
  if (Number.isFinite(fields.queued_followups)) parts.push(`queued_followups=${fields.queued_followups}`);
  if (fields.diagnostic) parts.push(`hint=${fields.diagnostic}`);
  return parts.join(' ');
}
