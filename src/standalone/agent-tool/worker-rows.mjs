import { clean, positiveInt } from './helpers.mjs';

export const TAG_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TAG_TOMBSTONES = 500;

export function workerRowKey(row = {}) {
  return clean(row.sessionId) || clean(row.tag);
}

export function workerRowTime(row = {}) {
  return Date.parse(row.updatedAt || row.finishedAt || row.lastUsedAt || row.createdAt || '') || 0;
}

export function isTerminalWorkerStatus(status) {
  return /^(idle|closed|completed|failed|error|cancelled|canceled|killed|timeout)$/i.test(clean(status));
}

export function tagTombstoneKey(row = {}) {
  return `${positiveInt(row.clientHostPid) || 0}\0${clean(row.tag)}`;
}

export function normalizeTagTombstones(value, { cap = true, priorityKeys = null } = {}) {
  const source = Array.isArray(value?.tombstones)
    ? value.tombstones
    : (value?.tombstones && typeof value.tombstones === 'object'
      ? Object.values(value.tombstones)
      : []);
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
        // A future clock must not outrank tombstones created by this process.
        reapedAt: parsedReapedAt ? new Date(Math.min(parsedReapedAt, now)).toISOString() : null,
      };
    })
    .filter((row) => row.tag && row.reapedAt && (Date.parse(row.reapedAt) || 0) >= cutoff)
    .sort((a, b) => {
      const aPriority = priorityKeys?.has(tagTombstoneKey(a)) ? 1 : 0;
      const bPriority = priorityKeys?.has(tagTombstoneKey(b)) ? 1 : 0;
      return bPriority - aPriority
        || (Date.parse(b.reapedAt) || 0) - (Date.parse(a.reapedAt) || 0);
    });
  return cap ? rows.slice(0, MAX_TAG_TOMBSTONES) : rows;
}

export function applyWorkerRowUpsert(byKey, normalized) {
  if (!normalized) return;
  const key = workerRowKey(normalized);
  if (!key) return;
  const prev = byKey.get(key) || {};
  const merged = { ...prev, ...normalized };
  for (const field of ['agent', 'provider', 'model', 'preset', 'effort', 'fast', 'clientHostPid', 'cwd', 'task_id', 'permission', 'toolPermission']) {
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
    clientHostPid: row.clientHostPid || null,
    cwd: row.cwd || null,
    permission: row.permission || null,
    toolPermission: row.toolPermission || null,
    messageCount: Math.max(0, Number(row.messages || 0)),
    toolCount: Math.max(0, Number(row.tools || 0)),
  };
}
