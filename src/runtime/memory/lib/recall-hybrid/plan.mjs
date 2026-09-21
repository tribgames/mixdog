/**
 * src/runtime/memory/lib/recall-hybrid/plan.mjs - normalized recall request:
 * paging, pre-filter knobs, and the shared SQL filter/scope clause builders
 * every stage of the hybrid search binds against.
 */
import { VALID_CATEGORY } from '../memory-categories.mjs';
import { buildRecallScopeFilter, projectScopePredicate } from '../memory-recall-scope-filter.mjs';

export const ENTRY_ROW_COLUMNS = `id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
              concept_id, supersedes_id, element, category, summary, project_id, status, score, last_seen_at`;

export function recallPlan(clean, options = {}) {
  const limit = Math.max(1, Math.floor(Number(options?.limit ?? 8)));
  const categories = (Array.isArray(options.category) ? options.category : [options.category])
    .map((c) =>
      String(c ?? '')
        .trim()
        .toLowerCase()
    )
    .filter((c) => VALID_CATEGORY.has(c));
  return {
    clean,
    limit,
    // Retrieval quality must not depend on the caller's display page size.
    // Work/event queries often have many same-topic progress rows; a limit=10
    // page still needs a broad pool so the final decision can outrank them.
    candidateWindow: Math.max(240, limit * 8),
    includeMembers: Boolean(options.includeMembers),
    rootOnly: options.rootOnly === true,
    latestByConcept: options.latestByConcept === true,
    queryVector: Array.isArray(options.queryVector) && options.queryVector.length > 0 ? options.queryVector : null,
    // Pre-filter knobs. Without them, FTS/vec rank the whole tree and a
    // post-filter time window can wipe the result set.
    tsFrom: Number.isFinite(Number(options.ts_from)) ? Number(options.ts_from) : null,
    tsTo: Number.isFinite(Number(options.ts_to)) ? Number(options.ts_to) : null,
    // All history is searchable by default. Legacy status filters are honored
    // only when explicitly requested; maintenance no longer assigns importance.
    excludeStatuses: Array.isArray(options.excludeStatuses)
      ? options.excludeStatuses.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toLowerCase())
      : [],
    // Project scope pre-filter applied to the candidate fetch SQL.
    // 'common' → project_id IS NULL; specific slug → project_id IS NULL OR = slug;
    // 'all' or undefined → no filter.
    projectScope: typeof options.projectScope === 'string' ? options.projectScope : null,
    categories,
  };
}

// Pushes ts/status/scope filters INTO candidate SELECTs. offset = 1-based
// index of the first bind param it may consume. Returns { clause, params };
// clause begins with AND or is ''.
export function filterClause(plan, offset, opts = {}) {
  return buildRecallScopeFilter(
    offset,
    {
      // skipTsWindow must fully DROP the ts predicate for member-hit roots
      // (their own ts can sit outside the window; the member ts was already
      // gated). Pass `undefined`, not `null`: buildRecallScopeFilter coerces
      // its ts inputs via Number(x), and Number(null) === 0 (finite) would
      // inject `ts BETWEEN 0 AND 0`, silently dropping every member-hit root.
      // Number(undefined) === NaN, which the finite-check correctly skips.
      ts_from: opts.skipTsWindow ? undefined : plan.tsFrom,
      ts_to: opts.skipTsWindow ? undefined : plan.tsTo,
      excludeStatuses: plan.excludeStatuses,
      category: plan.categories,
      projectScope: plan.projectScope,
    },
    opts.tableAlias || ''
  );
}

// Scope-only clause for the non-candidate root lookup in member-hit resolution.
export function scopeClause(plan, offset) {
  const { clause, params } = projectScopePredicate(plan.projectScope, offset);
  return { clause: clause ? `AND ${clause}` : '', params };
}

export function rootIdOf(row) {
  return Number(row.is_root) === 1 ? Number(row.id) : Number(row.chunk_root);
}
