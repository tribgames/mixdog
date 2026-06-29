// Pure, DB-free merge of session-fallback recall rows into the already-ranked
// global hybrid rows. Extracted into its own module so the starve-prevention +
// dedupe contract can be unit-tested without booting the memory worker (which
// has heavy top-level side effects: http server, pg, onnx embedding).
//
// Contract:
//   - APPEND session rows, never prepend. Blind prepend lets session rows
//     (limit+) starve the global first page and distorts sort/offset/limit.
//   - Re-apply the SAME sort policy as the global path so global hybrid hits
//     (carrying a real retrievalScore) keep their rank; session rows
//     (retrievalScore 0 under importance, ts-ordered under date) only fill
//     genuinely open slots.
//   - Dedupe drops any session row whose id already appears as a global row OR
//     as a global root's inlined chunk member (prevents member/leaf double
//     output).
export function mergeSessionRowsIntoGlobal(globalRows, sessionRows, { sort = 'importance' } = {}) {
  const filtered = Array.isArray(globalRows) ? [...globalRows] : []
  if (!Array.isArray(sessionRows) || sessionRows.length === 0) return filtered
  const seen = new Set(filtered.map(r => Number(r.id)))
  for (const r of filtered) {
    if (Array.isArray(r.members)) {
      for (const m of r.members) seen.add(Number(m.id))
    }
  }
  const merged = sessionRows.filter(r => !seen.has(Number(r.id)))
  if (merged.length === 0) return filtered
  const out = [...filtered, ...merged]
  const sa = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
  if (sort === 'date') {
    out.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
  } else {
    out.sort((a, b) => (sa(b.retrievalScore ?? b.rrf ?? 0) - sa(a.retrievalScore ?? a.rrf ?? 0))
      || (sa(b.score ?? 0) - sa(a.score ?? 0))
      || (sa(b.ts ?? 0) - sa(a.ts ?? 0))
      || (Number(a.id ?? 0) - Number(b.id ?? 0)))
  }
  return out
}
