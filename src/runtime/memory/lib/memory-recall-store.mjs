/**
 * src/runtime/memory/lib/memory-recall-store.mjs - hybrid recall pipeline:
 * candidate CTE → optional concept expansion → RRF ranking → root resolution
 * → filtered final fetch → duplicate collapse → member attachment.
 */
import { __mixdogMemoryLog } from './memory-log.mjs';
import { recallReadQuery } from './memory-recall-read-query.mjs';
import { rankRecallCandidates } from './recall-fusion.mjs';
import { collapseHistoryDuplicates } from './history-duplicates.mjs';
import { recallPlan } from './recall-hybrid/plan.mjs';
import { buildHybridQuery, legCounts } from './recall-hybrid/hybrid-sql.mjs';
import { expandLatestByConcept, resolveLatestConceptRows } from './recall-hybrid/concept-expansion.mjs';
import { fetchFinalRows, resolveRoots } from './recall-hybrid/root-resolution.mjs';
import { attachMembers } from './recall-hybrid/members.mjs';

export { preferLatestConceptRows } from './recall-hybrid/concept-expansion.mjs';

async function fetchCandidates(db, plan) {
  const { sql, params } = buildHybridQuery(plan);
  try {
    const { rows } = await recallReadQuery(db, sql, params);
    return rows;
  } catch (err) {
    // A failing hybrid CTE is a DB/schema fault. Returning [] rendered it to the
    // caller as "no memory found", so a broken index or a migration gap looked
    // like an empty store instead of an error.
    __mixdogMemoryLog(`[recall] hybrid CTE failed: ${err.message}\n`);
    throw err;
  }
}

// Roots absent from the final fetch were excluded by its status/time filter;
// falling back to the unfiltered candidate row would leak archived /
// out-of-window rows via member-hit resolution.
function assembleResults(rootIdsForReturn, finalRows, resolvedFinalRows, plan) {
  const finalById = new Map(finalRows.map((row, index) => [Number(row.id), resolvedFinalRows[index]]));
  const results = [];
  const emittedRootIds = new Set();
  for (const { root, rrf, retrievalScore, retrievalRank, retrievalEvidence, conceptExpanded } of rootIdsForReturn) {
    const finalRoot = finalById.get(Number(root.id));
    if (!finalRoot) continue;
    if (emittedRootIds.has(Number(finalRoot.id))) continue;
    emittedRootIds.add(Number(finalRoot.id));
    const out = { ...finalRoot, rrf, retrievalScore, retrievalRank };
    out._retrievalEvidence = retrievalEvidence;
    if (conceptExpanded || (plan.latestByConcept && finalRoot.supersedes_id != null)) {
      out._conceptExpanded = true;
    }
    results.push(out);
  }
  return results;
}

export async function searchRelevantHybrid(db, query, options = {}) {
  const clean = String(query ?? '').trim();
  if (!clean) return [];
  // Numeric-only lookup is too broad for text recall ("1" matches nearly
  // everything through the short ILIKE path). Callers that know an entry id
  // should use recall's `id` mode instead of query search.
  if (/^\d+$/.test(clean)) return [];
  const plan = recallPlan(clean, options);

  let rawRows = await fetchCandidates(db, plan);
  const counts = legCounts(rawRows);
  if (rawRows.length === 0) return [];
  let conceptExpandedRootIds = new Set();
  if (plan.latestByConcept) {
    ({ rows: rawRows, conceptExpandedRootIds } = await expandLatestByConcept(db, rawRows, plan));
  }

  // Fixed equal-weight RRF: one dense lane and one lexical lane. The lexical
  // generators only expand candidate coverage; matching several of them does
  // not multiply lexical weight. No positive similarity threshold, query
  // branch, manual boost, or freshness multiplier changes the fused score;
  // non-finite/non-positive dense-only candidates carry no semantic evidence.
  const filtered = rankRecallCandidates(rawRows);
  if (filtered.length === 0) return [];

  const byId = new Map(rawRows.map((r) => [Number(r.id), r]));
  const { rootIdsForReturn, memberHitRootIds, matchedMembersByRoot } = await resolveRoots(
    db,
    filtered,
    byId,
    plan,
    conceptExpandedRootIds
  );
  // Recall is a read: no member-hit write-back (it bumped last_seen_at, which
  // feeds the stored score/freshness ranking, so merely searching reordered
  // later results).
  let finalRows = await fetchFinalRows(db, rootIdsForReturn, memberHitRootIds, plan);
  let resolvedFinalRows = finalRows;
  if (plan.latestByConcept && finalRows.length > 0) {
    ({ finalRows, resolvedFinalRows } = await resolveLatestConceptRows(db, finalRows, plan));
  }
  const results = assembleResults(rootIdsForReturn, finalRows, resolvedFinalRows, plan);

  // The existing bounded retrieval pool, not the requested output size, owns
  // candidate collection. Apply scope/time resolution and duplicate collapse
  // before the output limit so duplicates cannot consume distinct-result slots.
  const page = collapseHistoryDuplicates(results).slice(0, plan.limit);
  if (plan.includeMembers) await attachMembers(db, page, matchedMembersByRoot);

  __mixdogMemoryLog(
    `[recall] dense=${counts.dense} sparse=${counts.sparse} trgm=${counts.trgm} exact=${counts.exact} merged=${page.length}\n`
  );
  return page;
}
