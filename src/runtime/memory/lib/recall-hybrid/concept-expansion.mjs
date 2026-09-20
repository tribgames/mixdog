/**
 * src/runtime/memory/lib/recall-hybrid/concept-expansion.mjs - latestByConcept
 * mode: widen candidates to the newest root of every matched concept, and
 * swap final rows for the latest conclusion of their concept.
 */
import { recallReadQuery } from '../memory-recall-read-query.mjs';
import { recallRrfScore } from '../recall-fusion.mjs';
import { filterClause, rootIdOf } from './plan.mjs';

const RANK_KEYS = ['dense_rank', 'sparse_rank', 'trgm_rank', 'exact_rank'];
const MAX_KEYS = ['dense_sim', 'sparse_lex', 'trg_sim', 'exact_hits', 'exact_phrase_hits', 'exact_rarity'];

async function conceptIdsByRoot(db, candidateRootIds) {
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
  const byRoot = new Map();
  for (const relation of relations.rows) {
    const rootId = Number(relation.root_id);
    const conceptId = Number(relation.concept_id);
    if (!Number.isFinite(rootId) || !Number.isFinite(conceptId)) continue;
    if (!byRoot.has(rootId)) byRoot.set(rootId, []);
    byRoot.get(rootId).push(conceptId);
  }
  return byRoot;
}

// The strongest candidate per concept lends its lane evidence to the newest
// root of that concept.
function anchorsByConcept(rawRows, byRoot) {
  const anchors = new Map();
  for (const row of rawRows) {
    for (const conceptId of byRoot.get(rootIdOf(row)) ?? []) {
      const prior = anchors.get(conceptId);
      if (!prior || recallRrfScore(row) > recallRrfScore(prior)) anchors.set(conceptId, row);
    }
  }
  return anchors;
}

function inheritAnchorEvidence(latestRow, anchor, existing) {
  const inherited = { ...latestRow };
  for (const key of [...RANK_KEYS, ...MAX_KEYS]) inherited[key] = anchor[key];
  if (!existing) return inherited;
  for (const key of RANK_KEYS) {
    const values = [existing[key], inherited[key]].filter((value) => value != null).map(Number);
    inherited[key] = values.length > 0 ? Math.min(...values) : null;
  }
  for (const key of MAX_KEYS) {
    const values = [existing[key], inherited[key]].filter((value) => value != null).map(Number);
    inherited[key] = values.length > 0 ? Math.max(...values) : null;
  }
  return inherited;
}

/** Widen `rawRows` with the newest root of every matched concept. */
export async function expandLatestByConcept(db, rawRows, plan) {
  const conceptExpandedRootIds = new Set();
  const candidateRootIds = [...new Set(rawRows.map(rootIdOf).filter(Number.isFinite))];
  if (candidateRootIds.length === 0) return { rows: rawRows, conceptExpandedRootIds };
  const anchors = anchorsByConcept(rawRows, await conceptIdsByRoot(db, candidateRootIds));
  const conceptIds = [...anchors.keys()];
  if (conceptIds.length === 0) return { rows: rawRows, conceptExpandedRootIds };
  const { clause: latestFilter, params: latestParams } = filterClause(plan, 2, { skipTsWindow: true, tableAlias: 'e' });
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
  for (const latestRow of latest.rows) {
    const anchor = anchors.get(Number(latestRow.matched_concept_id));
    if (!anchor) continue;
    const carriesLatestConclusion = latestRow.supersedes_id != null || Number(latestRow.id) !== rootIdOf(anchor);
    if (carriesLatestConclusion) conceptExpandedRootIds.add(Number(latestRow.id));
    const inherited = inheritAnchorEvidence(latestRow, anchor, merged.get(Number(latestRow.id)));
    inherited._conceptExpanded = carriesLatestConclusion;
    merged.set(Number(latestRow.id), inherited);
  }
  return { rows: [...merged.values()], conceptExpandedRootIds };
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

async function conceptIdsForRoots(db, finalRows) {
  const rootIds = finalRows
    .filter((row) => Number(row.is_root) === 1)
    .map((row) => Number(row.id))
    .filter(Number.isFinite);
  if (rootIds.length === 0) return new Map();
  const relationResult = await recallReadQuery(
    db,
    `
          SELECT entry_id, array_agg(concept_id ORDER BY concept_id) AS concept_ids
          FROM entry_concepts
          WHERE entry_id = ANY($1::bigint[])
          GROUP BY entry_id
        `,
    [rootIds]
  );
  return new Map(
    relationResult.rows.map((row) => [
      Number(row.entry_id),
      (row.concept_ids ?? []).map(Number).filter(Number.isFinite),
    ])
  );
}

/**
 * Annotate final root rows with their concept ids and resolve each to the
 * latest root of its concept. Returns the annotated rows (index-aligned with
 * the input) and the resolved rows.
 */
export async function resolveLatestConceptRows(db, finalRows, plan) {
  const relationConcepts = await conceptIdsForRoots(db, finalRows);
  const annotated = finalRows.map((row) => {
    const conceptIds = relationConcepts.get(Number(row.id));
    return conceptIds?.length ? { ...row, concept_ids: conceptIds } : row;
  });
  const conceptIds = [
    ...new Set(
      annotated
        .filter((row) => Number(row.is_root) === 1)
        .flatMap((row) => (row.concept_ids?.length ? row.concept_ids : [Number(row.concept_id ?? row.id)]))
        .filter(Number.isFinite)
    ),
  ];
  if (conceptIds.length === 0) return { finalRows: annotated, resolvedFinalRows: annotated };
  const { clause: latestFilter, params: latestParams } = filterClause(plan, 2, { skipTsWindow: true, tableAlias: 'e' });
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
  return { finalRows: annotated, resolvedFinalRows: preferLatestConceptRows(annotated, latestResult.rows) };
}
