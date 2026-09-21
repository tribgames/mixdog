import { agentTagOf, clean, positiveInt, stampMs } from './helpers.mjs';

import { TAG_TOMBSTONE_TTL_MS, tagTombstoneKey } from '../../runtime/shared/agent-reap-state.mjs';
export { TAG_TOMBSTONE_TTL_MS, tagTombstoneKey };
const MAX_TAG_TOMBSTONES = 500;

export function workerRowKey(row = {}) {
  return clean(row.sessionId) || clean(row.tag);
}

export function leadPoolTag(sessionId) {
  const id = clean(sessionId);
  return id ? `lead:${id}` : '';
}

export function isLeadPoolAgent(value) {
  return clean(value).toLowerCase() === 'lead';
}

export function workerRowTime(row = {}) {
  return Date.parse(row.updatedAt || row.finishedAt || row.lastUsedAt || row.createdAt || '') || 0;
}

export function isTerminalWorkerStatus(status) {
  return /^(idle|closed|complete|completed|done|success|fail|failed|error|cancelled|canceled|killed|timeout)$/i.test(
    clean(status)
  );
}

export function recoverTagTombstoneOwner(row, sessions) {
  if (clean(row.parentSessionId || row.ownerSessionId)) return row;
  const pid = positiveInt(row.clientHostPid);
  const reapedAt = stampMs(row.reapedAt);
  if (!pid || !reapedAt) return row;
  const candidates = sessions.filter((session) => {
    const createdAt = stampMs(session.createdAt);
    return (
      clean(session.id) &&
      (!row.sessionId || clean(row.sessionId) === clean(session.id)) &&
      agentTagOf(session) === clean(row.tag) &&
      positiveInt(session.clientHostPid) === pid &&
      clean(session.parentSessionId || session.ownerSessionId) &&
      createdAt > 0 &&
      createdAt <= reapedAt
    );
  });
  if (candidates.length !== 1) return row;
  const session = candidates[0];
  return {
    ...row,
    sessionId: clean(session.id),
    parentSessionId: clean(session.parentSessionId || session.ownerSessionId),
    ownerSessionId: clean(session.ownerSessionId || session.parentSessionId),
  };
}

export function normalizeTagTombstones(value, { cap = true, priorityKeys = null } = {}) {
  let source = [];
  if (Array.isArray(value?.tombstones)) source = value.tombstones;
  else if (value?.tombstones && typeof value.tombstones === 'object') source = Object.values(value.tombstones);
  const now = Date.now();
  const cutoff = now - TAG_TOMBSTONE_TTL_MS;
  const rows = source
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      const parsedReapedAt = Date.parse(clean(row.reapedAt)) || 0;
      return {
        tag: clean(row.tag),
        agent: clean(row.agent) || null,
        cwd: clean(row.cwd) || null,
        clientHostPid: positiveInt(row.clientHostPid),
        ...(clean(row.sessionId) ? { sessionId: clean(row.sessionId) } : {}),
        ...(clean(row.parentSessionId) ? { parentSessionId: clean(row.parentSessionId) } : {}),
        ...(clean(row.ownerSessionId) ? { ownerSessionId: clean(row.ownerSessionId) } : {}),
        // A future clock must not outrank tombstones created by this process.
        reapedAt: parsedReapedAt ? new Date(Math.min(parsedReapedAt, now)).toISOString() : null,
      };
    })
    .filter((row) => row.tag && row.reapedAt && (Date.parse(row.reapedAt) || 0) >= cutoff)
    .sort((a, b) => {
      const aPriority = priorityKeys?.has(tagTombstoneKey(a)) ? 1 : 0;
      const bPriority = priorityKeys?.has(tagTombstoneKey(b)) ? 1 : 0;
      return bPriority - aPriority || (Date.parse(b.reapedAt) || 0) - (Date.parse(a.reapedAt) || 0);
    });
  return cap ? rows.slice(0, MAX_TAG_TOMBSTONES) : rows;
}

export function applyWorkerRowUpsert(byKey, normalized) {
  if (!normalized) return;
  const key = workerRowKey(normalized);
  if (!key) return;
  const prev = byKey.get(key) || {};
  const merged = { ...prev, ...normalized };
  for (const field of [
    'parentSessionId',
    'ownerSessionId',
    'agent',
    'provider',
    'model',
    'preset',
    'effort',
    'fast',
    'clientHostPid',
    'runtimePid',
    'cwd',
    'task_id',
    'permission',
    'toolPermission',
    'turnStartedAt',
  ]) {
    if ((merged[field] === null || merged[field] === '') && prev[field] != null && prev[field] !== '') {
      merged[field] = prev[field];
    }
  }
  byKey.set(key, {
    ...merged,
    createdAt: normalized.createdAt || prev.createdAt || new Date().toISOString(),
    updatedAt: normalized.updatedAt || new Date().toISOString(),
  });
}

export function workerRowToSession(row = {}) {
  return {
    id: row.sessionId,
    parentSessionId: row.parentSessionId || row.ownerSessionId || null,
    ownerSessionId: row.ownerSessionId || null,
    agentTag: row.tag,
    agent: row.agent || null,
    provider: row.provider || null,
    model: row.model || null,
    presetName: row.preset || null,
    effort: row.effort || null,
    fast: row.fast === true,
    status: row.status || 'idle',
    stage: row.stage || row.status || 'idle',
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    lastUsedAt: row.lastUsedAt || null,
    reapAt: row.reapAt || null,
    clientHostPid: row.clientHostPid || null,
    cwd: row.cwd || null,
    permission: row.permission || null,
    toolPermission: row.toolPermission || null,
    messageCount: Math.max(0, Number(row.messages || 0)),
    toolCount: Math.max(0, Number(row.tools || 0)),
  };
}
