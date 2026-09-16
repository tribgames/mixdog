// Collapse only representatives present in the same filtered result set.
// Time-, session- and project-scoped history must not disappear merely because
// a duplicate exists elsewhere. Exact-id retrieval does not use this helper.
export function collapseHistoryDuplicates(rows) {
  const byId = new Map(rows.filter(row => row.is_root === 1).map(row => [Number(row.id), row]))
  return rows.filter(row => {
    if (row.is_root !== 1 || row.duplicate_of == null) return true
    const representative = byId.get(Number(row.duplicate_of))
    return !representative || representative.project_id !== row.project_id
  })
}
