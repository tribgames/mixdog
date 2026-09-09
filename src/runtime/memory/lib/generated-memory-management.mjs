// Management metadata is separate from recall records. Cycle2 can update a
// summary or status without clearing an explicit injection exclusion.
export const GENERATED_POLICY_PREFIX = 'memory.generated.policy.'
import { indexedCoreRecord, syncCoreMemoryIndexes } from './core-memory-index.mjs'

function validateId(id) {
  const value = Number(id)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('integer id > 0 required')
  return value
}

export async function listManagedMemories(db, scope, options = {}) {
  const source = options.source ?? 'all'
  if (!['all', 'curated', 'generated'].includes(source)) throw new Error('source must be all, curated, or generated')
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
             (c.status IS NULL OR c.status = 'active') AS injection_enabled,
             false AS excluded, NULL::text AS reason
      FROM core_entries c
      UNION ALL
      SELECT 'generated', e.id, e.project_id, e.element, e.core_summary,
             e.status::text, false,
             COALESCE((p.value->>'excluded')::boolean, false),
             p.value->>'reason'
      FROM entries e
      LEFT JOIN meta p ON p.key = $5 || e.id::text
      WHERE e.is_root = 1 AND e.core_summary IS NOT NULL
    ) memories
    WHERE ($1::text = '*' OR project_id = $1 OR (project_id IS NULL AND (NOT $7::boolean OR $1::text IS NULL)))
      AND ($2::text = 'all' OR source = $2)
      AND ($6::boolean OR injection_enabled)
    ORDER BY source ASC, project_id NULLS FIRST,
      CASE WHEN source = 'curated' THEN ${publicOrder} ELSE id END ASC, id ASC
    LIMIT $3 OFFSET $4
  `, [scope, source, limit + 1, offset, GENERATED_POLICY_PREFIX, includeInactive, options.scope_only === true])
  const hasMore = result.rows.length > limit
  const entries = result.rows.slice(0, limit).map(row => row.source === 'curated' ? indexedCoreRecord(row, directory) : row)
  if (entries.some(row => row.source === 'curated' && row.injection_enabled && !row.id)) {
    throw new Error('memory indices changed during listing; list memories again')
  }
  return { entries, nextOffset: hasMore ? offset + limit : null }
}

export function formatManagedMemories(page) {
  const lines = page.entries.map(row => {
    const id = row.source === 'generated' ? `generated_id=${row.id}` : row.id ? `id=${row.id}` : `archived_id=${row.record_id}`
    const version = row.index_revision ? ` index_revision=${row.index_revision}` : ''
    return `${id} source=${row.source} project=${row.project_id ?? 'COMMON'} status=${row.status} injection=${row.injection_enabled ? 'enabled' : 'disabled'} excluded=${Boolean(row.excluded)}${version} ${row.element ?? ''} — ${row.summary ?? ''}${row.reason ? ` (reason: ${row.reason})` : ''}`
  })
  if (page.nextOffset !== null) lines.push(`More memories: call list with offset=${page.nextOffset} and the same source/project scope/include_inactive.`)
  return lines.join('\n') || 'memory: empty'
}

export async function excludeGeneratedMemory(db, id, scope, reason = 'user-request', options = {}) {
  const entryId = validateId(id)
  if (scope === '*') throw new Error('exclude requires an explicit project scope, not "*"')
  return await db.transaction(async tx => {
    const result = await tx.query(`
      SELECT id, project_id, core_summary, core_candidate_status FROM entries
      WHERE id = $1 AND is_root = 1 AND core_summary IS NOT NULL
        AND (project_id IS NULL OR project_id = $2)
      FOR UPDATE
    `, [entryId, scope])
    const row = result.rows[0]
    if (!row) throw new Error(`no generated memory id=${entryId} in the resolved scope`)
    if (row.core_candidate_status === 'promoting') {
      throw new Error(`generated memory id=${entryId} is being promoted; retry after that operation finishes`)
    }
    if (options.expectedSummary !== undefined && row.core_summary !== options.expectedSummary) {
      return { id: entryId, applied: false, reason: 'summary changed during review' }
    }
    await tx.query(`
      INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value = COALESCE(meta.value, '{}'::jsonb) || EXCLUDED.value
    `, [GENERATED_POLICY_PREFIX + entryId, JSON.stringify({
      excluded: true, reason: String(reason).slice(0, 1000), reviewedAt: options.now ?? Date.now(),
    })])
    // Prevent the candidate path from silently re-installing an excluded
    // generated summary as a new curated instruction.
    await tx.query(`
      UPDATE entries SET core_candidate_status = 'dismissed', core_candidate_at = $2
      WHERE id = $1 AND (core_candidate_status IS NULL OR core_candidate_status = 'candidate')
    `, [entryId, options.now ?? Date.now()])
    return { id: entryId, applied: true, injection_enabled: false }
  })
}
