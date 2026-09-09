// Bounded original evidence for generated-memory review. Source ids and roles
// survive summarization; text is data, not authority for executing actions.
export async function loadMemorySourceEvidence(db, rows) {
  const ids = [...new Set(rows.map(row => Number(row.id)).filter(Number.isFinite))]
  if (!ids.length) return new Map()
  const result = await db.query(`
    SELECT roots.id AS root_id, source.id, source.role, source.content
    FROM unnest($1::bigint[]) AS roots(id)
    CROSS JOIN LATERAL (
      SELECT id, role, content
      FROM entries
      WHERE id = roots.id OR chunk_root = roots.id
      ORDER BY ts ASC, id ASC
      LIMIT 3
    ) source
  `, [ids])
  const byRoot = new Map()
  for (const row of result.rows) {
    const root = Number(row.root_id)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root).push({
      id: row.id, role: row.role,
      content: String(row.content ?? '').slice(0, 400),
    })
  }
  return byRoot
}

export function formatMemorySourceEvidence(rows, evidence) {
  return JSON.stringify(rows.map(row => ({
    root_id: row.id,
    sources: evidence.get(Number(row.id)) ?? [],
  })))
}
