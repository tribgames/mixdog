// Core-memory leg of a query recall: active core_entries whose element/summary
// contain the query terms, ranked by term hits then recency, shaped like
// entries rows (id `core:N`, ts, is_root) so they render alongside them.
import { coreRecallTerms, normalizeRecallProjectScope } from './recall-format.mjs';
import { appendProjectScopeClause } from './memory-recall-scope-filter.mjs';

const CORE_TS_EXPR = 'COALESCE(updated_at, created_at)';
const CORE_TEXT_EXPR = `lower(coalesce(element, '') || ' ' || coalesce(summary, ''))`;

function appendCategoryFilter(where, params, category) {
  if (category == null) return;
  const cats = (Array.isArray(category) ? category : [category])
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
  if (cats.length === 0) return;
  const placeholders = cats.map((cat) => {
    params.push(cat);
    return `$${params.length}`;
  });
  where.push(`category IN (${placeholders.join(', ')})`);
}

function appendTimeWindow(where, params, tsFrom, tsTo) {
  if (tsFrom != null && Number.isFinite(Number(tsFrom))) {
    params.push(Number(tsFrom));
    where.push(`${CORE_TS_EXPR} >= $${params.length}`);
  }
  if (tsTo != null && Number.isFinite(Number(tsTo))) {
    params.push(Number(tsTo));
    where.push(`${CORE_TS_EXPR} <= $${params.length}`);
  }
}

export async function recallCoreRows(db, query, { projectScope, category, limit, tsFrom, tsTo } = {}) {
  const terms = coreRecallTerms(query);
  if (terms.length === 0) return [];

  const params = [];
  const where = [];
  const scope = normalizeRecallProjectScope(projectScope);
  let scopeClause = scope;
  if (scope === null) scopeClause = 'common';
  else if (scope === '*') scopeClause = 'all';
  appendProjectScopeClause(where, params, scopeClause);
  appendCategoryFilter(where, params, category);
  appendTimeWindow(where, params, tsFrom, tsTo);

  const termClauses = terms.map((term) => {
    params.push(`%${term}%`);
    return `${CORE_TEXT_EXPR} LIKE $${params.length}`;
  });
  where.push(`(${termClauses.join(' OR ')})`);
  const hitExpr = termClauses.map((clause) => `CASE WHEN ${clause} THEN 1 ELSE 0 END`).join(' + ');
  const rowLimit = Math.max(1, Math.min(10, Number(limit) || 5));
  params.push(rowLimit);

  const rows = (
    await db.query(
      `
      SELECT id, element, summary, category, project_id, created_at, updated_at,
             (${hitExpr}) AS hit_count
      FROM core_entries
      WHERE ${where.join(' AND ')}
        AND (status IS NULL OR status = 'active')
      ORDER BY hit_count DESC, updated_at DESC, id ASC
      LIMIT $${params.length}
    `,
      params
    )
  ).rows;

  return rows.map((row) => ({
    ...row,
    id: `core:${row.id}`,
    ts: row.updated_at || row.created_at || Date.now(),
    is_root: 1,
  }));
}
