/**
 * src/runtime/memory/lib/recall-hybrid/hybrid-sql.mjs - the single-round-trip
 * hybrid candidate CTE (dense / sparse / substring / exact-term legs) and its
 * positional bind layout.
 */
import { buildFtsQuery, buildFtsPrefixQuery } from '../memory-text-utils.mjs';
import { embeddingToSql } from '../memory.mjs';
import { recallSubstringPredicate } from '../recall-substring-predicate.mjs';
import { buildExactTerms } from '../recall-scoring.mjs';
import { filterClause } from './plan.mjs';
import { envNonNegativeInt } from '../../../shared/env.mjs';

// Bounded lexical scan window. The trgm/exact CTE legs run `ILIKE '%…%'`
// which are indexable when optional pg_trgm indexes exist. On portable
// runtimes without them, their worst case grows linearly with the
// entries table — on a years-old memory DB every recall pays a full-table
// substring scan twice. Bound both legs to the newest N rows by id (bigserial
// ⇒ insertion order; MAX(id) resolves via the pk index, no sort). Dense
// (HNSW) and sparse (GIN FTS) legs still cover the WHOLE table through real
// indexes, so old memories remain reachable semantically/topically — only the
// exact-substring rescue narrows to recent rows. Default 200k: measured on a
// live DB, a 20k bound regressed recall quality (bench MRR 0.75 → 0.33 — the
// rescued rows sat beyond the newest 20k inserts), so the default only guards
// pathological table growth, not today's scale. MIXDOG_RECALL_LEXSCAN_ROWS
// overrides; 0 restores the unbounded scan.
const RECALL_LEXSCAN_ROWS = envNonNegativeInt('MIXDOG_RECALL_LEXSCAN_ROWS', 200_000);
function lexScanBound(alias = '') {
  if (RECALL_LEXSCAN_ROWS <= 0) return '';
  const col = alias ? `${alias}.id` : 'id';
  return `AND ${col} >= (SELECT GREATEST(COALESCE(MAX(id), 0) - ${RECALL_LEXSCAN_ROWS}, 0) FROM entries)`;
}

// Candidate generation is recall-oriented: one concept may be the only
// distinctive event identifier in a natural-language question. Precision is
// enforced after retrieval through semantic support, token coverage, and
// candidate-local document frequency rather than by requiring several query
// concepts to co-occur before the row can even be scored.
const MIN_EXACT_HITS = 1;

// dense CTE: active only when a query vector is supplied.
function denseCte(vecSql, filters) {
  if (!vecSql) {
    return `
dense AS (SELECT NULL::bigint AS id, NULL::float8 AS sim, NULL::bigint AS dense_rank WHERE $1::halfvec IS NOT NULL AND false),`;
  }
  return `
dense AS (
  SELECT id,
         1 - (embedding <=> $1::halfvec) AS sim,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $1::halfvec) AS dense_rank
  FROM entries
  WHERE embedding IS NOT NULL
    ${filters.filterClause}
    ${filters.entryRootFilter}
  ORDER BY embedding <=> $1::halfvec
  LIMIT $4
),`;
}

// sparse CTE: active only when ftsQuery is non-null.
// tsqExpr: to_tsquery for normalized prefix terms ('stem:* & ...'), else
// websearch_to_tsquery for a plain fallback token string. Both parse $2 under
// the 'simple' config to match search_tsv's simple-config lexemes.
function sparseCte(ftsQuery, ftsPrefixMode, filters) {
  if (!ftsQuery) {
    return `
sparse AS (SELECT NULL::bigint AS id, NULL::float8 AS lex, NULL::bigint AS sparse_rank WHERE $2::text IS NOT NULL AND false),`;
  }
  const tsqExpr = ftsPrefixMode ? `to_tsquery('simple', $2)` : `websearch_to_tsquery('simple', $2)`;
  return `
sparse AS (
  SELECT id,
         ts_rank_cd(search_tsv, ${tsqExpr}) AS lex,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_tsv, ${tsqExpr}) DESC) AS sparse_rank
  FROM entries
  WHERE search_tsv @@ ${tsqExpr}
    ${filters.filterClause}
    ${filters.entryRootFilter}
  ORDER BY lex DESC
  LIMIT $4
),`;
}

// Portable substring leg. The curated Unix PG runtimes include pgvector but
// not the optional pg_trgm contrib extension, so fuzzy similarity cannot be
// a startup/runtime requirement. FTS and dense vector search retain broad
// matching while this leg gives exact substrings a deterministic rescue.
function trgmCte(filters) {
  return `
trgm AS (
  SELECT id,
         1.0::float8 AS trg_sim,
         ROW_NUMBER() OVER (ORDER BY ts DESC) AS trgm_rank
  FROM entries
  WHERE (
      content ILIKE '%' || $3 || '%'
      OR ${recallSubstringPredicate('element', '$3')}
      OR ${recallSubstringPredicate('summary', '$3')}
    )
    ${filters.filterClause}
    ${filters.entryRootFilter}
    ${lexScanBound()}
  ORDER BY ts DESC
  LIMIT $4
),`;
}

function exactCte(exactTermsParam, filters) {
  if (!exactTermsParam) {
    return `
exact_matches AS (
  SELECT NULL::bigint AS id, NULL::bigint AS ts, NULL::text AS term, NULL::float8 AS term_df
  WHERE false
),
exact AS (
  SELECT NULL::bigint AS id, NULL::float8 AS exact_hits,
         NULL::float8 AS exact_phrase_hits, NULL::float8 AS exact_rarity,
         NULL::bigint AS exact_rank
  WHERE false
),`;
  }
  return `
exact_matches AS (
  SELECT ee.id,
         ee.ts,
         q.term,
         COUNT(*) OVER (PARTITION BY q.term)::float8 AS term_df
  FROM entries ee
  JOIN LATERAL unnest($${exactTermsParam}::text[]) AS q(term) ON (
       ee.content ILIKE '%' || q.term || '%'
       OR ${recallSubstringPredicate('ee.element', 'q.term')}
       OR ${recallSubstringPredicate('ee.summary', 'q.term')}
  )
  WHERE true
    ${filters.exactFilterClause}
    ${filters.exactRootFilter}
    ${lexScanBound('ee')}
),
exact AS (
  SELECT id,
         COUNT(*)::float8 AS exact_hits,
         COUNT(*) FILTER (WHERE POSITION(' ' IN term) > 0)::float8 AS exact_phrase_hits,
         SUM(
           (CASE WHEN term ~ '[A-Za-z0-9_./:-]' THEN 3.0 ELSE 1.0 END)
           / SQRT(GREATEST(term_df, 1))
         )::float8 AS exact_rarity,
         ROW_NUMBER() OVER (
           ORDER BY SUM(
                      (CASE WHEN term ~ '[A-Za-z0-9_./:-]' THEN 3.0 ELSE 1.0 END)
                      / SQRT(GREATEST(term_df, 1))
                    ) DESC,
                    COUNT(*) DESC,
                    MAX(ts) DESC
         ) AS exact_rank
  FROM exact_matches
  GROUP BY id
  HAVING COUNT(*) >= ${MIN_EXACT_HITS}
  ORDER BY exact_rarity DESC, exact_hits DESC, MAX(ts) DESC
  LIMIT $4
),`;
}

/**
 * Param layout (fixed prefix):
 *   $1  = halfvec literal  (NULL when no queryVector)
 *   $2  = tsQuery text     (NULL when short query)
 *   $3  = cleanText        (trigram term)
 *   $4  = candidateWindow  (LIMIT for each CTE leg)
 *   $5+ = filter params (ts_from, ts_to, excludeStatuses..., category..., projectScope slug)
 *   then the exact-term array when the query yields exact terms.
 *
 * When a leg is inapplicable its CTE returns no rows; the UNION + LEFT JOINs
 * handle that cleanly. dense/sparse/trgm legs each re-use the same filter
 * params starting at $5 since they live in independent CTE scopes.
 */
export function buildHybridQuery(plan) {
  const vecSql = plan.queryVector ? embeddingToSql(plan.queryVector) : null;
  // Use the model-free Korean normalizer with to_tsquery ':*' prefix matches.
  // ftsPrefixMode drives which tsquery constructor the sparse CTE uses.
  const ftsPrefix = plan.clean.length >= 3 ? buildFtsPrefixQuery(plan.clean) : null;
  let ftsQuery = null;
  if (ftsPrefix) ftsQuery = ftsPrefix.query;
  else if (plan.clean.length >= 3) ftsQuery = buildFtsQuery(plan.clean) ?? null;
  const exactTerms = buildExactTerms(plan.clean);

  // Each CTE leg uses the same positional filters against the history table.
  const { clause, params: filterParams } = filterClause(plan, 5);
  const filters = {
    filterClause: clause,
    entryRootFilter: plan.rootOnly ? 'AND is_root = 1' : '',
    exactFilterClause: filterClause(plan, 5, { tableAlias: 'ee' }).clause,
    exactRootFilter: plan.rootOnly ? 'AND ee.is_root = 1' : '',
  };
  const exactTermsParam = exactTerms.length > 0 ? 5 + filterParams.length : 0;

  const sql = `
WITH
${denseCte(vecSql, filters)}
${sparseCte(ftsQuery, Boolean(ftsPrefix), filters)}
${trgmCte(filters)}
${exactCte(exactTermsParam, filters)}
combined AS (
  SELECT id FROM dense  WHERE id IS NOT NULL UNION
  SELECT id FROM sparse WHERE id IS NOT NULL UNION
  SELECT id FROM trgm   WHERE id IS NOT NULL UNION
  SELECT id FROM exact  WHERE id IS NOT NULL
)
SELECT
  e.id, e.element, e.summary, e.category, e.status, e.score,
  e.last_seen_at, e.ts, e.project_id, e.session_id, e.source_ref,
  e.source_turn, e.content, e.chunk_root, e.concept_id, e.supersedes_id, e.is_root,
  e.role,
  d.sim        AS dense_sim,
  d.dense_rank,
  s.lex        AS sparse_lex,
  s.sparse_rank,
  t.trg_sim,
  t.trgm_rank,
  x.exact_hits,
  x.exact_phrase_hits,
  x.exact_rarity,
  x.exact_rank
FROM combined c
JOIN   entries e ON e.id = c.id
LEFT JOIN dense  d ON d.id = c.id
LEFT JOIN sparse s ON s.id = c.id
LEFT JOIN trgm   t ON t.id = c.id
LEFT JOIN exact  x ON x.id = c.id`;
  const params = [
    vecSql,
    ftsQuery,
    plan.clean,
    plan.candidateWindow,
    ...filterParams,
    ...(exactTermsParam ? [exactTerms] : []),
  ];
  return { sql, params };
}

/** How many candidate rows each leg contributed (a row may appear in several). */
export function legCounts(rows) {
  const counts = { dense: 0, sparse: 0, trgm: 0, exact: 0 };
  for (const r of rows) {
    if (r.dense_rank != null) counts.dense++;
    if (r.sparse_rank != null) counts.sparse++;
    if (r.trgm_rank != null) counts.trgm++;
    if (r.exact_rank != null) counts.exact++;
  }
  return counts;
}
