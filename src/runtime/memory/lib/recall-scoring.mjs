// Candidate-text and scope helpers shared by the hybrid recall store.
import { tokenizeRecallQuery } from './memory-text-utils.mjs'
import { recallReadQuery } from './memory-recall-read-query.mjs'

const _MV_HOT_ACTIVE_TTL_MS = 60_000
const _mvHotActiveCache = new WeakMap() // db → { populated: boolean, ts: number }
// Member-hit time gate: a chunk MEMBER whose own ts falls inside the requested
// [ts_from, ts_to] window is an in-window match even when its ROOT's ts sits
// outside it. Returns true when the member ts is within the (open-ended) window.
export function memberTsInWindow(row, tsFrom, tsTo) {
  const ts = Number(row?.ts)
  if (!Number.isFinite(ts)) return true // undated member: don't drop on window
  if (tsFrom != null && ts < tsFrom) return false
  if (tsTo != null && ts > tsTo) return false
  return true
}
export function buildExactTerms(query) {
  const clean = String(query ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const terms = []
  const add = (value) => {
    const term = String(value ?? '').trim()
      .replace(/^[^\p{L}\p{N}_./:-]+|[^\p{L}\p{N}_./:-]+$/gu, '')
    if (!term) return
    const hasIdentifierShape = /[_./:-]/.test(term)
    // Numeric-only recall is rejected by searchRelevantHybrid before this
    // helper runs; numeric terms inside a mixed query carry command flags,
    // worker counts, versions, and other useful work identifiers.
    const symbolCount = Array.from(term).length
    if (!hasIdentifierShape && symbolCount < 2) return
    terms.push(term.slice(0, 80))
  }
  const tokens = tokenizeRecallQuery(clean, 12)
  // A long natural-language sentence appearing verbatim in memory is commonly
  // a quoted/repeated question. Keep full-text exactness for short lookups,
  // but let concept tokens and adjacent concept pairs represent longer
  // questions so query echoes do not outrank the event they refer to.
  if (tokens.length <= 2 && clean.length <= 80) add(clean)
  for (const token of tokens) add(token)
  for (let i = 0; i < tokens.length - 1; i++) {
    add(`${tokens[i]} ${tokens[i + 1]}`)
  }
  return [...new Set(terms.map(t => t.toLowerCase()))].slice(0, 12)
}

export async function _checkMvHotActivePopulated(db) {
  const cached = _mvHotActiveCache.get(db)
  const now = Date.now()
  if (cached && now - cached.ts < _MV_HOT_ACTIVE_TTL_MS) return cached.populated
  const r = await recallReadQuery(
    db,
    `SELECT relispopulated FROM pg_class WHERE relname = 'mv_hot_active' LIMIT 1`,
  )
  if (!r.rows?.length) throw new Error('mv_hot_active not found in pg_class')
  const populated = Boolean(r.rows[0].relispopulated)
  _mvHotActiveCache.set(db, { populated, ts: now })
  return populated
}
