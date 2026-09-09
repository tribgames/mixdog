import { randomUUID } from 'node:crypto'

const PREFIX = 'memory.core.index.'
const scopeKey = scope => JSON.stringify(scope ?? null)

// Stable database keys remain internal. This persisted directory is the
// public, per-scope address space, including its stale-request fence.
export async function syncCoreMemoryIndexes(db) {
  return db.transaction(async tx => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [PREFIX])
    const records = (await tx.query(`
      SELECT id, project_id FROM core_entries
      WHERE status IS NULL OR status = 'active' ORDER BY id ASC
    `)).rows
    const saved = (await tx.query(`SELECT key, value FROM meta WHERE key LIKE $1`, [`${PREFIX}%`])).rows
    const previous = new Map(saved.map(row => {
      const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
      return [row.key.slice(PREFIX.length), value]
    }))
    const groups = new Map()
    for (const row of records) {
      if (!Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0) throw new Error('invalid internal memory key')
      const key = scopeKey(row.project_id)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(Number(row.id))
    }
    const result = new Map()
    for (const key of [...new Set([...groups.keys(), ...previous.keys()])].sort()) {
      const current = groups.get(key) || []
      const old = previous.get(key)
      const oldIds = Array.isArray(old?.recordIds) ? old.recordIds.map(Number) : []
      const live = new Set(current)
      const retained = [...new Set(oldIds.filter(id => live.has(id)))]
      const known = new Set(retained)
      const recordIds = [...retained, ...current.filter(id => !known.has(id))]
      const changed = !old?.revision || JSON.stringify(oldIds) !== JSON.stringify(recordIds)
      const state = { revision: changed ? randomUUID() : old.revision, recordIds }
      if (changed) {
        await tx.query(`
          INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
          ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
        `, [PREFIX + key, JSON.stringify(state)])
      }
      result.set(key, state)
    }
    return result
  })
}

export function indexedCoreRecord(row, directory) {
  const state = directory.get(scopeKey(row.project_id ?? row.projectId))
  const index = state?.recordIds.indexOf(Number(row.id)) ?? -1
  return {
    ...row,
    record_id: Number(row.id),
    id: index >= 0 ? index + 1 : null,
    index_revision: index >= 0 ? state.revision : null,
  }
}

export async function resolveCoreMemoryIndex(db, scope, index, revision) {
  if (scope === '*') throw new Error('memory writes require one explicit project scope')
  if (!Number.isSafeInteger(Number(index)) || Number(index) <= 0) throw new Error('memory index must be a positive integer')
  if (typeof revision !== 'string' || !revision) throw new Error('index_revision required; list memories before editing or deleting')
  const directory = await syncCoreMemoryIndexes(db)
  const state = directory.get(scopeKey(scope))
  if (!state || state.revision !== revision) throw new Error('memory indices changed; list memories again before editing or deleting')
  const recordId = state.recordIds[Number(index) - 1]
  if (!recordId) throw new Error(`no memory index=${index} in project=${scope ?? 'common'}`)
  return recordId
}

export async function publicCoreMemoryIdentity(db, row) {
  const indexed = indexedCoreRecord(row, await syncCoreMemoryIndexes(db))
  if (!indexed.id) throw new Error('memory changed before its index could be returned; list memories again')
  return `project=${row.project_id ?? 'COMMON'} id=${indexed.id} index_revision=${indexed.index_revision}`
}
