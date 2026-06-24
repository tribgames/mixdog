import { recallReadQuery } from './memory-recall-read-query.mjs'

const VALID_CATEGORIES_SET = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])
const VALID_STATUS_SET = new Set(['pending', 'active', 'archived'])

export async function retrieveEntries(db, filters = {}) {
  const where = []
  const params = []

  // is_root filter (default: true)
  const isRoot = filters.is_root === undefined ? true : Boolean(filters.is_root)
  where.push(`is_root = $${params.length + 1}`)
  params.push(isRoot ? 1 : 0)

  if (filters.session_id != null) {
    const sid = String(filters.session_id).trim()
    if (sid) { where.push(`session_id = $${params.length + 1}`); params.push(sid) }
  }

  // projectScope filter: 'common' → project_id IS NULL only;
  // specific slug → project_id IS NULL OR project_id = slug;
  // 'all' or undefined → no filter (full pool).
  if (filters.projectScope === 'common') {
    where.push(`project_id IS NULL`)
  } else if (typeof filters.projectScope === 'string' && filters.projectScope && filters.projectScope !== 'all') {
    where.push(`(project_id IS NULL OR project_id = $${params.length + 1})`)
    params.push(filters.projectScope)
  }
  // projectScope === 'all' or undefined → no filter

  const tsFrom = Number(filters.ts_from)
  if (Number.isFinite(tsFrom)) { where.push(`ts >= $${params.length + 1}`); params.push(tsFrom) }
  const tsTo = Number(filters.ts_to)
  if (Number.isFinite(tsTo)) { where.push(`ts <= $${params.length + 1}`); params.push(tsTo) }

  if (filters.category != null) {
    const cats = (Array.isArray(filters.category) ? filters.category : [filters.category])
      .map(c => String(c).trim().toLowerCase())
      .filter(c => VALID_CATEGORIES_SET.has(c))
    if (cats.length > 0) {
      const ph = cats.map((_, i) => `$${params.length + 1 + i}`).join(',')
      where.push(`category IN (${ph})`)
      params.push(...cats)
    }
  }

  if (filters.status != null) {
    const statusVal = String(filters.status).trim().toLowerCase()
    if (VALID_STATUS_SET.has(statusVal)) {
      where.push(`status = $${params.length + 1}`)
      params.push(statusVal)
    }
  }

  // R11 reviewer H2: exclude archived leakage in temporal augment paths.
  if (Array.isArray(filters.excludeStatuses) && filters.excludeStatuses.length > 0) {
    const exc = filters.excludeStatuses
      .map(s => String(s).trim().toLowerCase())
      .filter(s => VALID_STATUS_SET.has(s))
    if (exc.length > 0) {
      const ph = exc.map((_, i) => `$${params.length + 1 + i}`).join(',')
      where.push(`(status IS NULL OR status NOT IN (${ph}))`)
      params.push(...exc)
    }
  }

  // R11 reviewer M3: orphan raw chunks (chunk_root IS NULL) for narrow-window
  // raw merging — prevents classified-member chunks from duplicating their root.
  if (filters.chunkRootNull === true) {
    where.push(`chunk_root IS NULL`)
  }

  const limit = Math.max(1, Math.min(500, Number(filters.limit ?? 50)))
  const offset = Math.max(0, Number(filters.offset ?? 0))
  const sort = String(filters.sort ?? 'importance').trim().toLowerCase()
  const orderBy = sort === 'date'
    ? 'ts DESC, id DESC'
    : 'score DESC NULLS LAST, ts DESC, id DESC'

  params.push(limit, offset)
  const sql = `SELECT id, ts, role, content, source_ref, session_id, source_turn,
                      chunk_root, is_root, element, category, summary, project_id,
                      status, score, last_seen_at
               FROM entries
               WHERE ${where.join(' AND ')}
               ORDER BY ${orderBy}
               LIMIT $${params.length - 1} OFFSET $${params.length}`

  const rows = (await recallReadQuery(db, sql, params)).rows

  if (filters.includeMembers && rows.length > 0) {
    const rootIds = rows.map(r => r.id)
    const memRes = (await recallReadQuery(
      db,
      `SELECT id, ts, role, content, session_id, source_turn, project_id, chunk_root
       FROM entries WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
       ORDER BY chunk_root, ts ASC, id ASC`,
      [rootIds],
    )).rows
    const byRoot = new Map()
    for (const m of memRes) {
      const rid = Number(m.chunk_root)
      if (!byRoot.has(rid)) byRoot.set(rid, [])
      byRoot.get(rid).push({ id: m.id, ts: m.ts, role: m.role, content: m.content, session_id: m.session_id, source_turn: m.source_turn, project_id: m.project_id })
    }
    for (const r of rows) r.members = byRoot.get(Number(r.id)) || []
  }

  return rows
}
