import { VALID_CATEGORY } from './memory.mjs'

export function buildCategoryFilterClause(offset, categories, { tableAlias = '' } = {}) {
  const cats = (Array.isArray(categories) ? categories : [categories])
    .map(c => String(c ?? '').trim().toLowerCase())
    .filter(c => VALID_CATEGORY.has(c))
  if (cats.length === 0) return { clause: '', params: [] }
  const outerRef = tableAlias || 'entries'
  const p = `${outerRef}.`
  const ph = cats.map((_, i) => `$${offset + i}`).join(', ')
  const inner = `(
    (${p}is_root = 1 AND ${p}category IN (${ph}))
    OR (${p}is_root = 0 AND ${p}chunk_root IS NOT NULL AND ${p}chunk_root <> ${p}id AND EXISTS (
      SELECT 1 FROM entries r WHERE r.id = ${p}chunk_root AND r.is_root = 1 AND r.category IN (${ph})
    ))
    OR (${p}is_root = 0 AND (${p}chunk_root IS NULL OR ${p}chunk_root = ${p}id) AND ${p}category IN (${ph}))
  )`
  return { clause: `AND (${inner})`, params: [...cats] }
}

export function buildRecallScopeFilter(offset, options = {}, tableAlias = '') {
  const outerRef = tableAlias || 'entries'
  const p = `${outerRef}.`
  const clauses = [
    `NOT (${p}is_root = 0 AND ${p}chunk_root IS NOT DISTINCT FROM ${p}id AND ${p}status IS NOT DISTINCT FROM 'archived')`,
  ]
  const params = []
  let next = offset
  const tsFrom = Number.isFinite(Number(options.ts_from)) ? Number(options.ts_from) : null
  const tsTo = Number.isFinite(Number(options.ts_to)) ? Number(options.ts_to) : null
  if (tsFrom != null) { clauses.push(`${p}ts >= $${next++}`); params.push(tsFrom) }
  if (tsTo != null) { clauses.push(`${p}ts <= $${next++}`); params.push(tsTo) }
  const excludeStatuses = Array.isArray(options.excludeStatuses)
    ? options.excludeStatuses.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().toLowerCase())
    : []
  if (excludeStatuses.length > 0) {
    const ph = excludeStatuses.map(() => `$${next++}`).join(', ')
    const statusPred = `(${p}status IS NULL OR ${p}status NOT IN (${ph}))`
    clauses.push(`(
      (${p}is_root = 1 AND ${statusPred})
      OR (${p}is_root = 0 AND ${p}chunk_root IS NOT NULL AND ${p}chunk_root <> ${p}id AND EXISTS (
        SELECT 1 FROM entries r WHERE r.id = ${p}chunk_root AND r.is_root = 1
          AND (r.status IS NULL OR r.status NOT IN (${ph}))
      ))
      OR (${p}is_root = 0 AND (${p}chunk_root IS NULL OR ${p}chunk_root = ${p}id) AND ${statusPred})
    )`)
    params.push(...excludeStatuses)
  }
  const categories = (Array.isArray(options.category) ? options.category : [options.category])
    .map(c => String(c ?? '').trim().toLowerCase())
    .filter(c => VALID_CATEGORY.has(c))
  if (categories.length > 0) {
    const { clause: catClause, params: catParams } = buildCategoryFilterClause(next, categories, { tableAlias })
    if (catClause) { clauses.push(catClause.replace(/^AND /, '')); params.push(...catParams); next += catParams.length }
  }
  const projectScope = typeof options.projectScope === 'string' ? options.projectScope : null
  if (projectScope === 'common') clauses.push(`${p}project_id IS NULL`)
  else if (projectScope && projectScope !== 'all') {
    clauses.push(`(${p}project_id IS NULL OR ${p}project_id = $${next++})`)
    params.push(projectScope)
  }
  return { clause: clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '', params }
}