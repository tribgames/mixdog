const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

import { buildFtsQuery } from './memory-text-utils.mjs'
import { VALID_CATEGORY, embeddingToSql } from './memory.mjs'
import { freshnessFactor } from './memory-score.mjs'
import { buildRecallScopeFilter } from './memory-recall-scope-filter.mjs'
import { recallReadQuery } from './memory-recall-read-query.mjs'

// Per-db cache of mv_hot_active populated state. The main recall path currently
// uses entries directly; this guard remains for explicit useHotActive callers.
const _MV_HOT_ACTIVE_TTL_MS = 60_000
const _mvHotActiveCache = new WeakMap() // db → { populated: boolean, ts: number }
const SEMANTIC_ONLY_MIN_SIM = 0.72
const SHORT_QUERY_TOKEN_MAX = 2

function buildExactTerms(query) {
  const clean = String(query ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const terms = []
  const add = (value) => {
    const term = String(value ?? '').trim()
      .replace(/^[^\p{L}\p{N}_./:-]+|[^\p{L}\p{N}_./:-]+$/gu, '')
    if (!term) return
    const hasIdentifierShape = /[_./:-]/.test(term)
    if (!hasIdentifierShape && /^[\d\s]+$/.test(term)) return
    const symbolCount = Array.from(term).length
    if (!hasIdentifierShape && symbolCount < 2) return
    terms.push(term.slice(0, 80))
  }
  if (clean.length <= 80) add(clean)
  const tokens = clean.match(/[\p{L}\p{N}_./:-]+/gu) || []
  for (const token of tokens) add(token)
  for (let i = 0; i < tokens.length - 1; i++) {
    add(`${tokens[i]} ${tokens[i + 1]}`)
  }
  return [...new Set(terms.map(t => t.toLowerCase()))].slice(0, 12)
}

function countQueryTokens(query) {
  const clean = String(query ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return 0
  return (clean.match(/[\p{L}\p{N}_./:-]+/gu) || [])
    .filter(token => String(token ?? '').trim().length > 0)
    .length
}

function hasFullQueryTextMatch(query, row) {
  const clean = String(query ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!clean || clean.length > 160) return false
  const element = String(row?.element ?? '').toLowerCase()
  const summary = String(row?.summary ?? '').toLowerCase()
  const content = String(row?.content ?? '').toLowerCase()
  return (element && element.includes(clean))
    || (summary && summary.includes(clean))
    || (content && content.includes(clean))
}

function hasQueryTokenCoverage(row, queryTokenCount) {
  if (queryTokenCount <= SHORT_QUERY_TOKEN_MAX) return true
  const hits = Number(row?.exact_hits)
  return Number.isFinite(hits) && hits >= queryTokenCount
}

function exactTextBoost(query, row, exactHits) {
  const clean = String(query ?? '').trim().toLowerCase()
  if (!clean) return 0
  const element = String(row?.element ?? '').toLowerCase()
  const summary = String(row?.summary ?? '').toLowerCase()
  const content = String(row?.content ?? '').toLowerCase()
  let boost = 0
  if (element && element.includes(clean)) boost += 0.035
  if (summary && summary.includes(clean)) boost += 0.025
  if (content && content.includes(clean)) boost += 0.015
  const hits = Number(exactHits)
  if (Number.isFinite(hits) && hits > 0) boost += Math.min(0.03, hits * 0.008)
  return boost
}

async function _checkMvHotActivePopulated(db) {
  const cached = _mvHotActiveCache.get(db)
  const now = Date.now()
  if (cached && now - cached.ts < _MV_HOT_ACTIVE_TTL_MS) return cached.populated
  const r = await recallReadQuery(
    db,
    `SELECT relispopulated FROM pg_class WHERE relname = 'mv_hot_active' LIMIT 1`,
  )
  if (!r.rows?.length) throw new Error('mv_hot_active not found in pg_class')
  const populated = Boolean(r.rows[0].relispopulated)
  _mvHotActiveCache.set(db, { populated, ts: now })
  return populated
}

export async function searchRelevantHybrid(db, query, options = {}) {
  const clean = String(query ?? '').trim()
  if (!clean) return []
  // Numeric-only lookup is too broad for text recall ("1" matches nearly
  // everything through the short ILIKE path). Callers that know an entry id
  // should use recall's `id` mode instead of query search.
  if (/^\d+$/.test(clean)) return []

  const limit = Math.max(1, Math.floor(Number(options?.limit ?? 8)))
  const candidateWindow = Math.max(40, limit * 8)
  const includeMembers = Boolean(options.includeMembers)
  const writeBackMemberHits = options.writeBackMemberHits !== false
  // Pre-filter knobs. Without them, FTS/vec rank the whole tree and a
  // post-filter time window can wipe the result set.
  const tsFrom = Number.isFinite(Number(options.ts_from)) ? Number(options.ts_from) : null
  const tsTo = Number.isFinite(Number(options.ts_to)) ? Number(options.ts_to) : null
  // Default = empty exclusion. The archive bucket holds the bulk of historical
  // work (active is reserved for permanent invariants in this design; the
  // last-week / last-month / "what did I work on previously" recall pattern
  // depends on archived rows being in the pool). Cycle2 internal sweeps
  // that genuinely want active-only data must pass excludeStatuses
  // explicitly.
  const excludeStatuses = Array.isArray(options.excludeStatuses)
    ? options.excludeStatuses.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().toLowerCase())
    : []
  // Project scope pre-filter applied to the candidate fetch SQL.
  // 'common' → project_id IS NULL; specific slug → project_id IS NULL OR = slug;
  // 'all' or undefined → no filter.
  const projectScope = typeof options.projectScope === 'string' ? options.projectScope : null
  const categories = (Array.isArray(options.category) ? options.category : [options.category])
    .map(c => String(c ?? '').trim().toLowerCase())
    .filter(c => VALID_CATEGORY.has(c))
  // Caller can disable freshness decay when the period is calendar-bounded
  // (yesterday/today/this_week/last_week/specific date). Inside a fixed
  // window, absolute-age decay misranks early-week vs late-week entries.
  const applyFreshness = options.applyFreshness !== false

  // ── mv_hot_active fast-path opt-in ──────────────────────────────────────
  // When useHotActive:true, the dense and sparse CTE legs query mv_hot_active
  // instead of the full entries table.
  //
  // WHEN TO USE:
  //   - Explicit active-only recall (no archived inclusion, no ts_from/ts_to
  //     window). The history-first default recall path should keep useHotActive
  //     false so archived roots and fresh pending work remain eligible.
  //   - mv_hot_active holds only active roots with embeddings. Its dedicated
  //     HNSW (mv_hot_active_hnsw) and GIN (mv_hot_active_tsv) indexes are smaller
  //     than the partial indexes on entries, so ANN and FTS scans are faster.
  //   - Caller must ensure cycle2 has run at least once. The MV is created WITH NO
  //     DATA; a never-refreshed MV silently returns 0 rows — primary risk on fresh
  //     deployments.
  //
  // WHEN NOT TO USE:
  //   - ts_from / ts_to active: MV lacks the ts column; the filter clause would
  //     reference a non-existent column and the query would error.
  //   - Archived entries must be included: MV only holds active rows.
  //   - trgm is the primary signal: MV lacks content and ts, so the trgm leg
  //     always routes to entries regardless of useHotActive.
  //
  // COLUMN GAPS (resolved per CTE leg):
  //   ts      : missing → trgm short-query ORDER BY ts DESC impossible on MV;
  //             also makes ts_from/ts_to filter clauses invalid.
  //   content : missing → trgm similarity/ILIKE impossible on MV.
  //   Both gaps are intentional; trgm is unconditionally routed to entries.
  //
  // The combined/JOIN fetch after the CTE always queries entries by id, so the
  // final row shape is identical regardless of which path was taken.
  const hasTsFilter = tsFrom != null || tsTo != null
  const hasArchivedInclusion = !excludeStatuses.includes('archived')
  let useHotActive = Boolean(options.useHotActive)
    && !hasTsFilter
    && !hasArchivedInclusion
  // Guard against unrefreshed mv_hot_active (created WITH NO DATA → SQLSTATE
  // 55000 on read). Cheap pg_class check, cached 60 s per db handle to avoid
  // per-recall round-trip cost.
  if (useHotActive) {
    const populated = await _checkMvHotActivePopulated(db)
    if (!populated) useHotActive = false
  }

  // buildFilterClause: pushes ts/status/scope filters INTO candidate SELECTs.
  // offset = 1-based index of the first bind param it may consume.
  // Returns { clause: string, params: any[] }; clause begins with AND or is ''.
  function buildFilterClause(offset) {
    return buildRecallScopeFilter(offset, {
      ts_from: tsFrom,
      ts_to: tsTo,
      excludeStatuses,
      category: categories,
      projectScope,
    })
  }

  // Kept for the non-candidate root-lookup inside the member-hit resolution path.
  function buildScopeClause(offset) {
    if (projectScope === 'common') {
      return { clause: 'AND project_id IS NULL', params: [] }
    } else if (projectScope && projectScope !== 'all') {
      return { clause: `AND (project_id IS NULL OR project_id = $${offset})`, params: [projectScope] }
    }
    return { clause: '', params: [] }
  }

  // ── Single-round-trip hybrid CTE ─────────────────────────────────────────
  // Param layout (fixed prefix):
  //   $1  = halfvec literal  (NULL when no queryVector)
  //   $2  = tsQuery text     (NULL when short query)
  //   $3  = cleanText        (trigram term)
  //   $4  = candidateWindow  (LIMIT for each CTE leg)
  //   $5+ = filter params (ts_from, ts_to, excludeStatuses..., category..., projectScope slug)
  //
  // When a leg is inapplicable its CTE returns no rows; the UNION + LEFT JOINs
  // handle that cleanly. dense/sparse/trgm legs each re-use the same filter
  // params starting at $5 since they live in independent CTE scopes.

  const vecSql = (Array.isArray(options.queryVector) && options.queryVector.length > 0)
    ? embeddingToSql(options.queryVector)
    : null

  const ftsQuery = clean.length >= 3 ? (buildFtsQuery(clean) ?? null) : null
  const exactTerms = buildExactTerms(clean)
  const queryTokenCount = countQueryTokens(clean)
  const minExactHits = exactTerms.length >= 8 ? 3 : exactTerms.length >= 4 ? 2 : 1

  // For very short queries (< 3 chars) the trigram operator still works but
  // we relax the server-side threshold via set_limit() — however that requires
  // a separate round-trip. Instead we fall back to a plain ILIKE scan for
  // short text (rare edge case; sequential scan is acceptable for < 3 chars).
  const isShortQuery = clean.length < 3

  // $5 onward are the filter params for the entries legs (non-MV path).
  // Each CTE leg duplicates the same positional params because they live in
  // independent SELECT scopes. When useHotActive=true, the trgm leg still uses
  // these params but at adjusted offsets (see activeBindParams below).
  const { clause: filterClause, params: filterParams } = buildFilterClause(5)

  // MV-specific filter: only category/projectScope matter (status='active' and
  // embedding IS NOT NULL are baked into mv_hot_active; ts_from/ts_to are
  // unavailable since MV lacks the ts column).
  function buildMvFilterClause(offset) {
    const clauses = []
    const params = []
    let next = offset
    if (categories.length > 0) {
      const placeholders = categories.map(() => `$${next++}`).join(', ')
      clauses.push(`category IN (${placeholders})`)
      params.push(...categories)
    }
    if (projectScope === 'common') {
      clauses.push('project_id IS NULL')
    } else if (projectScope && projectScope !== 'all') {
      clauses.push(`(project_id IS NULL OR project_id = $${next++})`)
      params.push(projectScope)
    }
    return { clause: clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '', params }
  }
  // mvBindParams layout when useHotActive=true:
  //   $1–$4 : same prefix (vec, fts, clean, window)
  //   $5+   : mvFilterParams (category filters + optional projectScope slug)
  //   $5+N+ : trgmFilterParams (ts/status/scope for the entries-only trgm leg)
  //
  // The trgm CTE always targets entries and needs the full filter (excludeStatuses,
  // ts_from, ts_to, category, projectScope). When useHotActive=true, trgm filter params
  // start AFTER mvFilterParams so positional params align correctly in the
  // combined bind array.
  const { clause: mvFilterClause, params: mvFilterParams } = buildMvFilterClause(5)
  // trgm filter: when useHotActive, build starting at offset 5 + mvFilterParams.length.
  const trgmFilterOffset = useHotActive ? 5 + mvFilterParams.length : 5
  const { clause: trgmFilterClause, params: trgmFilterParams } = buildFilterClause(trgmFilterOffset)
  // activeBindParams is the single array passed to db.query for the full hybrid SQL.
  // Non-MV path: [vec,fts,clean,window, ...filterParams] (filterClause == trgmFilterClause).
  // MV path:     [vec,fts,clean,window, ...mvFilterParams, ...trgmFilterParams].
  const recallScopeOpts = {
    ts_from: tsFrom,
    ts_to: tsTo,
    excludeStatuses,
    category: categories,
    projectScope,
  }
  const exactTermsParam = useHotActive
    ? 5 + mvFilterParams.length + trgmFilterParams.length
    : 5 + filterParams.length
  const exactFilterClause = buildRecallScopeFilter(
    useHotActive ? trgmFilterOffset : 5,
    recallScopeOpts,
    'ee',
  ).clause
  const activeBindParams = useHotActive
    ? [vecSql, ftsQuery, clean, candidateWindow, ...mvFilterParams, ...trgmFilterParams, ...(exactTerms.length > 0 ? [exactTerms] : [])]
    : [vecSql, ftsQuery, clean, candidateWindow, ...filterParams, ...(exactTerms.length > 0 ? [exactTerms] : [])]

  // dense CTE: active only when a query vector is supplied.
  // useHotActive → queries mv_hot_active (smaller HNSW, no ts/content needed).
  const denseCte = vecSql ? (useHotActive ? `
dense AS (
  SELECT id,
         1 - (embedding <=> $1::halfvec) AS sim,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $1::halfvec) AS dense_rank
  FROM mv_hot_active
  WHERE true
    ${mvFilterClause}
  ORDER BY embedding <=> $1::halfvec
  LIMIT $4
),` : `
dense AS (
  SELECT id,
         1 - (embedding <=> $1::halfvec) AS sim,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $1::halfvec) AS dense_rank
  FROM entries
  WHERE embedding IS NOT NULL
    ${filterClause}
  ORDER BY embedding <=> $1::halfvec
  LIMIT $4
),`) : `
dense AS (SELECT NULL::bigint AS id, NULL::float8 AS sim, NULL::bigint AS dense_rank WHERE $1::halfvec IS NOT NULL AND false),`

  // sparse CTE: active only when ftsQuery is non-null.
  // useHotActive → queries mv_hot_active GIN index (mv_hot_active_tsv).
  const sparseCte = ftsQuery ? (useHotActive ? `
sparse AS (
  SELECT id,
         ts_rank_cd(search_tsv, websearch_to_tsquery('simple', $2)) AS lex,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_tsv, websearch_to_tsquery('simple', $2)) DESC) AS sparse_rank
  FROM mv_hot_active
  WHERE search_tsv @@ websearch_to_tsquery('simple', $2)
    ${mvFilterClause}
  ORDER BY lex DESC
  LIMIT $4
),` : `
sparse AS (
  SELECT id,
         ts_rank_cd(search_tsv, websearch_to_tsquery('simple', $2)) AS lex,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_tsv, websearch_to_tsquery('simple', $2)) DESC) AS sparse_rank
  FROM entries
  WHERE search_tsv @@ websearch_to_tsquery('simple', $2)
    ${filterClause}
  ORDER BY lex DESC
  LIMIT $4
),`) : `
sparse AS (SELECT NULL::bigint AS id, NULL::float8 AS lex, NULL::bigint AS sparse_rank WHERE $2::text IS NOT NULL AND false),`

  // trgm CTE: pg_trgm similarity path. For short queries (< 3 chars) the %
  // operator is unreliable (trigrams need at least 3 chars); use ILIKE instead.
  // NOTE: trgm always queries entries regardless of useHotActive — mv_hot_active
  // lacks the content column (trgm/ILIKE) and ts column (short-query ORDER BY).
  // Uses trgmFilterClause whose $N offsets are aligned to activeBindParams.
  const trgmCte = isShortQuery ? `
trgm AS (
  SELECT id,
         0.5::float8 AS trg_sim,
         ROW_NUMBER() OVER (ORDER BY ts DESC) AS trgm_rank
  FROM entries
  WHERE (content ILIKE '%' || $3 || '%' OR element ILIKE '%' || $3 || '%')
    ${trgmFilterClause}
  ORDER BY ts DESC
  LIMIT $4
),` : `
trgm AS (
  SELECT id,
          GREATEST(
            CASE WHEN content ILIKE '%' || $3 || '%' THEN 1.0 ELSE similarity(content, $3) END,
            CASE WHEN coalesce(element, '') ILIKE '%' || $3 || '%' THEN 1.0 ELSE similarity(coalesce(element, ''), $3) END,
            CASE WHEN coalesce(summary, '') ILIKE '%' || $3 || '%' THEN 1.0 ELSE similarity(coalesce(summary, ''), $3) END
          ) AS trg_sim,
          ROW_NUMBER() OVER (ORDER BY GREATEST(
            CASE WHEN content ILIKE '%' || $3 || '%' THEN 1.0 ELSE similarity(content, $3) END,
            CASE WHEN coalesce(element, '') ILIKE '%' || $3 || '%' THEN 1.0 ELSE similarity(coalesce(element, ''), $3) END,
            CASE WHEN coalesce(summary, '') ILIKE '%' || $3 || '%' THEN 1.0 ELSE similarity(coalesce(summary, ''), $3) END
          ) DESC) AS trgm_rank
   FROM entries
   WHERE (
       content % $3 OR element % $3 OR summary % $3
       OR content ILIKE '%' || $3 || '%'
       OR coalesce(element, '') ILIKE '%' || $3 || '%'
       OR coalesce(summary, '') ILIKE '%' || $3 || '%'
     )
     AND GREATEST(
       CASE WHEN content ILIKE '%' || $3 || '%' THEN 1.0 ELSE similarity(content, $3) END,
       CASE WHEN coalesce(element, '') ILIKE '%' || $3 || '%' THEN 1.0 ELSE similarity(coalesce(element, ''), $3) END,
       CASE WHEN coalesce(summary, '') ILIKE '%' || $3 || '%' THEN 1.0 ELSE similarity(coalesce(summary, ''), $3) END
     ) >= 0.10
     ${trgmFilterClause}
   ORDER BY trg_sim DESC
   LIMIT $4
 ),`

  const exactCte = exactTerms.length > 0 ? `
exact AS (
  SELECT ee.id,
         COUNT(*)::float8 AS exact_hits,
         ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, ee.ts DESC) AS exact_rank
  FROM entries ee
  JOIN LATERAL unnest($${exactTermsParam}::text[]) AS q(term) ON (
       ee.content ILIKE '%' || q.term || '%'
       OR coalesce(ee.element, '') ILIKE '%' || q.term || '%'
       OR coalesce(ee.summary, '') ILIKE '%' || q.term || '%'
  )
  WHERE true
    ${exactFilterClause}
  GROUP BY ee.id, ee.ts
  HAVING COUNT(*) >= ${minExactHits}
  ORDER BY exact_hits DESC, ee.ts DESC
  LIMIT $4
),` : `
exact AS (SELECT NULL::bigint AS id, NULL::float8 AS exact_hits, NULL::bigint AS exact_rank WHERE false),`

  const hybridSql = `
WITH
${denseCte}
${sparseCte}
${trgmCte}
${exactCte}
combined AS (
  SELECT id FROM dense  WHERE id IS NOT NULL UNION
  SELECT id FROM sparse WHERE id IS NOT NULL UNION
  SELECT id FROM trgm   WHERE id IS NOT NULL UNION
  SELECT id FROM exact  WHERE id IS NOT NULL
)
SELECT
  e.id, e.element, e.summary, e.category, e.status, e.score,
  e.last_seen_at, e.ts, e.project_id, e.session_id, e.source_ref,
  e.source_turn, e.content, e.chunk_root, e.is_root,
  e.role,
  d.sim        AS dense_sim,
  d.dense_rank,
  s.lex        AS sparse_lex,
  s.sparse_rank,
  t.trg_sim,
  t.trgm_rank,
  x.exact_hits,
  x.exact_rank
FROM combined c
JOIN   entries e ON e.id = c.id
LEFT JOIN dense  d ON d.id = c.id
LEFT JOIN sparse s ON s.id = c.id
LEFT JOIN trgm   t ON t.id = c.id
LEFT JOIN exact  x ON x.id = c.id`

  let rawRows = []
  let denseCount = 0
  let sparseCount = 0
  let trgmCount = 0
  let exactCount = 0

  try {
    const { rows } = await recallReadQuery(db, hybridSql, activeBindParams)
    rawRows = rows
    // Count how many rows each leg contributed (a row may appear in multiple legs).
    for (const r of rawRows) {
      if (r.dense_rank != null) denseCount++
      if (r.sparse_rank != null) sparseCount++
      if (r.trgm_rank != null) trgmCount++
      if (r.exact_rank != null) exactCount++
    }
  } catch (err) {
    __mixdogMemoryLog(`[recall] hybrid CTE failed: ${err.message}\n`)
    return []
  }

  if (rawRows.length === 0) return []

  // ── JS-side RRF merge (unchanged logic) ──────────────────────────────────
  // K=60 is the standard RRF constant from Cormack et al. (SIGIR 2009).
  const K = 60
  const nowMs = Date.now()

  const scoredAll = rawRows.map(row => {
    const id = Number(row.id)
    const denseRank = row.dense_rank != null ? Number(row.dense_rank) : null
    const sparseRank = row.sparse_rank != null ? Number(row.sparse_rank) : null
    const trgmRank = row.trgm_rank != null ? Number(row.trgm_rank) : null
    const exactRank = row.exact_rank != null ? Number(row.exact_rank) : null
    const rrf = (denseRank ? 1 / (K + denseRank) : 0)
              + (sparseRank ? 1 / (K + sparseRank) : 0)
              + (trgmRank ? 1 / (K + trgmRank) : 0)
              + (exactRank ? 1 / (K + exactRank) : 0)
    const freshness = applyFreshness ? freshnessFactor(row.ts, nowMs) : 1.0
    const boost = exactTextBoost(clean, row, row.exact_hits)
    return { id, row, rrf, freshness, retrievalScore: (rrf * freshness) + boost }
  })
  let semanticOnlyDropped = 0
  let weakTextDropped = 0
  const scored = scoredAll.filter(({ row }) => {
    const hasTextSupport = row.sparse_rank != null || row.trgm_rank != null || row.exact_rank != null
    const sim = Number(row.dense_sim)
    const hasSemanticSupport = Number.isFinite(sim) && sim >= SEMANTIC_ONLY_MIN_SIM
    if (!hasTextSupport) {
      if (hasSemanticSupport) return true
      semanticOnlyDropped += 1
      return false
    }
    // A long query that only shares a weak trigram/exact tail with old rows
    // should not fill the page with accidental matches. Accept lexical-only
    // rows when the query is a short keyword/identifier lookup, a full phrase
    // match, or an FTS hit. Otherwise require semantic support as a second
    // independent signal.
    if (categories.length > 0) return true
    const hasFullPhrase = hasFullQueryTextMatch(clean, row)
    if (hasFullPhrase) return true
    if (queryTokenCount <= SHORT_QUERY_TOKEN_MAX) return true
    if (row.sparse_rank != null) return true
    if (hasSemanticSupport && hasQueryTokenCoverage(row, queryTokenCount)) return true
    weakTextDropped += 1
    return false
  })
  if (scored.length === 0) return []
  scored.sort((a, b) => b.retrievalScore - a.retrievalScore || b.rrf - a.rrf)

  const filtered = scored

  // ── Root resolution + member-hit write-back ───────────────────────────────
  const byId = new Map(rawRows.map(r => [Number(r.id), r]))
  const memberHitRootIds = new Set()
  const rootIdsForReturn = []
  const seen = new Set()

  // Batch-resolve member-chunk roots in ONE query (was an N+1: a per-row SELECT
  // inside the loop below). Collect the distinct in-scope chunk_root ids, fetch
  // all matching roots at once, then resolve each member from rootById.
  const memberRootIds = []
  const memberRootSeen = new Set()
  for (const { id } of filtered) {
    const r0 = byId.get(id)
    if (!r0 || r0.is_root === 1) continue
    if (r0.chunk_root != null && r0.chunk_root !== r0.id) {
      const rid = Number(r0.chunk_root)
      if (!memberRootSeen.has(rid)) { memberRootSeen.add(rid); memberRootIds.push(rid) }
    }
  }
  const rootById = new Map()
  if (memberRootIds.length > 0) {
    const { clause: rootScopeClause, params: rootScopeParams } = buildScopeClause(2)
    const { rows: rootRows } = await recallReadQuery(
      db,
      `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
              element, category, summary, project_id, status, score, last_seen_at
       FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 1 ${rootScopeClause}`,
      [memberRootIds, ...rootScopeParams],
    )
    for (const rr of rootRows) rootById.set(Number(rr.id), rr)
  }

  for (const { id, rrf, retrievalScore } of filtered) {
    const row = byId.get(id)
    if (!row) continue
    let targetRow = null
    if (row.is_root === 1) {
      targetRow = row
    } else if (row.chunk_root != null && row.chunk_root !== row.id) {
      const r = rootById.get(Number(row.chunk_root))
      if (!r) continue
      memberHitRootIds.add(r.id)
      targetRow = r
    } else {
      targetRow = row
    }
    if (seen.has(targetRow.id)) continue
    seen.add(targetRow.id)
    rootIdsForReturn.push({
      root: targetRow,
      rrf,
      retrievalScore,
      retrievalRank: rootIdsForReturn.length + 1,
    })
    if (rootIdsForReturn.length >= limit) break
  }

  let writeBackCount = 0
  if (writeBackMemberHits && memberHitRootIds.size > 0) {
    // Batch UPDATE — single round-trip instead of N (one per member-hit root).
    const validRootIds = []
    for (const rootId of memberHitRootIds) {
      const r = rootIdsForReturn.find(x => x.root.id === rootId)?.root ?? byId.get(rootId)
      if (r) validRootIds.push(Number(rootId))
    }
    if (validRootIds.length > 0) {
      try {
        const { rowCount } = await db.query(
          `UPDATE entries SET last_seen_at = $1::bigint WHERE id = ANY($2::bigint[]) AND is_root = 1
           AND (last_seen_at IS NULL OR last_seen_at < $1::bigint - 3600000)`,
          [String(nowMs), validRootIds],
        )
        writeBackCount = rowCount ?? validRootIds.length
      } catch (err) {
        __mixdogMemoryLog(`[recall] writeback batch failed (count=${validRootIds.length}): ${err.message}\n`)
      }
    }
  }

  // ── Final fetch: full row for each root by id = ANY(bigint[]) ────────────
  const topIds = rootIdsForReturn.map(x => Number(x.root.id))
  const { clause: finalFilter, params: finalFilterParams } = buildFilterClause(2)
  const { rows: finalRows } = await recallReadQuery(
    db,
    `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
            element, category, summary, project_id, status, score, last_seen_at
     FROM entries
     WHERE id = ANY($1::bigint[])
       ${finalFilter}`,
    [topIds, ...finalFilterParams],
  )
  const finalById = new Map(finalRows.map(r => [Number(r.id), r]))

  // Members: single batch fetch keyed by chunk_root = ANY($1) — one
  // round-trip vs N. Map to per-root arrays preserving (ts ASC, id ASC).
  let membersByRoot = new Map()
  if (includeMembers) {
    const rootIds = rootIdsForReturn
      .map(x => Number(finalById.get(Number(x.root.id))?.id ?? x.root.id))
      .filter(id => {
        const fr = finalById.get(id) ?? rootIdsForReturn.find(x => Number(x.root.id) === id)?.root
        return fr && fr.is_root === 1
      })
    if (rootIds.length > 0) {
      const { rows: memberRows } = await recallReadQuery(
        db,
        `SELECT id, ts, role, content, session_id, source_turn, project_id, chunk_root
         FROM entries WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
         ORDER BY ts ASC, id ASC`,
        [rootIds],
      )
      for (const m of memberRows) {
        const k = Number(m.chunk_root)
        if (!membersByRoot.has(k)) membersByRoot.set(k, [])
        membersByRoot.get(k).push(m)
      }
    }
  }
  const results = []
  for (const { root, rrf, retrievalScore, retrievalRank } of rootIdsForReturn) {
    // Roots absent from finalById were excluded by the status/time filter on
    // the final fetch; falling back to the unfiltered `root` would leak
    // archived / out-of-window rows via member-hit resolution.
    const finalRoot = finalById.get(Number(root.id))
    if (!finalRoot) continue
    const out = { ...finalRoot, rrf, retrievalScore, retrievalRank }
    if (includeMembers && finalRoot.is_root === 1) {
      out.members = membersByRoot.get(Number(finalRoot.id)) ?? []
    }
    results.push(out)
  }

  __mixdogMemoryLog(
    `[recall] dense=${denseCount} sparse=${sparseCount} trgm=${trgmCount} exact=${exactCount} semantic_only_dropped=${semanticOnlyDropped} weak_text_dropped=${weakTextDropped} merged=${results.length} write_back=${writeBackCount}\n`,
  )

  return results
}
