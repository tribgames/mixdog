// Raw-row priority lookup for narrow-window queries. Raw rows (is_root=0,
// chunk_root IS NULL) are inserted immediately by ingestTranscriptFile before
// cycle1 runs, so they always carry the freshest turns in the DB.
import { appendProjectScopeClause } from './memory-recall-scope-filter.mjs';

const RAW_TEXT_EXPR = `lower(coalesce(content, '') || ' ' || coalesce(element, '') || ' ' || coalesce(summary, ''))`;

/** Term evidence for the raw leg: pushes the minimum-hits floor onto `where`
 *  and returns the ORDER BY prefix that ranks rows by evidence before recency.
 *  Multi-token queries: from 3+ terms require at least 2 matching terms so one
 *  common token ("chat", "recall") can't drag unrelated raw rows into the page.
 *  1-2 term queries keep single-hit contains semantics — short Korean queries
 *  are often exactly two meaningful tokens and a 2-of-2 requirement silently
 *  emptied the raw leg for them. Token order is deliberate: query
 *  normalization puts identifiers and preserved compounds first, so a
 *  distinctive term wins ties over a newer broad-term coincidence. */
function appendTermEvidence(where, params, terms, minHitsOverride) {
  const clauses = terms.map((term) => {
    params.push(`%${term}%`);
    return `(CASE WHEN ${RAW_TEXT_EXPR} LIKE $${params.length} THEN 1 ELSE 0 END)`;
  });
  const defaultMinHits = terms.length >= 3 ? 2 : 1;
  const minHits = Number.isFinite(Number(minHitsOverride))
    ? Math.max(1, Math.floor(Number(minHitsOverride)))
    : defaultMinHits;
  const matchSum = clauses.join(' + ');
  where.push(`(${matchSum}) >= ${minHits}`);
  return `${matchSum} DESC, ${clauses.map((clause) => `${clause} DESC`).join(', ')}, `;
}

/** Newest raw rows inside [tsFromMs, tsToMs]. The WHERE assembly mirrors
 *  retrieveEntries' filter semantics so raw and chunked legs stay in filter
 *  parity: projectScope AND sessionId apply identically to both pools. */
export async function readRawRowsInWindow(
  db,
  tsFromMs,
  tsToMs,
  hardLimit = 10,
  { projectScope, sessionId, terms, minHits: minHitsOverride } = {}
) {
  try {
    const where = ['chunk_root IS NULL', 'is_root = 0', 'ts >= $1', 'ts <= $2'];
    const params = [tsFromMs ?? 0, tsToMs ?? Date.now()];
    let termOrder = '';
    appendProjectScopeClause(where, params, projectScope);
    const sid = String(sessionId || '').trim();
    if (sid) {
      params.push(sid);
      where.push(`session_id = $${params.length}`);
    }
    if (Array.isArray(terms) && terms.length > 0) termOrder = appendTermEvidence(where, params, terms, minHitsOverride);
    params.push(hardLimit);
    const sql = `SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
                element, category, summary, status, score, last_seen_at, project_id
         FROM entries
         WHERE ${where.join(' AND ')}
         ORDER BY ${termOrder}ts DESC, source_turn DESC NULLS LAST, id DESC
         LIMIT $${params.length}`;
    const rows = (await db.query(sql, params)).rows;
    return rows.map((r) => ({ ...r, retrievalScore: 0, rrf: 0 }));
  } catch {
    return [];
  }
}
