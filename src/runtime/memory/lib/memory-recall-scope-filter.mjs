import { VALID_CATEGORY } from './memory-categories.mjs';

export { VALID_CATEGORY };

// Shared project-scope SQL: common → NULL-only; slug → NULL or that slug; all/empty → no filter.
export function projectScopePredicate(projectScope, nextParam, { column = 'project_id' } = {}) {
  if (projectScope === 'common') {
    return { clause: `${column} IS NULL`, params: [] };
  }
  if (projectScope && projectScope !== 'all') {
    return {
      clause: `(${column} IS NULL OR ${column} = $${nextParam})`,
      params: [projectScope],
    };
  }
  return { clause: '', params: [] };
}

export function appendProjectScopeClause(clauses, params, projectScope, { column = 'project_id' } = {}) {
  const { clause, params: extra } = projectScopePredicate(projectScope, params.length + 1, { column });
  if (!clause) return;
  clauses.push(clause);
  params.push(...extra);
}

function buildCategoryFilterClause(offset, categories, { tableAlias = '' } = {}) {
  const cats = (Array.isArray(categories) ? categories : [categories])
    .map((c) =>
      String(c ?? '')
        .trim()
        .toLowerCase()
    )
    .filter((c) => VALID_CATEGORY.has(c));
  if (cats.length === 0) return { clause: '', params: [] };
  const outerRef = tableAlias || 'entries';
  const p = `${outerRef}.`;
  const ph = cats.map((_, i) => `$${offset + i}`).join(', ');
  const inner = `(
    (${p}is_root = 1 AND ${p}category IN (${ph}))
    OR (${p}is_root = 0 AND ${p}chunk_root IS NOT NULL AND ${p}chunk_root <> ${p}id AND EXISTS (
      SELECT 1 FROM entries r WHERE r.id = ${p}chunk_root AND r.is_root = 1 AND r.category IN (${ph})
    ))
    OR (${p}is_root = 0 AND (${p}chunk_root IS NULL OR ${p}chunk_root = ${p}id) AND ${p}category IN (${ph}))
  )`;
  return { clause: `AND (${inner})`, params: [...cats] };
}

export function buildRecallScopeFilter(offset, options = {}, tableAlias = '') {
  const outerRef = tableAlias || 'entries';
  const p = `${outerRef}.`;
  const clauses = [
    `NOT (${p}is_root = 0 AND ${p}chunk_root IS NOT DISTINCT FROM ${p}id AND ${p}status IS NOT DISTINCT FROM 'archived')`,
  ];
  const params = [];
  let next = offset;
  // Treat null AND undefined as "no bound". Number(null) === 0 (finite), so a
  // caller forwarding a null ts bound would otherwise inject `ts >= 0` /
  // `ts <= 0` — the latter silently drops every row (epoch-ms ts > 0). Callers
  // pass null for "absent" throughout the recall path; never coerce it to 0.
  const finiteBound = (value) => {
    if (value == null) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const tsFrom = finiteBound(options.ts_from);
  const tsTo = finiteBound(options.ts_to);
  if (tsFrom != null) {
    clauses.push(`${p}ts >= $${next++}`);
    params.push(tsFrom);
  }
  if (tsTo != null) {
    clauses.push(`${p}ts <= $${next++}`);
    params.push(tsTo);
  }
  const excludeStatuses = Array.isArray(options.excludeStatuses)
    ? options.excludeStatuses.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().toLowerCase())
    : [];
  if (excludeStatuses.length > 0) {
    const ph = excludeStatuses.map(() => `$${next++}`).join(', ');
    const statusPred = `(${p}status IS NULL OR ${p}status NOT IN (${ph}))`;
    clauses.push(`(
      (${p}is_root = 1 AND ${statusPred})
      OR (${p}is_root = 0 AND ${p}chunk_root IS NOT NULL AND ${p}chunk_root <> ${p}id AND EXISTS (
        SELECT 1 FROM entries r WHERE r.id = ${p}chunk_root AND r.is_root = 1
          AND (r.status IS NULL OR r.status NOT IN (${ph}))
      ))
      OR (${p}is_root = 0 AND (${p}chunk_root IS NULL OR ${p}chunk_root = ${p}id) AND ${statusPred})
    )`);
    params.push(...excludeStatuses);
  }
  const categories = (Array.isArray(options.category) ? options.category : [options.category])
    .map((c) =>
      String(c ?? '')
        .trim()
        .toLowerCase()
    )
    .filter((c) => VALID_CATEGORY.has(c));
  if (categories.length > 0) {
    const { clause: catClause, params: catParams } = buildCategoryFilterClause(next, categories, { tableAlias });
    if (catClause) {
      clauses.push(catClause.replace(/^AND /, ''));
      params.push(...catParams);
      next += catParams.length;
    }
  }
  const projectScope = typeof options.projectScope === 'string' ? options.projectScope : null;
  const { clause: scopeClause, params: scopeParams } = projectScopePredicate(projectScope, next, {
    column: `${p}project_id`,
  });
  if (scopeClause) {
    clauses.push(scopeClause);
    params.push(...scopeParams);
  }
  return { clause: clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '', params };
}
