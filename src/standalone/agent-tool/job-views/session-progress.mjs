// job-views/session-progress.mjs
// Live progress of a worker session (stage, silence, watchdog, queued
// follow-ups) and the frozen fields a finished job reports instead.
import { resolveAgentWatchdogPolicy } from '../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { buildAgentTaskProgressFields } from '../../agent-task-status.mjs';
import { getProgressWatchdogState } from '../../agent-watchdog-registry.mjs';

// Job statuses that can never progress again (mirrors TERMINAL_STATUSES in
// runtime/shared/background-tasks.mjs; 'canceled' accepted defensively).
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled']);

export function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(
    String(status ?? '')
      .trim()
      .toLowerCase()
  );
}

// A finished job is frozen history. Tags are reused, so its meta.sessionId can
// point at a session that is NOW running a *different* job; reading live
// progress for it made every old completed row inherit the current worker's
// stage ("20 completed rows all reporting streaming/model active"). Terminal
// rows therefore report only their own recorded status: no live worker
// snapshot, no silent_for/watchdog/queued_followups.
export function terminalJobFrozenFields(status, now = Date.now()) {
  const stage =
    String(status ?? '')
      .trim()
      .toLowerCase() || 'unknown';
  return {
    workerStatus: stage,
    stage,
    clientHostPid: null,
    lastStreamDeltaAt: null,
    ...buildAgentTaskProgressFields({ now, runtimeStage: stage, taskStatus: stage }),
  };
}

export function createSessionProgress({ mgr }) {
  function sessionProgressExtras(sessionId, role, now = Date.now(), taskStatus = null) {
    if (!sessionId) return {};
    const session = mgr.getSession(sessionId);
    const runtime = mgr.getSessionRuntime?.(sessionId) || null;
    const snapshot =
      typeof mgr.getSessionProgressSnapshot === 'function' ? mgr.getSessionProgressSnapshot(sessionId) : null;
    const policy = role ? resolveAgentWatchdogPolicy(role) : null;
    const queuedFollowups =
      typeof mgr.getSessionPendingMessageDepth === 'function' ? mgr.getSessionPendingMessageDepth(sessionId) : null;
    return buildAgentTaskProgressFields({
      now,
      sessionStatus: session?.status || null,
      runtimeStage: runtime?.stage || snapshot?.stage || session?.status || null,
      snapshot,
      runtime,
      policy,
      watchdogState: getProgressWatchdogState(mgr, sessionId),
      queuedFollowups,
      taskStatus,
      lastToolCall: runtime?.lastToolCall || null,
    });
  }

  function jobWorkerSnapshot(sessionId) {
    if (!sessionId) return null;
    const session = mgr.getSession(sessionId);
    if (!session) return null;
    const runtime = mgr.getSessionRuntime?.(sessionId);
    const status = session.closed === true ? 'closed' : session.status || 'idle';
    const progress = sessionProgressExtras(sessionId, session.agent || null);
    return {
      workerStatus: status,
      stage: progress.worker_stage || runtime?.stage || status,
      clientHostPid: session.clientHostPid || null,
      lastStreamDeltaAt: runtime?.lastStreamDeltaAt ? new Date(runtime.lastStreamDeltaAt).toISOString() : null,
      ...progress,
    };
  }

  return { sessionProgressExtras, jobWorkerSnapshot };
}
