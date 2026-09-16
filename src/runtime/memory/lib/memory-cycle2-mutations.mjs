import { markStoreFault } from './memory-cycle2-shared.mjs'

// Review and graph changes commit together. Original content, summaries and
// legacy status values are never deleted or rewritten by maintenance.
export async function applyHistoryReview(db, row, action, prior = null, now = Date.now()) {
  const relations = (Array.isArray(action) ? action : action === 'keep' ? [] : [{ action, prior }])
    .slice().sort((a, b) => Number(a.prior.older_ts) - Number(b.prior.older_ts))
  try {
    return await db.transaction(async tx => {
      const ids = [Number(row.id), ...relations.map(item => Number(item.prior.older_id))]
      const { rows } = await tx.query(`
        SELECT id, ts, element, project_id, summary, cycle2_reviewed_at, duplicate_of
        FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 1
        ORDER BY id FOR UPDATE
      `, [ids])
      const current = rows.find(item => Number(item.id) === Number(row.id))
      if (!current || current.summary !== row.summary || current.project_id !== row.project_id
        || (current.element ?? null) !== (row.element ?? null) || Number(current.ts) !== Number(row.ts)
        || current.cycle2_reviewed_at != null || current.duplicate_of != null) return false
      // Validate every reviewed snapshot before writing any relation. A split
      // review is still one atomic decision for the source row.
      for (const { prior: candidate } of relations) {
        const older = rows.find(item => Number(item.id) === Number(candidate.older_id))
        if (!older || older.summary !== candidate.older_summary || older.project_id !== current.project_id
          || (older.element ?? null) !== (candidate.older_element ?? null)
          || Number(older.ts) !== Number(candidate.older_ts)
          || older.duplicate_of != null) return false
        if (!(Number(older.ts) < Number(current.ts)
          || (Number(older.ts) === Number(current.ts) && Number(older.id) < Number(current.id)))) return false
      }
      for (const { action: relation, prior: candidate } of relations) {
        const older = rows.find(item => Number(item.id) === Number(candidate.older_id))
        // Carry all predecessor concepts forward for both changes and
        // duplicates, retaining the older record as the evidence for the edge.
        const concepts = await tx.query(`
          SELECT concept_id FROM entry_concepts WHERE entry_id = $1
          UNION SELECT id AS concept_id FROM entries WHERE id = $1
          UNION SELECT concept_id FROM entries WHERE id = $1 AND concept_id IS NOT NULL
        `, [older.id])
        const conceptIds = [...new Set(concepts.rows.map(item => Number(item.concept_id)))]
        for (const conceptId of conceptIds) {
          await tx.query(`
            INSERT INTO entry_concepts(entry_id, concept_id, supersedes_id, created_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (entry_id, concept_id) DO UPDATE SET supersedes_id = EXCLUDED.supersedes_id
          `, [current.id, conceptId, older.id, now])
        }
        await tx.query(`
          UPDATE entries SET concept_id = COALESCE(concept_id, $2),
                             supersedes_id = COALESCE(supersedes_id, $3)
          WHERE id = $1
        `, [current.id, conceptIds[0], older.id])
        if (relation === 'merge') {
          // A search alias, not a chunk merge: membership and provenance must
          // remain valid for each session's original Cycle 1 summary.
          // Flatten aliases so filtered searches need no recursive lookup.
          await tx.query(`
            UPDATE entries SET duplicate_of = $1
            WHERE duplicate_of = $2
          `, [current.id, older.id])
          await tx.query(`
            UPDATE entries SET duplicate_of = $1, cycle2_reviewed_at = $3
            WHERE id = $2
          `, [current.id, older.id, now])
        }
      }
      await tx.query('UPDATE entries SET cycle2_reviewed_at = $2 WHERE id = $1', [current.id, now])
      return true
    })
  } catch (error) {
    throw markStoreFault(error)
  }
}
