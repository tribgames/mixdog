import { __mixdogMemoryLog } from './memory-log.mjs';

import { buildFtsQuery, buildFtsPrefixQuery } from './memory-text-utils.mjs';
import { VALID_CATEGORY, embeddingToSql } from './memory.mjs';
import { buildRecallScopeFilter, projectScopePredicate } from './memory-recall-scope-filter.mjs';
import { recallReadQuery } from './memory-recall-read-query.mjs';
import { rankRecallCandidates, recallLaneRanks, recallRrfScore } from './recall-fusion.mjs';
import { recallSubstringPredicate } from './recall-substring-predicate.mjs';

import { memberTsInWindow, buildExactTerms } from './recall-scoring.mjs';
import { collapseHistoryDuplicates } from './history-duplicates.mjs';

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
const _envLexScan = Number(process.env.MIXDOG_RECALL_LEXSCAN_ROWS);
const RECALL_LEXSCAN_ROWS = Number.isFinite(_envLexScan) && _envLexScan >= 0 ? Math.floor(_envLexScan) : 200_000;
function lexScanBound(alias = '') {
  if (RECALL_LEXSCAN_ROWS <= 0) return '';
  const col = alias ? `${alias}.id` : 'id';
  return `AND ${col} >= (SELECT GREATEST(COALESCE(MAX(id), 0) - ${RECALL_LEXSCAN_ROWS}, 0) FROM entries)`;
}

export async function searchRelevantHybrid(db, query, options = {}) {
  const clean = String(query ?? '').trim();
  if (!clean) return [];
  // Numeric-only lookup is too broad for text recall ("1" matches nearly
  // everything through the short ILIKE path). Callers that know an entry id
  // should use recall's `id` mode instead of query search.
  if (/^\d+$/.test(clean)) return [];

  const limit = Math.max(1, Math.floor(Number(options?.limit ?? 8)));
  // Retrieval quality must not depend on the caller's display page size.
  // Work/event queries often have many same-topic progress rows; a limit=10
  // page still needs a broad pool so the final decision can outrank them.
  const candidateWindow = Math.max(240, limit * 8);
  const includeMembers = Boolean(options.includeMembers);
  const rootOnly = options.rootOnly === true;
  // Pre-filter knobs. Without them, FTS/vec rank the whole tree and a
  // post-filter time window can wipe the result set.
  const tsFrom = Number.isFinite(Number(options.ts_from)) ? Number(options.ts_from) : null;
  const tsTo = Number.isFinite(Number(options.ts_to)) ? Number(options.ts_to) : null;
  // All history is searchable by default. Legacy status filters are honored
  // only when explicitly requested; maintenance no longer assigns importance.
  const excludeStatuses = Array.isArray(options.excludeStatuses)
    ? options.excludeStatuses.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toLowerCase())
    : [];
  // Project scope pre-filter applied to the candidate fetch SQL.
  // 'common' → project_id IS NULL; specific slug → project_id IS NULL OR = slug;
  // 'all' or undefined → no filter.
  const projectScope = typeof options.projectScope === 'string' ? options.projectScope : null;
  const categories = (Array.isArray(options.category) ? options.category : [options.category])
    .map((c) =>
      String(c ?? '')
        .trim()
        .toLowerCase()
    )
    .filter((c) => VALID_CATEGORY.has(c));
  // buildFilterClause: pushes ts/status/scope filters INTO candidate SELECTs.
  // offset = 1-based index of the first bind param it may consume.
  // Returns { clause: string, params: any[] }; clause begins with AND or is ''.
  function buildFilterClause(offset, opts = {}) {
    return buildRecallScopeFilter(
      offset,
      {
        // skipTsWindow must fully DROP the ts predicate for member-hit roots
        // (their own ts can sit outside the window; the member ts was already
        // gated). Pass `undefined`, not `null`: buildRecallScopeFilter coerces
        // its ts inputs via Number(x), and Number(null) === 0 (finite) would
        // inject `ts BETWEEN 0 AND 0`, silently dropping every member-hit root.
        // Number(undefined) === NaN, which the finite-check correctly skips.
        ts_from: opts.skipTsWindow ? undefined : tsFrom,
        ts_to: opts.skipTsWindow ? undefined : tsTo,
        excludeStatuses,
        category: categories,
        projectScope,
      },
      opts.tableAlias || ''
    );
  }

  // Kept for the non-candidate root-lookup inside the member-hit resolution path.
  function buildScopeClause(offset) {
    const { clause, params } = projectScopePredicate(projectScope, offset);
    return { clause: clause ? `AND ${clause}` : '', params };
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

  const vecSql =
    Array.isArray(options.queryVector) && options.queryVector.length > 0 ? embeddingToSql(options.queryVector) : null;

  // Use the model-free Korean normalizer with to_tsquery ':*' prefix matches.
  // ftsPrefixMode drives which tsquery constructor the sparse CTE uses.
  const ftsPrefix = clean.length >= 3 ? buildFtsPrefixQuery(clean) : null;
  const ftsQuery = ftsPrefix ? ftsPrefix.query : clean.length >= 3 ? (buildFtsQuery(clean) ?? null) : null;
  const ftsPrefixMode = Boolean(ftsPrefix);
  const exactTerms = buildExactTerms(clean);
  // Candidate generation is recall-oriented: one concept may be the only
  // distinctive event identifier in a natural-language question. Precision is
  // enforced after retrieval through semantic support, token coverage, and
  // candidate-local document frequency rather than by requiring several query
  // concepts to co-occur before the row can even be scored.
  const minExactHits = 1;

  // Each CTE leg uses the same positional filters against the history table.
  const { clause: filterClause, params: filterParams } = buildFilterClause(5);
  const entryRootFilter = rootOnly ? 'AND is_root = 1' : '';
  const exactRootFilter = rootOnly ? 'AND ee.is_root = 1' : '';

  const recallScopeOpts = {
    ts_from: tsFrom,
    ts_to: tsTo,
    excludeStatuses,
    category: categories,
    projectScope,
  };
  const exactTermsParam = 5 + filterParams.length;
  const exactFilterClause = buildRecallScopeFilter(5, recallScopeOpts, 'ee').clause;
  const bindParams = [
    vecSql,
    ftsQuery,
    clean,
    candidateWindow,
    ...filterParams,
    ...(exactTerms.length > 0 ? [exactTerms] : []),
  ];

  // dense CTE: active only when a query vector is supplied.
  const denseCte = vecSql
    ? `
dense AS (
  SELECT id,
         1 - (embedding <=> $1::halfvec) AS sim,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $1::halfvec) AS dense_rank
  FROM entries
  WHERE embedding IS NOT NULL
    ${filterClause}
    ${entryRootFilter}
  ORDER BY embedding <=> $1::halfvec
  LIMIT $4
),`
    : `
dense AS (SELECT NULL::bigint AS id, NULL::float8 AS sim, NULL::bigint AS dense_rank WHERE $1::halfvec IS NOT NULL AND false),`;

  // sparse CTE: active only when ftsQuery is non-null.
  // tsqExpr: to_tsquery for normalized prefix terms ('stem:* & ...'), else
  // websearch_to_tsquery for a plain fallback token string. Both parse $2 under
  // the 'simple' config to match search_tsv's simple-config lexemes.
  const tsqExpr = ftsPrefixMode ? `to_tsquery('simple', $2)` : `websearch_to_tsquery('simple', $2)`;
  const sparseCte = ftsQuery
    ? `
sparse AS (
  SELECT id,
         ts_rank_cd(search_tsv, ${tsqExpr}) AS lex,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_tsv, ${tsqExpr}) DESC) AS sparse_rank
  FROM entries
  WHERE search_tsv @@ ${tsqExpr}
    ${filterClause}
    ${entryRootFilter}
  ORDER BY lex DESC
  LIMIT $4
),`
    : `
sparse AS (SELECT NULL::bigint AS id, NULL::float8 AS lex, NULL::bigint AS sparse_rank WHERE $2::text IS NOT NULL AND false),`;

  // Portable substring leg. The curated Unix PG runtimes include pgvector but
  // not the optional pg_trgm contrib extension, so fuzzy similarity cannot be
  // a startup/runtime requirement. FTS and dense vector search retain broad
  // matching while this leg gives exact substrings a deterministic rescue.
  const trgmCte = `
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
    ${filterClause}
    ${entryRootFilter}
    ${lexScanBound()}
  ORDER BY ts DESC
  LIMIT $4
),`;

  const exactCte =
    exactTerms.length > 0
      ? `
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
    ${exactFilterClause}
    ${exactRootFilter}
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
  HAVING COUNT(*) >= ${minExactHits}
  ORDER BY exact_rarity DESC, exact_hits DESC, MAX(ts) DESC
  LIMIT $4
),`
      : `
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

  let rawRows = [];
  const conceptExpandedRootIds = new Set();
  let denseCount = 0;
  let sparseCount = 0;
  let trgmCount = 0;
  let exactCount = 0;

  try {
    const { rows } = await recallReadQuery(db, hybridSql, bindParams);
    rawRows = rows;
    // Count how many rows each leg contributed (a row may appear in multiple legs).
    for (const r of rawRows) {
      if (r.dense_rank != null) denseCount++;
      if (r.sparse_rank != null) sparseCount++;
      if (r.trgm_rank != null) trgmCount++;
      if (r.exact_rank != null) exactCount++;
    }
  } catch (err) {
    // A failing hybrid CTE is a DB/schema fault. Returning [] rendered it to the
    // caller as "no memory found", so a broken index or a migration gap looked
    // like an empty store instead of an error.
    __mixdogMemoryLog(`[recall] hybrid CTE failed: ${err.message}\n`);
    throw err;
  }

  if (rawRows.length === 0) return [];
  if (options.latestByConcept === true) {
    const candidateRootIds = [
      ...new Set(
        rawRows
          .map((row) => (Number(row.is_root) === 1 ? Number(row.id) : Number(row.chunk_root)))
          .filter(Number.isFinite)
      ),
    ];
    if (candidateRootIds.length > 0) {
      const relations = await recallReadQuery(
        db,
        `
        WITH roots AS (
          SELECT id, concept_id FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 1
        )
        SELECT r.id AS root_id, ec.concept_id
        FROM roots r
        JOIN entry_concepts ec ON ec.entry_id = r.id
        UNION
        SELECT r.id AS root_id, r.id AS concept_id FROM roots r
        UNION
        SELECT r.id AS root_id, r.concept_id FROM roots r WHERE r.concept_id IS NOT NULL
      `,
        [candidateRootIds]
      );
      const conceptIdsByRoot = new Map();
      for (const relation of relations.rows) {
        const rootId = Number(relation.root_id);
        const conceptId = Number(relation.concept_id);
        if (!Number.isFinite(rootId) || !Number.isFinite(conceptId)) continue;
        if (!conceptIdsByRoot.has(rootId)) conceptIdsByRoot.set(rootId, []);
        conceptIdsByRoot.get(rootId).push(conceptId);
      }
      const anchorStrength = (row) => recallRrfScore(row);
      const anchorByConcept = new Map();
      for (const row of rawRows) {
        const rootId = Number(row.is_root) === 1 ? Number(row.id) : Number(row.chunk_root);
        for (const conceptId of conceptIdsByRoot.get(rootId) ?? []) {
          const prior = anchorByConcept.get(conceptId);
          if (!prior || anchorStrength(row) > anchorStrength(prior)) anchorByConcept.set(conceptId, row);
        }
      }
      const conceptIds = [...anchorByConcept.keys()];
      if (conceptIds.length > 0) {
        const { clause: latestFilter, params: latestParams } = buildFilterClause(2, {
          skipTsWindow: true,
          tableAlias: 'e',
        });
        const latest = await recallReadQuery(
          db,
          `
          SELECT DISTINCT ON (ec.concept_id)
                 ec.concept_id AS matched_concept_id,
                 e.id, e.ts, e.role, e.content, e.source_ref, e.session_id,
                 e.source_turn, e.time_source, e.chunk_root, e.is_root,
                 e.concept_id, e.supersedes_id, e.element, e.category,
                 e.summary, e.project_id, e.status, e.score, e.last_seen_at
          FROM entry_concepts ec
          JOIN entries e ON e.id = ec.entry_id
          WHERE ec.concept_id = ANY($1::bigint[])
            AND e.is_root = 1
            ${latestFilter}
          ORDER BY ec.concept_id, e.ts DESC, e.id DESC
        `,
          [conceptIds, ...latestParams]
        );
        const merged = new Map(rawRows.map((row) => [Number(row.id), row]));
        const rankKeys = ['dense_rank', 'sparse_rank', 'trgm_rank', 'exact_rank'];
        const maxKeys = ['dense_sim', 'sparse_lex', 'trg_sim', 'exact_hits', 'exact_phrase_hits', 'exact_rarity'];
        for (const latestRow of latest.rows) {
          const anchor = anchorByConcept.get(Number(latestRow.matched_concept_id));
          if (!anchor) continue;
          const inherited = { ...latestRow };
          const anchorRootId = Number(anchor.is_root) === 1 ? Number(anchor.id) : Number(anchor.chunk_root);
          const carriesLatestConclusion = latestRow.supersedes_id != null || Number(latestRow.id) !== anchorRootId;
          inherited._conceptExpanded = carriesLatestConclusion;
          if (carriesLatestConclusion) conceptExpandedRootIds.add(Number(latestRow.id));
          for (const key of [...rankKeys, ...maxKeys]) inherited[key] = anchor[key];
          const existing = merged.get(Number(latestRow.id));
          if (existing) {
            for (const key of rankKeys) {
              const values = [existing[key], inherited[key]].filter((value) => value != null).map(Number);
              inherited[key] = values.length > 0 ? Math.min(...values) : null;
            }
            for (const key of maxKeys) {
              const values = [existing[key], inherited[key]].filter((value) => value != null).map(Number);
              inherited[key] = values.length > 0 ? Math.max(...values) : null;
            }
          }
          merged.set(Number(latestRow.id), inherited);
        }
        rawRows = [...merged.values()];
      }
    }
  }

  // Fixed equal-weight RRF: one dense lane and one lexical lane. The lexical
  // generators only expand candidate coverage; matching several of them does
  // not multiply lexical weight. No positive similarity threshold, query
  // branch, manual boost, or freshness multiplier changes the fused score;
  // non-finite/non-positive dense-only candidates carry no semantic evidence.
  const filtered = rankRecallCandidates(rawRows);
  if (filtered.length === 0) return [];

  // ── Root resolution + member-hit write-back ───────────────────────────────
  const byId = new Map(rawRows.map((r) => [Number(r.id), r]));
  const memberHitRootIds = new Set();
  const rootIdsForReturn = [];
  const seen = new Set();

  // Batch-resolve member-chunk roots in ONE query (was an N+1: a per-row SELECT
  // inside the loop below). Collect the distinct in-scope chunk_root ids, fetch
  // all matching roots at once, then resolve each member from rootById.
  const memberRootIds = [];
  const memberRootSeen = new Set();
  // Matched member ids grouped by their chunk root. A member-hit root is a
  // grouping artifact surfaced because a SPECIFIC turn matched; rendering its
  // full sibling set floods precision-sensitive queries (the negative-keyword
  // bench case) with turns that never mention the term. Attach only the
  // matched turns for such roots (see membersByRoot filtering below); roots
  // matched on their own row keep full chunk expansion for context.
  const matchedMembersByRoot = new Map();
  for (const { id } of filtered) {
    const r0 = byId.get(id);
    if (!r0 || r0.is_root === 1) continue;
    if (r0.chunk_root != null && r0.chunk_root !== r0.id) {
      const rid = Number(r0.chunk_root);
      if (!memberRootSeen.has(rid)) {
        memberRootSeen.add(rid);
        memberRootIds.push(rid);
      }
      if (!matchedMembersByRoot.has(rid)) matchedMembersByRoot.set(rid, new Set());
      matchedMembersByRoot.get(rid).add(Number(r0.id));
    }
  }
  const rootById = new Map();
  if (memberRootIds.length > 0) {
    const { clause: rootScopeClause, params: rootScopeParams } = buildScopeClause(2);
    const { rows: rootRows } = await recallReadQuery(
      db,
      `SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
              concept_id, supersedes_id, element, category, summary, project_id, status, score, last_seen_at
       FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 1 ${rootScopeClause}`,
      [memberRootIds, ...rootScopeParams]
    );
    for (const rr of rootRows) rootById.set(Number(rr.id), rr);
  }

  for (const { id, rrf, retrievalScore } of filtered) {
    const row = byId.get(id);
    if (!row) continue;
    let targetRow = null;
    if (row.is_root === 1) {
      targetRow = row;
    } else if (row.chunk_root != null && row.chunk_root !== row.id) {
      const r = rootById.get(Number(row.chunk_root));
      if (!r) continue;
      // Time-filter on the MEMBER's own ts before resolving to the root. A
      // member match that falls inside the requested [ts_from, ts_to] window
      // was previously dropped when its ROOT's ts sat outside the window (the
      // final fetch filters on root ts). Gate the member here on its own ts so
      // in-window member hits survive root resolution.
      if (!memberTsInWindow(row, tsFrom, tsTo)) continue;
      memberHitRootIds.add(r.id);
      targetRow = r;
    } else {
      targetRow = row;
    }
    if (seen.has(targetRow.id)) continue;
    seen.add(targetRow.id);
    const { denseRank, lexicalRank } = recallLaneRanks(row);
    rootIdsForReturn.push({
      root: targetRow,
      rrf,
      retrievalScore,
      retrievalEvidence: lexicalRank != null ? 'lexical' : denseRank != null ? 'semantic' : 'none',
      retrievalRank: rootIdsForReturn.length + 1,
      conceptExpanded:
        conceptExpandedRootIds.has(Number(targetRow.id)) ||
        (options.latestByConcept === true && targetRow.supersedes_id != null),
    });
  }

  // Recall is a read. The member-hit write-back that used to run here bumped
  // last_seen_at, which feeds the stored score/freshness ranking — so merely
  // searching reordered later results. Removed outright: every caller already
  // passed writeBackMemberHits: false.

  // ── Final fetch: full row for each root by id = ANY(bigint[]) ────────────
  const topIds = rootIdsForReturn.map((x) => Number(x.root.id));
  // Roots reached via an in-window MEMBER hit must NOT be re-dropped by the
  // final ts window filter: the root's own ts can legitimately sit outside the
  // window even though a member matched inside it (member ts already gated
  // above). Fetch member-hit roots with a status/scope-only filter (no ts
  // window); fetch the rest with the full window filter; merge.
  const memberHitExemptIds = [...memberHitRootIds].map(Number);
  let finalRows;
  if (memberHitExemptIds.length > 0) {
    const exemptSet = new Set(memberHitExemptIds);
    const nonExempt = topIds.filter((id) => !exemptSet.has(id));
    // Window+status filter for non-member-hit roots.
    const { clause: winFilter, params: winParams } = buildFilterClause(2);
    // Status/scope-only filter (no ts window) for member-hit roots.
    const { clause: statusFilter, params: statusParams } = buildFilterClause(2, { skipTsWindow: true });
    const [a, b] = await Promise.all([
      nonExempt.length > 0
        ? recallReadQuery(
            db,
            `SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
                    concept_id, supersedes_id, element, category, summary, project_id, status, score, last_seen_at, duplicate_of
             FROM entries WHERE id = ANY($1::bigint[]) ${winFilter}`,
            [nonExempt, ...winParams]
          )
        : Promise.resolve({ rows: [] }),
      recallReadQuery(
        db,
        `SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
                concept_id, supersedes_id, element, category, summary, project_id, status, score, last_seen_at, duplicate_of
         FROM entries WHERE id = ANY($1::bigint[]) ${statusFilter}`,
        [memberHitExemptIds, ...statusParams]
      ),
    ]);
    finalRows = [...a.rows, ...b.rows];
  } else {
    const { clause: winFilter, params: winParams } = buildFilterClause(2);
    const r = await recallReadQuery(
      db,
      `SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
              concept_id, supersedes_id, element, category, summary, project_id, status, score, last_seen_at, duplicate_of
       FROM entries WHERE id = ANY($1::bigint[]) ${winFilter}`,
      [topIds, ...winParams]
    );
    finalRows = r.rows;
  }
  let resolvedFinalRows = finalRows;
  if (options.latestByConcept === true && finalRows.length > 0) {
    const rootIds = finalRows
      .filter((row) => Number(row.is_root) === 1)
      .map((row) => Number(row.id))
      .filter(Number.isFinite);
    const relationResult =
      rootIds.length > 0
        ? await recallReadQuery(
            db,
            `
          SELECT entry_id, array_agg(concept_id ORDER BY concept_id) AS concept_ids
          FROM entry_concepts
          WHERE entry_id = ANY($1::bigint[])
          GROUP BY entry_id
        `,
            [rootIds]
          )
        : { rows: [] };
    const relationConcepts = new Map(
      relationResult.rows.map((row) => [
        Number(row.entry_id),
        (row.concept_ids ?? []).map(Number).filter(Number.isFinite),
      ])
    );
    finalRows = finalRows.map((row) => {
      const conceptIds = relationConcepts.get(Number(row.id));
      return conceptIds?.length ? { ...row, concept_ids: conceptIds } : row;
    });
    const conceptIds = [
      ...new Set(
        finalRows
          .filter((row) => Number(row.is_root) === 1)
          .flatMap((row) => (row.concept_ids?.length ? row.concept_ids : [Number(row.concept_id ?? row.id)]))
          .filter(Number.isFinite)
      ),
    ];
    if (conceptIds.length > 0) {
      const { clause: latestFilter, params: latestParams } = buildFilterClause(2, {
        skipTsWindow: true,
        tableAlias: 'e',
      });
      const latestResult = await recallReadQuery(
        db,
        `
        WITH candidates AS (
          SELECT ec.concept_id AS matched_concept_id,
                 e.id, e.ts, e.role, e.content, e.source_ref, e.session_id,
                 e.source_turn, e.time_source, e.chunk_root, e.is_root,
                 e.concept_id, e.supersedes_id, e.element, e.category,
                 e.summary, e.project_id, e.status, e.score, e.last_seen_at
          FROM entry_concepts ec
          JOIN entries e ON e.id = ec.entry_id
          WHERE ec.concept_id = ANY($1::bigint[])
            AND e.is_root = 1
            ${latestFilter}
          UNION ALL
          SELECT COALESCE(e.concept_id, e.id) AS matched_concept_id,
                 e.id, e.ts, e.role, e.content, e.source_ref, e.session_id,
                 e.source_turn, e.time_source, e.chunk_root, e.is_root,
                 e.concept_id, e.supersedes_id, e.element, e.category,
                 e.summary, e.project_id, e.status, e.score, e.last_seen_at
          FROM entries e
          WHERE e.is_root = 1
            AND COALESCE(e.concept_id, e.id) = ANY($1::bigint[])
            ${latestFilter}
        )
        SELECT DISTINCT ON (matched_concept_id) *
        FROM candidates
        ORDER BY matched_concept_id, ts DESC, id DESC
      `,
        [conceptIds, ...latestParams]
      );
      resolvedFinalRows = preferLatestConceptRows(finalRows, latestResult.rows);
    }
  }
  const finalById = new Map(finalRows.map((row, index) => [Number(row.id), resolvedFinalRows[index]]));

  const results = [];
  const emittedRootIds = new Set();
  for (const { root, rrf, retrievalScore, retrievalRank, retrievalEvidence, conceptExpanded } of rootIdsForReturn) {
    // Roots absent from finalById were excluded by the status/time filter on
    // the final fetch; falling back to the unfiltered `root` would leak
    // archived / out-of-window rows via member-hit resolution.
    const finalRoot = finalById.get(Number(root.id));
    if (!finalRoot) continue;
    if (emittedRootIds.has(Number(finalRoot.id))) continue;
    emittedRootIds.add(Number(finalRoot.id));
    const out = { ...finalRoot, rrf, retrievalScore, retrievalRank };
    out._retrievalEvidence = retrievalEvidence;
    if (conceptExpanded || (options.latestByConcept === true && finalRoot.supersedes_id != null)) {
      out._conceptExpanded = true;
    }
    results.push(out);
  }

  // The existing bounded retrieval pool, not the requested output size, owns
  // candidate collection. Apply scope/time resolution and duplicate collapse
  // before the output limit so duplicates cannot consume distinct-result slots.
  const page = collapseHistoryDuplicates(results).slice(0, limit);
  if (includeMembers) {
    const rootIds = page.filter((row) => row.is_root === 1).map((row) => Number(row.id));
    if (rootIds.length > 0) {
      // Expand only the final page, not every candidate considered above.
      const { rows: memberRows } = await recallReadQuery(
        db,
        `SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, project_id, chunk_root
         FROM entries WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
         ORDER BY ts ASC, id ASC`,
        [rootIds]
      );
      const membersByRoot = new Map();
      for (const member of memberRows) {
        const id = Number(member.chunk_root);
        if (!membersByRoot.has(id)) membersByRoot.set(id, []);
        membersByRoot.get(id).push(member);
      }
      for (const row of page) {
        if (row.is_root !== 1) continue;
        const allMembers = membersByRoot.get(Number(row.id)) ?? [];
        const matched = matchedMembersByRoot.get(Number(row.id));
        // Preserve complete matched turns, without flooding a member hit with
        // unrelated siblings. Root hits keep their full original expansion.
        const kept = matched?.size ? allMembers.filter((member) => matched.has(Number(member.id))) : [];
        row.members = kept.length > 0 ? kept : allMembers;
      }
    }
  }

  __mixdogMemoryLog(
    `[recall] dense=${denseCount} sparse=${sparseCount} trgm=${trgmCount} exact=${exactCount} merged=${page.length}\n`
  );

  return page;
}

export function preferLatestConceptRows(rows, latestRows) {
  const latestByConcept = new Map();
  for (const row of latestRows ?? []) {
    const conceptId = Number(row?.matched_concept_id ?? row?.concept_id ?? row?.id);
    if (Number.isFinite(conceptId) && !latestByConcept.has(conceptId)) {
      latestByConcept.set(conceptId, row);
    }
  }
  return (rows ?? []).map((row) => {
    const conceptIds = row?.concept_ids?.length
      ? row.concept_ids.map(Number).filter(Number.isFinite)
      : [Number(row?.concept_id ?? row?.id)].filter(Number.isFinite);
    let best = row;
    for (const conceptId of conceptIds) {
      const candidate = latestByConcept.get(conceptId);
      if (!candidate) continue;
      const newer =
        Number(candidate.ts ?? 0) > Number(best?.ts ?? 0) ||
        (Number(candidate.ts ?? 0) === Number(best?.ts ?? 0) && Number(candidate.id ?? 0) > Number(best?.id ?? 0));
      if (newer) best = candidate;
    }
    return best;
  });
}
