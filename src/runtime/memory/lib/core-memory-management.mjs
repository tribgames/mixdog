// Standing memory is exclusively user-curated. Generated history is accessed
// through recall, not through a second instruction-management namespace.
import { indexedCoreRecord, syncCoreMemoryIndexes } from './core-memory-index.mjs'

export async function listManagedMemories(db, scope, options = {}) {
  const includeInactive = options.include_inactive ?? false
  if (typeof includeInactive !== 'boolean') throw new Error('include_inactive must be a boolean')
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(options.limit) || 50)))
  const offset = Math.max(0, Math.trunc(Number(options.offset) || 0))
  const directory = await syncCoreMemoryIndexes(db)
  // Order before pagination by the persisted scoped address, not the hidden
  // database key: moving an old record into a scope appends it there.
  const indexCases = [...directory.values()].flatMap(state =>
    state.recordIds.map((id, index) => `WHEN ${Number(id)} THEN ${index + 1}`))
  const publicOrder = indexCases.length ? `CASE id ${indexCases.join(' ')} ELSE id END` : 'id'
  const result = await db.query(`
    SELECT * FROM (
      SELECT 'curated'::text AS source, c.id, c.project_id, c.element, c.summary,
             COALESCE(c.status, 'active')::text AS status,
             (c.status IS NULL OR c.status = 'active') AS injection_enabled
      FROM core_entries c
    ) memories
    WHERE ($1::text = '*' OR project_id = $1 OR (project_id IS NULL AND (NOT $5::boolean OR $1::text IS NULL)))
      AND ($4::boolean OR injection_enabled)
    ORDER BY project_id NULLS FIRST, ${publicOrder} ASC, id ASC
    LIMIT $2 OFFSET $3
  `, [scope, limit + 1, offset, includeInactive, options.scope_only === true])
  const hasMore = result.rows.length > limit
  const entries = result.rows.slice(0, limit).map(row => indexedCoreRecord(row, directory))
  if (entries.some(row => row.injection_enabled && !row.id)) {
    throw new Error('memory indices changed during listing; list memories again')
  }
  return { entries, nextOffset: hasMore ? offset + limit : null }
}

export function formatManagedMemories(page) {
  const lines = page.entries.map(row => {
    const id = row.id ? `id=${row.id}` : `archived_id=${row.record_id}`
    const version = row.index_revision ? ` index_revision=${row.index_revision}` : ''
    return `${id} source=curated project=${row.project_id ?? 'COMMON'} status=${row.status} injection=${row.injection_enabled ? 'enabled' : 'disabled'}${version} ${row.element ?? ''} — ${row.summary ?? ''}`
  })
  if (page.nextOffset !== null) lines.push(`More memories: call list with offset=${page.nextOffset} and the same project scope/include_inactive.`)
  return lines.join('\n') || 'memory: empty'
}

