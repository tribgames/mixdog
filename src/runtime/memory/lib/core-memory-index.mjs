import { randomUUID } from 'node:crypto';
import { corePoolLabel } from './core-memory-access.mjs';

const PREFIX = 'memory.core.index.';
// A project scope keys as before (`null` for common, `"slug"`); an agent's own
// pool as `{"agent":"id"}`.
const scopeKey = (scope, agentId = null) =>
  agentId ? JSON.stringify({ agent: agentId }) : JSON.stringify(scope ?? null);

// Stable database keys remain internal. This persisted directory is the
// public, per-scope address space, including its stale-request fence.
export async function syncCoreMemoryIndexes(db) {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [PREFIX]);
    const records = (
      await tx.query(`
      SELECT id, project_id, agent_id FROM core_entries
      WHERE status IS NULL OR status = 'active' ORDER BY id ASC
    `)
    ).rows;
    const saved = (await tx.query(`SELECT key, value FROM meta WHERE key LIKE $1`, [`${PREFIX}%`])).rows;
    const previous = new Map(
      saved.map((row) => {
        const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        return [row.key.slice(PREFIX.length), value];
      })
    );
    const groups = new Map();
    for (const row of records) {
      if (!Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0) throw new Error('invalid internal memory key');
      const key = scopeKey(row.project_id, row.agent_id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(Number(row.id));
    }
    const result = new Map();
    for (const key of [...new Set([...groups.keys(), ...previous.keys()])].sort()) {
      const current = groups.get(key) || [];
      const old = previous.get(key);
      const oldIds = Array.isArray(old?.recordIds) ? old.recordIds.map(Number) : [];
      const live = new Set(current);
      const retained = [...new Set(oldIds.filter((id) => live.has(id)))];
      const known = new Set(retained);
      const recordIds = [...retained, ...current.filter((id) => !known.has(id))];
      const changed = !old?.revision || JSON.stringify(oldIds) !== JSON.stringify(recordIds);
      const state = { revision: changed ? randomUUID() : old.revision, recordIds };
      if (changed) {
        await tx.query(
          `
          INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
          ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
        `,
          [PREFIX + key, JSON.stringify(state)]
        );
      }
      result.set(key, state);
    }
    return result;
  });
}

export function indexedCoreRecord(row, directory) {
  const state = directory.get(scopeKey(row.project_id ?? row.projectId, row.agent_id ?? row.agentId));
  const index = state?.recordIds.indexOf(Number(row.id)) ?? -1;
  return {
    ...row,
    record_id: Number(row.id),
    id: index >= 0 ? index + 1 : null,
    index_revision: index >= 0 ? state.revision : null,
  };
}

/** `agentId` addresses that agent's own pool instead of the project `scope`. */
export async function resolveCoreMemoryIndex(db, scope, index, revision, agentId = null) {
  if (scope === '*' && !agentId) throw new Error('memory writes require one explicit project scope');
  if (!Number.isSafeInteger(Number(index)) || Number(index) <= 0)
    throw new Error('memory index must be a positive integer');
  if (typeof revision !== 'string' || !revision)
    throw new Error('index_revision required; list memories before editing or deleting');
  const directory = await syncCoreMemoryIndexes(db);
  const state = directory.get(scopeKey(scope, agentId));
  if (!state || state.revision !== revision)
    throw new Error('memory indices changed; list memories again before editing or deleting');
  const recordId = state.recordIds[Number(index) - 1];
  if (!recordId) throw new Error(`no memory index=${index} in ${corePoolLabel({ projectId: scope, agentId })}`);
  return recordId;
}

export async function publicCoreMemoryIdentity(db, row) {
  const indexed = indexedCoreRecord(row, await syncCoreMemoryIndexes(db));
  if (!indexed.id) throw new Error('memory changed before its index could be returned; list memories again');
  const pool = corePoolLabel({ projectId: row.project_id, agentId: row.agent_id });
  return `${pool} id=${indexed.id} index_revision=${indexed.index_revision}`;
}
