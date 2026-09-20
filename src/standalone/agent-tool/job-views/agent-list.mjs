// job-views/agent-list.mjs
// The /agents list projection: one row per tagged agent session with its live
// progress, filtered by default to workers that can still do work.
import { ACTIVE_STAGES } from '../tool-def.mjs';
import { isTerminalWorkerStatus } from '../worker-rows.mjs';

// Idle, closed, errored and reaped/unknown rows are history and stay reachable
// through the task section (status/read keep their terminal result).
export function isActiveWorkerRow(row = {}) {
  const stage = String(row.stage ?? '')
    .trim()
    .toLowerCase();
  const status = String(row.status ?? '')
    .trim()
    .toLowerCase();
  if (ACTIVE_STAGES.has(stage) || ACTIVE_STAGES.has(status)) return true;
  const effective = stage || status;
  if (!effective || effective === 'unknown') return false;
  return !isTerminalWorkerStatus(effective);
}

function agentRow({ tag, session, runtime, progress, now }) {
  const status = session.closed === true ? 'closed' : session.status || 'idle';
  const stage =
    session.stage ||
    (status === 'idle' || status === 'error' || status === 'closed' ? status : runtime?.stage || status);
  return {
    tag,
    sessionId: session.id,
    agent: session.agent || null,
    provider: session.provider,
    model: session.model,
    preset: session.presetName || null,
    effort: session.effort || null,
    fast: session.fast === true,
    status,
    stage,
    ...progress,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
    lastUsedAt: session.lastUsedAt || null,
    clientHostPid: session.clientHostPid || null,
    lastStreamDeltaAt: runtime?.lastStreamDeltaAt ? new Date(runtime.lastStreamDeltaAt).toISOString() : null,
    staleSeconds: runtime?.lastStreamDeltaAt ? Math.floor((now - runtime.lastStreamDeltaAt) / 1000) : null,
    windowTokens: Number(session.lastContextTokens ?? session.lastInputTokens) || 0,
    windowCap: Number(session.contextWindow) || null,
    permission: session.permission || null,
    toolPermission: session.toolPermission || null,
    messages: Array.isArray(session.messages)
      ? session.messages.length
      : Math.max(0, Number(session.messageCount || 0)),
    tools: Array.isArray(session.tools) ? session.tools.length : Math.max(0, Number(session.toolCount || 0)),
  };
}

export function createAgentList({ mgr, refreshTagsFromSessions, agentSessionEntries, progress }) {
  return function list({ scanSessions = false, context = {}, includeTerminal = false } = {}) {
    refreshTagsFromSessions({ scanSessions, context });
    const now = Date.now();
    const rows = agentSessionEntries({ scanSessions, context }).map(({ tag, session }) =>
      agentRow({
        tag,
        session,
        runtime: mgr.getSessionRuntime?.(session.id),
        progress: progress.sessionProgressExtras(session.id, session.agent || null, now),
        now,
      })
    );
    return includeTerminal ? rows : rows.filter((row) => isActiveWorkerRow(row));
  };
}
