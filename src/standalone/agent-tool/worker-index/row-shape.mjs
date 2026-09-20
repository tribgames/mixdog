// worker-index/row-shape.mjs
// The one row shape of the worker index: coercing whatever a stored file or a
// caller hands in, and projecting a live session into a row.
import { agentTagOf, clean, positiveInt } from '../helpers.mjs';
import { isLeadPoolAgent } from '../worker-rows.mjs';

/** An explicit boolean wins; otherwise the session's own fast flag (true) or unknown. */
function fastFlag(explicit, sessionFast) {
  if (typeof explicit === 'boolean') return explicit;
  return sessionFast === true ? true : null;
}

// Reaping is an explicit lifecycle mutation owned by tag-registry. Silently
// filtering an expired row here would skip its tombstone and make persisted
// state disagree with the reusable-tag lease.
export function keepWorkerRow(row = {}) {
  return Boolean(clean(row.tag) && clean(row.sessionId));
}

/** Rows of a stored index (v2 keyed object, v1 array, or a bare array) in one
 *  shape. Lead pool rows are status projections, not agent-tool children, and
 *  are dropped here so no reader or tag map ever sees them. */
export function normalizeWorkerRows(value) {
  let source = [];
  if (Array.isArray(value?.workers)) source = value.workers;
  else if (value?.workers && typeof value.workers === 'object') source = Object.values(value.workers);
  else if (Array.isArray(value)) source = value;
  return source
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      tag: clean(row.tag),
      sessionId: clean(row.sessionId),
      parentSessionId: clean(row.parentSessionId) || null,
      ownerSessionId: clean(row.ownerSessionId || row.parentSessionId) || null,
      agent: clean(row.agent) || null,
      provider: clean(row.provider) || null,
      model: clean(row.model) || null,
      preset: clean(row.preset) || null,
      effort: clean(row.effort) || null,
      fast: typeof row.fast === 'boolean' ? row.fast : null,
      status: clean(row.status) || 'idle',
      stage: clean(row.stage) || clean(row.status) || 'idle',
      createdAt: clean(row.createdAt) || null,
      updatedAt: clean(row.updatedAt) || null,
      lastUsedAt: clean(row.lastUsedAt) || null,
      finishedAt: clean(row.finishedAt) || null,
      turnStartedAt: clean(row.turnStartedAt) || null,
      reapAt: clean(row.reapAt) || null,
      clientHostPid: positiveInt(row.clientHostPid),
      runtimePid: positiveInt(row.runtimePid),
      cwd: clean(row.cwd) || null,
      task_id: clean(row.task_id || row.taskId) || null,
      error: clean(row.error) || null,
      permission: clean(row.permission) || null,
      toolPermission: clean(row.toolPermission) || null,
      messages: positiveInt(row.messages) || 0,
      tools: positiveInt(row.tools) || 0,
    }))
    .filter((row) => !isLeadPoolAgent(row.agent) && keepWorkerRow(row));
}

/** The row a live session contributes, or null without a tag + session id.
 *  `extra` overrides the session's own fields (status/stage from a dispatch,
 *  terminal stamps from settlement). */
export function workerRowFromSession(session, fallbackTag = '', extra = {}, getSessionRuntime = () => null) {
  const tag = agentTagOf(session) || clean(fallbackTag) || clean(extra.tag);
  const sessionId = clean(session?.id || extra.sessionId);
  if (!tag || !sessionId) return null;
  const runtime = getSessionRuntime(sessionId);
  const status = clean(extra.status) || (session?.closed === true ? 'closed' : clean(session?.status) || 'idle');
  const stage = clean(extra.stage) || clean(runtime?.stage) || status;
  const nowIso = new Date().toISOString();
  return {
    tag,
    sessionId,
    parentSessionId: clean(extra.parentSessionId) || clean(session?.parentSessionId) || null,
    ownerSessionId:
      clean(extra.ownerSessionId || extra.parentSessionId) ||
      clean(session?.ownerSessionId || session?.parentSessionId) ||
      null,
    agent: clean(extra.agent) || clean(session?.agent) || null,
    provider: clean(extra.provider) || clean(session?.provider) || null,
    model: clean(extra.model) || clean(session?.model) || null,
    preset: clean(extra.preset) || clean(session?.presetName) || null,
    effort: clean(extra.effort) || clean(session?.effort) || null,
    fast: fastFlag(extra.fast, session?.fast),
    status,
    stage,
    createdAt: clean(session?.createdAt) || clean(extra.createdAt) || nowIso,
    updatedAt: clean(extra.updatedAt) || nowIso,
    lastUsedAt: clean(session?.lastUsedAt) || null,
    finishedAt: clean(extra.finishedAt) || null,
    // Turn dispatch stamps this; terminal upserts leave it null and the
    // merge in applyWorkerRowUpsert preserves the running turn's value.
    turnStartedAt: clean(extra.turnStartedAt) || null,
    // Active/new work clears the previous lease. Terminal settlement writes
    // the new absolute deadline immediately afterwards via scheduleReap().
    reapAt: clean(extra.reapAt) || null,
    clientHostPid: positiveInt(extra.clientHostPid) || positiveInt(session?.clientHostPid),
    runtimePid: positiveInt(extra.runtimePid) || process.pid,
    cwd: clean(session?.cwd) || clean(extra.cwd) || null,
    task_id: clean(extra.task_id || extra.taskId) || null,
    error: clean(extra.error) || null,
    permission: clean(session?.permission) || null,
    toolPermission: clean(session?.toolPermission) || null,
    messages: Array.isArray(session?.messages) ? session.messages.length : 0,
    tools: Array.isArray(session?.tools) ? session.tools.length : 0,
  };
}
