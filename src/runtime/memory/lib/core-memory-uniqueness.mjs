import { __mixdogMemoryLog } from './memory-log.mjs'

// Legacy conflicting keys remain visible and editable. Never choose a winner
// or delete user-curated content just to install a constraint during startup.
export async function ensureCoreKeyIndex(db) {
  const conflicts = await db.query(`
    SELECT project_id, element, COUNT(*) AS count
    FROM core_entries GROUP BY project_id, element HAVING COUNT(*) > 1
    LIMIT 1
  `)
  if (conflicts.rows.length) {
    __mixdogMemoryLog('[core-memory] duplicate keys preserved; resolve them with explicit edits/deletes before installing the unique index\n')
    return false
  }
  try {
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS core_entries_unique_proj_elem ON core_entries (project_id, element) NULLS NOT DISTINCT`)
    return true
  } catch (error) {
    if (error.code !== '23505') throw error
    __mixdogMemoryLog('[core-memory] concurrent key conflict preserved; unique index deferred until explicit resolution\n')
    return false
  }
}

// Called under the store's per-pool advisory lock. This also protects writes
// while a legacy database still has conflicts and cannot install the index.
export async function findCoreKeyRows(db, projectId, element, exceptId = null) {
  const result = await db.query(`
    SELECT id, status FROM core_entries
    WHERE project_id IS NOT DISTINCT FROM $1 AND element = $2
      AND ($3::bigint IS NULL OR id <> $3)
    ORDER BY id LIMIT 2 FOR UPDATE
  `, [projectId, element, exceptId])
  return result.rows
}
