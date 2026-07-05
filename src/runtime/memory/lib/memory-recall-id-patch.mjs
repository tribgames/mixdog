// Helper: scoped id recall query (used from index handleSearch id mode).
import { buildRecallScopeFilter } from './memory-recall-scope-filter.mjs'
import { recallReadQuery } from './memory-recall-read-query.mjs'

export async function fetchEntriesByIdsScoped(db, ids, scopeOptions) {
  const { clause, params } = buildRecallScopeFilter(2, scopeOptions)
  const { rows } = await recallReadQuery(
    db,
    `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
            element, category, summary, project_id, status, score, last_seen_at
     FROM entries WHERE id = ANY($1::bigint[]) ${clause}`,
    [ids, ...params],
  )
  return rows
}