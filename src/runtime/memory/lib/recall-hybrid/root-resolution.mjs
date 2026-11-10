/**
 * src/runtime/memory/lib/recall-hybrid/root-resolution.mjs - resolve ranked
 * candidates (roots and member chunks) to the root rows returned to the
 * caller, then fetch those roots with the final scope/time filter.
 */
import { recallReadQuery } from '../memory-recall-read-query.mjs';
import { recallLaneRanks } from '../recall-fusion.mjs';
import { memberTsInWindow } from '../recall-scoring.mjs';
import { ENTRY_ROW_COLUMNS, filterClause, scopeClause } from './plan.mjs';

const FINAL_ROW_COLUMNS = `${ENTRY_ROW_COLUMNS}, duplicate_of`;

// Distinct in-scope chunk roots of matched member rows, plus the matched
// member ids grouped by root. A member-hit root is a grouping artifact
// surfaced because a SPECIFIC turn matched; rendering its full sibling set
// floods precision-sensitive queries (the negative-keyword bench case) with
// turns that never mention the term, so the matched set is kept for member
// attachment later; roots matched on their own row keep full chunk expansion.
function collectMemberRoots(filtered, byId) {
  const memberRootIds = [];
  const matchedMembersByRoot = new Map();
  for (const { id } of filtered) {
    const r0 = byId.get(id);
    if (!r0 || r0.is_root === 1) continue;
    if (r0.chunk_root == null || r0.chunk_root === r0.id) continue;
    const rid = Number(r0.chunk_root);
    if (!matchedMembersByRoot.has(rid)) {
      memberRootIds.push(rid);
      matchedMembersByRoot.set(rid, new Set());
    }
    matchedMembersByRoot.get(rid).add(Number(r0.id));
  }
  return { memberRootIds, matchedMembersByRoot };
}

// Batch-resolve member-chunk roots in ONE query (was an N+1 per-row SELECT).
async function fetchRootsById(db, memberRootIds, plan) {
  const rootById = new Map();
  if (memberRootIds.length === 0) return rootById;
  const { clause: rootScopeClause, params: rootScopeParams } = scopeClause(plan, 2);
  const { rows } = await recallReadQuery(
    db,
    `SELECT ${ENTRY_ROW_COLUMNS}
       FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 1 ${rootScopeClause}`,
    [memberRootIds, ...rootScopeParams]
  );
  for (const rr of rows) rootById.set(Number(rr.id), rr);
  return rootById;
}

function retrievalEvidenceOf(row) {
  const { denseRank, lexicalRank } = recallLaneRanks(row);
  if (lexicalRank != null) return 'lexical';
  if (denseRank != null) return 'semantic';
  return 'none';
}

/**
 * Map ranked candidates to the roots to return, in rank order, resolving
 * member chunks through their root and gating members on their own ts.
 */
export async function resolveRoots(db, filtered, byId, plan, conceptExpandedRootIds) {
  const { memberRootIds, matchedMembersByRoot } = collectMemberRoots(filtered, byId);
  const rootById = await fetchRootsById(db, memberRootIds, plan);
  const memberHitRootIds = new Set();
  const rootIdsForReturn = [];
  const seen = new Set();
  for (const { id, rrf, retrievalScore } of filtered) {
    const row = byId.get(id);
    if (!row) continue;
    let targetRow = row;
    if (row.is_root !== 1 && row.chunk_root != null && row.chunk_root !== row.id) {
      const root = rootById.get(Number(row.chunk_root));
      if (!root) continue;
      // Time-filter on the MEMBER's own ts before resolving to the root. A
      // member match that falls inside the requested [ts_from, ts_to] window
      // was previously dropped when its ROOT's ts sat outside the window (the
      // final fetch filters on root ts). Gate the member here on its own ts so
      // in-window member hits survive root resolution.
      if (!memberTsInWindow(row, plan.tsFrom, plan.tsTo)) continue;
      memberHitRootIds.add(root.id);
      targetRow = root;
    }
    if (seen.has(targetRow.id)) continue;
    seen.add(targetRow.id);
    rootIdsForReturn.push({
      root: targetRow,
      rrf,
      retrievalScore,
      retrievalEvidence: retrievalEvidenceOf(row),
      retrievalRank: rootIdsForReturn.length + 1,
      conceptExpanded:
        conceptExpandedRootIds.has(Number(targetRow.id)) || (plan.latestByConcept && targetRow.supersedes_id != null),
    });
  }
  return { rootIdsForReturn, memberHitRootIds, matchedMembersByRoot };
}

function fetchFinalRowsFiltered(db, ids, filter) {
  if (ids.length === 0) return Promise.resolve({ rows: [] });
  return recallReadQuery(
    db,
    `SELECT ${FINAL_ROW_COLUMNS}
       FROM entries WHERE id = ANY($1::bigint[]) ${filter.clause}`,
    [ids, ...filter.params]
  );
}

/**
 * Final fetch: full row for each root. Roots reached via an in-window MEMBER
 * hit must NOT be re-dropped by the final ts window filter: the root's own ts
 * can legitimately sit outside the window even though a member matched inside
 * it (member ts already gated). Member-hit roots take a status/scope-only
 * filter; the rest take the full window filter.
 */
export async function fetchFinalRows(db, rootIdsForReturn, memberHitRootIds, plan) {
  const topIds = rootIdsForReturn.map((x) => Number(x.root.id));
  const memberHitExemptIds = [...memberHitRootIds].map(Number);
  const windowFilter = filterClause(plan, 2);
  if (memberHitExemptIds.length === 0) {
    const { rows } = await fetchFinalRowsFiltered(db, topIds, windowFilter);
    return rows;
  }
  const exemptSet = new Set(memberHitExemptIds);
  const nonExempt = topIds.filter((id) => !exemptSet.has(id));
  const [windowed, exempt] = await Promise.all([
    fetchFinalRowsFiltered(db, nonExempt, windowFilter),
    fetchFinalRowsFiltered(db, memberHitExemptIds, filterClause(plan, 2, { skipTsWindow: true })),
  ]);
  return [...windowed.rows, ...exempt.rows];
}
