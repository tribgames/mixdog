// job-views/agent-list.mjs
// The /agents list projection: one row per tagged agent session with its live
// progress, filtered by default to workers that can still do work.
import { ACTIVE_STAGES } from '../tool-def.mjs';
import { isTerminalWorkerStatus } from '../worker-rows.mjs';
import { sessionUsageTotals } from '../../../../runtime/shared/session-usage-totals.mjs';

const CANCELLED_WORKER_STATUS = /^(?:cancelled|canceled|killed|cancel[-_\s]?(?:unconfirmed|pending))$/;

// Idle, closed, errored and reaped/unknown rows are history and stay reachable
// through the task section (status/read keep their terminal result).
export function isActiveWorkerRow(row = {}) {
  const stage = String(row.stage ?? '')
    .trim()
    .toLowerCase();
  const status = String(row.status ?? '')
    .trim()
    .toLowerCase();
  // `status` decides; the stage is the runtime phase and only stands in for a
  // row with no status. A cancel in either field is not work.
  if (CANCELLED_WORKER_STATUS.test(stage) || CANCELLED_WORKER_STATUS.test(status)) return false;
  const effective = status || stage;
  if (ACTIVE_STAGES.has(effective)) return true;
  if (!effective || effective === 'unknown') return false;
  return !isTerminalWorkerStatus(effective);
}

function agentRow({ tag, session, runtime, progress, now, indexRow = null }) {
  const status = session.closed === true ? 'closed' : session.status || 'idle';
  const stage =
    session.stage ||
    (status === 'idle' || status === 'error' || status === 'closed' ? status : runtime?.stage || status);
  // Additive: the current turn's start (worker index, stamped at dispatch) so
  // surfaces time a continued worker from its turn, not from createdAt.
  const turnStartedAt = indexRow?.turnStartedAt || session.turnStartedAt || null;
  const row = {
    tag,
    sessionId: session.id,
    agent: session.agent || null,
    provider: session.provider,
    model: session.model,
    preset: session.presetName || null,
    effort: session.effort || null,
    fast: session.fast === true,
    ...(session.autoEffort === false ? { autoEffort: false } : {}),
    // Additive: route model parameters (e.g. Daybreak Blue) when the route has any.
    ...(session.modelParameters && Object.keys(session.modelParameters).length
      ? { modelParameters: { ...session.modelParameters } }
      : {}),
    status,
    stage,
    // Additive: present only while the worker's turn waits on a user approval.
    ...(runtime?.awaitingUser ? { awaitingUser: runtime.awaitingUser } : {}),
    ...progress,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
    lastUsedAt: session.lastUsedAt || null,
    clientHostPid: session.clientHostPid || null,
    lastStreamDeltaAt: runtime?.lastStreamDeltaAt ? new Date(runtime.lastStreamDeltaAt).toISOString() : null,
    staleSeconds: runtime?.lastStreamDeltaAt ? Math.floor((now - runtime.lastStreamDeltaAt) / 1000) : null,
    ...sessionUsageTotals(session),
    windowTokens: Number(session.lastContextTokens ?? session.lastInputTokens) || 0,
    windowCap: Number(session.contextWindow) || null,
    permission: session.permission || null,
    toolPermission: session.toolPermission || null,
    messages: Array.isArray(session.messages)
      ? session.messages.length
      : Math.max(0, Number(session.messageCount || 0)),
    tools: Array.isArray(session.tools) ? session.tools.length : Math.max(0, Number(session.toolCount || 0)),
  };
  if (turnStartedAt && isActiveWorkerRow(row)) row.turnStartedAt = turnStartedAt;
  return row;
}

export function createAgentList({ mgr, refreshTagsFromSessions, agentSessionEntries, progress }) {
  return function list({ scanSessions = false, context = {}, includeTerminal = false } = {}) {
    refreshTagsFromSessions({ scanSessions, context });
    const now = Date.now();
    const rows = agentSessionEntries({ scanSessions, context }).map(({ tag, session, indexRow, loaded }) =>
      agentRow({
        tag,
        session,
        indexRow,
        runtime: mgr.getSessionRuntime?.(session.id),
        // A tag-bound entry is the getSession answer itself; an index row or
        // a scanned summary is only a projection and still reads the session.
        progress: progress.sessionProgressExtras(
          session.id,
          session.agent || null,
          now,
          null,
          loaded ? { loaded: session } : {}
        ),
        now,
      })
    );
    return includeTerminal ? rows : rows.filter((row) => isActiveWorkerRow(row));
  };
}
