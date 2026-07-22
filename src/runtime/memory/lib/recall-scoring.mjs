// Hybrid-recall scoring constants and pure helpers, extracted from memory-recall-store.mjs.
import { buildFtsQuery, buildFtsPrefixQuery } from './memory-text-utils.mjs'
import { VALID_CATEGORY, embeddingToSql } from './memory.mjs'
import { freshnessFactor } from './memory-score.mjs'
import { buildRecallScopeFilter } from './memory-recall-scope-filter.mjs'
import { recallReadQuery } from './memory-recall-read-query.mjs'

export const _MV_HOT_ACTIVE_TTL_MS = 60_000
export const _mvHotActiveCache = new WeakMap() // db → { populated: boolean, ts: number }
export const SEMANTIC_ONLY_MIN_SIM = 0.72
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
// Cross-language semantic rescue: a query in one language against rows in
// another rarely clears SEMANTIC_ONLY_MIN_SIM on a small (384-dim) embedding
// model, yet the TOP dense ranks are still overwhelmingly relevant. Accept
// semantic-only rows that are both top-ranked in the dense leg AND above a
// softer floor, instead of dropping everything below 0.72.
export const SEMANTIC_TOP_RANK_MAX = 3
// Floor for the top-rank rescue. 384-dim MiniLM-class embeddings put UNRELATED
// text at ~0.65-0.75 sim (measured: gibberish query "zzqqxx ... 999" scored
// 0.749 against real rows), so anything below ~0.70 is noise regardless of
// rank; cross-language relevant pairs measured 0.67-0.74. 0.70 keeps most of
// the cross-language rescue while rejecting pure-noise top ranks.
// The softer 0.70 floor SITS INSIDE the noise band (noise peaked at 0.749), so
// it only rescues rows that ALSO carry a lexical leg as corroboration. A
// semantic-only row (no sparse/trgm/exact) must clear SEMANTIC_TOP_RANK_STRICT_SIM
// instead — set above the measured 0.749 noise ceiling so unrelated top ranks
// (e.g. old narration surfacing for "embedding worker crash") stop leaking in.
export const SEMANTIC_TOP_RANK_MIN_SIM = 0.70
export const SEMANTIC_TOP_RANK_STRICT_SIM = 0.78
export const SHORT_QUERY_TOKEN_MAX = 2
// Dense-similarity weighting for retrievalScore. Lexical RRF sums 1/(K+rank)
// per matching leg (K=60), so a row hitting 2 lexical legs at rank 1 scores
// rrf ≈ 2/(60+1) = 0.0328 — enough to bury a single semantically-close dense
// hit that never shares lexical terms. We add a normalized dense-similarity
// term so a strong dense-only match can outrank stale multi-leg lexical hits:
//   denseTerm = W_DENSE * max(0, sim - SIM_FLOOR) / (1 - SIM_FLOOR) * freshness
// At sim=0.85: (0.85-0.60)/(1-0.60) = 0.625, so denseTerm = 0.04 * 0.625 = 0.025
// with freshness=1. That alone doesn't beat 0.0328, but combined with the
// row's own rrf contribution (a dense-only row still has 1/(60+rank) from its
// dense rank, e.g. rank 1 → 0.0164) the total ≈ 0.0164 + 0.025 = 0.0414,
// which clears the 0.0328 two-leg lexical baseline. W_DENSE=0.04 was chosen
// as the smallest round value satisfying this at sim=0.85; SIM_FLOOR=0.60
// matches the noise floor used elsewhere for MiniLM-class embeddings.
export const SIM_FLOOR = 0.60
export const W_DENSE = 0.04
// Recency nudge applied ONLY when a [ts_from, ts_to] window is active. Inside a
// fixed window absolute-age freshness is often disabled (applyFreshness=false)
// or too flat to separate early-window from late-window rows, so a 07-04 row
// could outrank a 07-05 row of comparable relevance under a 24h period. This
// term is a normalized position-in-window score (newest→1) scaled small enough
// to break comparable-relevance ties toward newer rows without overriding a
// clearly stronger lexical/semantic match.
// Kept below a single rank-1 RRF leg (~0.016) so it only breaks ties between
// comparable-relevance rows and never overrides a clearly stronger match.
export const W_WINDOW_RECENCY = 0.008
// Rare-token display boost. A query token that appears in the RENDERED display
// of only a small fraction of the candidate set (an IDF-style rarity signal) is
// strong evidence a row is genuinely about that term — even for a
// cross-language row whose only lexical tie is one distinctive English token
// (e.g. "embedding" inside otherwise-Korean content). We add a boost when such
// a rare token is present in the fields that actually render (element/summary
// for roots, content for member-hit turns), so a low-lexical row surfaces above
// common-token neighbours. Scoped to display fields so we never promote a row
// whose match hides in un-rendered body text. RARE_DF_MAX gates "rare": tokens
// present in >34% of candidates are common and earn nothing.
// Scaled to at most one rank-1 RRF leg (1/(K+1) ≈ 0.0164 at K=60): a rare
// display token is a genuine relevance signal, but the IDF boost should only
// carry the weight of a single extra retrieval-leg agreement — enough to break
// ties toward the distinctive-token row without overriding a clearly stronger
// multi-leg lexical/semantic match. W_RARE * (1 - df/N) peaks below this cap.
export const W_RARE = 0.016
export const RARE_DF_MAX = 0.34

// Lowercased, de-duplicated query tokens (>= 2 chars) for DF/boost/gate use.
// Capped at 12 (mirrors buildExactTerms) so a paragraph-length query can't
// turn the per-row DF scan into O(tokens × candidateWindow) on display text.
export function queryTokensLower(query) {
  const clean = String(query ?? '').replace(/\s+/g, ' ').trim()
  const toks = (clean.match(/[\p{L}\p{N}_./:-]+/gu) || [])
    .map(t => t.toLowerCase())
    .filter(t => Array.from(t).length >= 2)
  return [...new Set(toks)].slice(0, 12)
}

// The text that actually renders as a result LINE for a row: element+summary
// for a root (its members render on their own lines), plus content for a
// member-hit turn (its own content is the rendered line). Deliberately excludes
// a ROOT's body content, which never renders when the row is shown as a summary
// line — matching there is incidental, not topical.
export function rowDisplayText(row) {
  const base = `${row?.element ?? ''} ${row?.summary ?? ''}`
  const withBody = Number(row?.is_root) === 0 ? `${base} ${row?.content ?? ''}` : base
  return withBody.toLowerCase()
}

export function windowRecencyFactor(ts, tsFrom, tsTo, nowMs) {
  const t = Number(ts)
  if (!Number.isFinite(t)) return 0
  const hi = tsTo != null ? tsTo : nowMs
  const lo = tsFrom != null ? tsFrom : hi - 86_400_000 // default 24h span when open-started
  if (!(hi > lo)) return 0
  return Math.max(0, Math.min(1, (t - lo) / (hi - lo)))
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
    if (!hasIdentifierShape && /^[\d\s]+$/.test(term)) return
    const symbolCount = Array.from(term).length
    if (!hasIdentifierShape && symbolCount < 2) return
    terms.push(term.slice(0, 80))
  }
  if (clean.length <= 80) add(clean)
  const tokens = clean.match(/[\p{L}\p{N}_./:-]+/gu) || []
  for (const token of tokens) add(token)
  for (let i = 0; i < tokens.length - 1; i++) {
    add(`${tokens[i]} ${tokens[i + 1]}`)
  }
  return [...new Set(terms.map(t => t.toLowerCase()))].slice(0, 12)
}

export function countQueryTokens(query) {
  const clean = String(query ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return 0
  return (clean.match(/[\p{L}\p{N}_./:-]+/gu) || [])
    .filter(token => String(token ?? '').trim().length > 0)
    .length
}

export function hasFullQueryTextMatch(query, row) {
  const clean = String(query ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!clean || clean.length > 160) return false
  const element = String(row?.element ?? '').toLowerCase()
  const summary = String(row?.summary ?? '').toLowerCase()
  const content = String(row?.content ?? '').toLowerCase()
  return (element && element.includes(clean))
    || (summary && summary.includes(clean))
    || (content && content.includes(clean))
}

export function hasQueryTokenCoverage(row, queryTokenCount) {
  if (queryTokenCount <= SHORT_QUERY_TOKEN_MAX) return true
  const hits = Number(row?.exact_hits)
  // Majority coverage, not full coverage. Requiring EVERY query token to hit
  // made mixed-language queries (English "usage spike" plus a Korean noun for
  // "cause") return nothing when one
  // token has no lexical counterpart in the row — ~60% of tokens matching is
  // strong enough lexical evidence alongside the semantic leg.
  const required = Math.max(2, Math.ceil(queryTokenCount * 0.6))
  return Number.isFinite(hits) && hits >= required
}

export function exactTextBoost(query, row, exactHits) {
  const clean = String(query ?? '').trim().toLowerCase()
  if (!clean) return 0
  const element = String(row?.element ?? '').toLowerCase()
  const summary = String(row?.summary ?? '').toLowerCase()
  const content = String(row?.content ?? '').toLowerCase()
  let boost = 0
  if (element && element.includes(clean)) boost += 0.035
  if (summary && summary.includes(clean)) boost += 0.025
  if (content && content.includes(clean)) boost += 0.015
  const hits = Number(exactHits)
  if (Number.isFinite(hits) && hits > 0) boost += Math.min(0.03, hits * 0.008)
  return boost
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
