// job-views/session-progress.mjs
// Live progress of a worker session (stage, silence, watchdog, queued
// follow-ups) and the frozen fields a finished job reports instead.
import { resolveAgentWatchdogPolicy } from '../../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { buildAgentTaskProgressFields } from '../../agent-task-status.mjs';
import { getProgressWatchdogState } from '../../agent-watchdog-registry.mjs';
import { _liveSessions } from '../../../../runtime/agent/orchestrator/session/store/live-state.mjs';
import { todoProgress } from '../../../../runtime/agent/orchestrator/runtime-core/todo-list.mjs';
import { waitedJobSilence } from '../../../../runtime/agent/orchestrator/tools/builtin/lib/shell-output-silence.mjs';

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

/** A worker/job row as the published session state carries it. That state
 *  (statusline, desktop, phone) re-reads agent status on a
 *  2s pulse, and these fields are the agent card's diagnostics, derived from
 *  the read time or the last stream delta: they changed on every read while
 *  nothing a surface shows did, so each pulse re-sent both row lists. Surfaces
 *  derive elapsed time from startedAt/turnStartedAt; the agent card still reads
 *  the diagnostics through renderJob/list directly. */
export function liveAgentStatusRow(row) {
  if (!row || typeof row !== 'object') return row;
  // The agent's own todo progress, from its live session only (an evicted
  // idle worker is not re-read on every pulse).
  const live = row.sessionId ? _liveSessions.get(row.sessionId) : null;
  const todo = live ? todoProgress(live) : null;
  if (todo) row = { ...row, todo };
  const {
    silent_for: _silentFor,
    tool_silent_for: _toolSilentFor,
    staleSeconds: _staleSeconds,
    lastStreamDeltaAt: _lastStreamDeltaAt,
    last_progress: _lastProgress,
    diagnostic: _diagnostic,
    ...stable
  } = row;
  return stable;
}

// The role default watchdog policy of a worker whose watchdog is not armed.
// Resolving one re-checks the shipped agent definitions (a sync stat at most
// once a second), so a status read from memory never resolves one: a role
// seen for the first time reads as having none until its policy is resolved
// on the next turn (onRolePolicyResolved announces it), and the maintenance
// pass re-resolves what is held (refreshRolePolicies).
const rolePolicies = new Map(); // role -> policy | null (being resolved)
const rolePolicyListeners = new Set();

function resolveRolePolicy(role) {
  try {
    rolePolicies.set(role, resolveAgentWatchdogPolicy(role));
  } catch {
    rolePolicies.delete(role);
    return;
  }
  for (const listener of [...rolePolicyListeners]) {
    try {
      listener(role);
    } catch {
      /* observers never affect the policy */
    }
  }
}

function rolePolicy(role, memoryOnly) {
  if (!memoryOnly) return resolveAgentWatchdogPolicy(role);
  if (!rolePolicies.has(role)) {
    rolePolicies.set(role, null);
    setImmediate(() => resolveRolePolicy(role));
  }
  return rolePolicies.get(role);
}

/** `listener(role)` runs when a role's policy was resolved for status reads
 *  (first, or again by the maintenance pass); returns the unsubscribe. */
export function onRolePolicyResolved(listener) {
  if (typeof listener !== 'function') return () => {};
  rolePolicyListeners.add(listener);
  return () => rolePolicyListeners.delete(listener);
}

/** Re-resolve every held role policy (off the status pulse). */
export function refreshRolePolicies() {
  for (const role of [...rolePolicies.keys()]) resolveRolePolicy(role);
}

/** `sessionRecords`: the holder's session-record handle (session-record.mjs),
 *  the status pulse's getSession from memory; without one, getSession. */
export function createSessionProgress({ mgr, sessionRecords = null }) {
  const memorySession = (sessionId) =>
    sessionRecords ? sessionRecords.session(sessionId) : (sessionId && mgr.getSession?.(sessionId)) || null;

  /** `loaded`: the caller's own getSession(sessionId) answer from this same
   *  read, so the session is not loaded a second time. `memoryOnly`: a status
   *  read from memory (role policies held, see rolePolicy). */
  function sessionProgressExtras(
    sessionId,
    role,
    now = Date.now(),
    taskStatus = null,
    { loaded, memoryOnly = false } = {}
  ) {
    if (!sessionId) return {};
    // Only the session's status is read here: the manager's stamp-validated
    // status lookup spares a whole-transcript read per idle worker per pulse.
    let sessionStatus;
    if (loaded !== undefined) sessionStatus = loaded?.status || null;
    else if (typeof mgr.loadSessionStatus === 'function') sessionStatus = mgr.loadSessionStatus(sessionId) || null;
    else sessionStatus = mgr.getSession(sessionId)?.status || null;
    const runtime = mgr.getSessionRuntime?.(sessionId) || null;
    const snapshot =
      typeof mgr.getSessionProgressSnapshot === 'function' ? mgr.getSessionProgressSnapshot(sessionId) : null;
    // The armed watchdog's own policy (agent definition and provider budget
    // applied); the role default only when none is registered.
    const watchdogState = getProgressWatchdogState(mgr, sessionId);
    const policy = watchdogState.policy || (role ? rolePolicy(role, memoryOnly) : null);
    const queuedFollowups =
      typeof mgr.getSessionPendingMessageDepth === 'function' ? mgr.getSessionPendingMessageDepth(sessionId) : null;
    return buildAgentTaskProgressFields({
      now,
      sessionStatus,
      runtimeStage: runtime?.stage || snapshot?.stage || sessionStatus,
      snapshot,
      runtime,
      policy,
      watchdogState,
      queuedFollowups,
      taskStatus,
      lastToolCall: runtime?.lastToolCall || null,
      toolSilence: runtime?.taskWaits > 0 ? waitedJobSilence(runtime.taskWaitJobIds, { now }) : null,
    });
  }

  /** `memoryOnly` (the status pulse): the session is memorySession's, the
   *  same answer without a file check per read. */
  function jobWorkerSnapshot(sessionId, { memoryOnly = false } = {}) {
    if (!sessionId) return null;
    const session = memoryOnly ? memorySession(sessionId) : mgr.getSession(sessionId);
    if (!session) return null;
    const runtime = mgr.getSessionRuntime?.(sessionId);
    const status = session.closed === true ? 'closed' : session.status || 'idle';
    const progress = sessionProgressExtras(
      sessionId,
      session.agent || null,
      Date.now(),
      null,
      memoryOnly ? { loaded: session, memoryOnly } : {}
    );
    return {
      workerStatus: status,
      stage: progress.worker_stage || runtime?.stage || status,
      // Additive: present only while the worker's turn waits on a user approval.
      ...(runtime?.awaitingUser ? { awaitingUser: runtime.awaitingUser } : {}),
      // Additive: present only while the worker's turn sits in `task wait`.
      ...(runtime?.taskWaits > 0 ? { awaitingTask: 'wait' } : {}),
      clientHostPid: session.clientHostPid || null,
      lastStreamDeltaAt: runtime?.lastStreamDeltaAt ? new Date(runtime.lastStreamDeltaAt).toISOString() : null,
      ...progress,
    };
  }

  return { sessionProgressExtras, jobWorkerSnapshot, memorySession };
}
