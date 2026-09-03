// memory-cycle3-guards.mjs — conservative-mode safety checks for cycle3.
//
// Cycle3 auto-applies only what it can prove is lossless or clear junk; every
// predicate here answers "may this verdict apply unattended?" and returns a
// { ok, reason } pair so the held/applied detail stays explainable.

import { embedText } from './embedding-provider.mjs'

export function normalizeComparable(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[|`"'“”‘’()[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function compactComparable(value) {
  return normalizeComparable(value).replace(/\s+/g, '')
}

// Character-trigram Dice coefficient over the compacted forms.
export function charDice(a, b) {
  const aa = compactComparable(a)
  const bb = compactComparable(b)
  if (!aa || !bb) return 0
  if (aa === bb) return 1
  if (aa.length < 3 || bb.length < 3) return 0
  const grams = (s) => {
    const m = new Map()
    for (let i = 0; i <= s.length - 3; i++) {
      const g = s.slice(i, i + 3)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const ga = grams(aa)
  const gb = grams(bb)
  let overlap = 0
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) || 0)
  const total = [...ga.values()].reduce((s, n) => s + n, 0) + [...gb.values()].reduce((s, n) => s + n, 0)
  return total > 0 ? (2 * overlap) / total : 0
}

export function coreText(core) {
  return `${core?.element || ''}\n${core?.summary || ''}`
}

export function hasSubstantialNonLatinScript(value) {
  const text = String(value ?? '')
  const letters = text.match(/\p{L}/gu) || []
  const latinLetters = letters.filter((letter) => /\p{Script=Latin}/u.test(letter))
  const nonLatinLetters = letters.length - latinLetters.length
  return nonLatinLetters >= 3 && nonLatinLetters >= letters.length * 0.3
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return null
  let dot = 0
  let aNorm = 0
  let bNorm = 0
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return null
    dot += a[i] * b[i]
    aNorm += a[i] ** 2
    bNorm += b[i] ** 2
  }
  if (aNorm === 0 || bNorm === 0) return null
  return dot / Math.sqrt(aNorm * bNorm)
}

export async function isSafeConservativeUpdate(current, action) {
  if (!current || !action?.element || !action?.summary) return { ok: false, reason: 'missing text' }
  const newElement = normalizeComparable(action.element)
  const newSummary = normalizeComparable(action.summary)
  if (!newElement || !newSummary) return { ok: false, reason: 'empty rewrite' }
  const oldText = coreText(current)
  const newText = `${action.element}\n${action.summary}`
  const oldLen = normalizeComparable(oldText).length
  const newLen = normalizeComparable(newText).length
  const sim = charDice(oldText, newText)
  const crossLanguageRewrite = sim < 0.28 && hasSubstantialNonLatinScript(oldText)
  if (!crossLanguageRewrite) {
    if (oldLen > 0 && newLen > oldLen + 20) return { ok: false, reason: 'rewrite expands entry' }
    if (sim < 0.28) return { ok: false, reason: `rewrite drift sim=${sim.toFixed(2)}` }
    return { ok: true, reason: 'safe compression' }
  }
  try {
    const [oldEmbedding, newEmbedding] = await Promise.all([embedText(oldText), embedText(newText)])
    const cosine = cosineSimilarity(oldEmbedding, newEmbedding)
    if (cosine == null) return { ok: false, reason: 'cross-language embedding invalid' }
    if (cosine < 0.6) return { ok: false, reason: `cross-language semantic drift cosine=${cosine.toFixed(2)}` }
    return { ok: true, reason: `safe cross-language rewrite cosine=${cosine.toFixed(2)}` }
  } catch (err) {
    return { ok: false, reason: `cross-language embedding failed: ${err?.message || 'unknown error'}` }
  }
}

export function findElementConflict(coreById, currentId, element, projectId) {
  const nextElement = String(element ?? '').trim()
  if (!nextElement) return null
  for (const [id, row] of coreById) {
    if (Number(id) === Number(currentId)) continue
    if ((row.project_id ?? null) !== (projectId ?? null)) continue
    if (String(row.element ?? '') === nextElement) return Number(id)
  }
  return null
}

export function isStrictDuplicate(a, b) {
  if (!a || !b) return false
  const ae = compactComparable(a.element)
  const be = compactComparable(b.element)
  const as = compactComparable(a.summary)
  const bs = compactComparable(b.summary)
  if (as && bs && as === bs) return true
  if (ae && be && ae === be && charDice(a.summary, b.summary) >= 0.65) return true
  return charDice(coreText(a), coreText(b)) >= 0.78
}

// ── Consolidation merges ─────────────────────────────────────────────────────
// A merge that carries a rewritten clause folds several same-subject entries
// into one. It may apply unattended only when nothing concrete is lost: every
// anchor token (path, command, identifier, flag, number, quoted phrase) from
// the target and every source must survive verbatim in the rewrite.

// A separator counts only when something follows it, so a sentence-final
// period or comma never turns a plain word into an "identifier".
const ANCHOR_TOKEN_RE = /[^\s|,;]*[\\/._:\-](?=[^\s|,;])[^\s|,;]*|\b[A-Za-z]*\d[\w-]*\b|\b[A-Z][A-Za-z0-9]*[A-Z][\w]*\b|\b[a-z]+[A-Z][\w]*\b/g
const QUOTED_RE = /["“”'‘’`]([^"“”'‘’`]{2,80})["“”'‘’`]/g
// Trim wrapping brackets/quotes and trailing sentence punctuation; a leading
// '-' or '--' (a flag) is deliberately kept.
const ANCHOR_STRIP_EDGE = /^[[({"'“”‘’`<]+|[\])}"'“”‘’`>.,;:!?]+$/gu
// Plain hyphenated English ("installed-app", "one-liner") is prose, not an
// identifier; a real anchor carries a digit, a non-hyphen separator, or a
// leading flag dash.
const PROSE_HYPHEN_RE = /^[a-z]+(-[a-z]+)+$/

export function extractAnchorTokens(text) {
  const src = String(text ?? '')
  const out = new Set()
  for (const m of src.matchAll(QUOTED_RE)) {
    const phrase = m[1].trim().toLowerCase()
    if (phrase) out.add(phrase)
  }
  for (const m of src.matchAll(ANCHOR_TOKEN_RE)) {
    const tok = String(m[0]).replace(ANCHOR_STRIP_EDGE, '').toLowerCase()
    // Ignore bare punctuation runs and sentence-level artefacts (e.g. "e.g.").
    if (tok.length < 2 || /^[\W_]+$/u.test(tok) || tok === 'e.g' || tok === 'i.e') continue
    if (PROSE_HYPHEN_RE.test(tok)) continue
    out.add(tok)
  }
  return out
}

// Anchors come from the summary (the rule body); the element is a headline
// whose wording legitimately changes when entries fold together.
export function isSafeConsolidation(target, sources, element, summary) {
  const newText = `${element ?? ''}\n${summary ?? ''}`
  if (!normalizeComparable(element) || !normalizeComparable(summary)) return { ok: false, reason: 'empty consolidated text' }
  const haystack = newText.toLowerCase()
  const missing = []
  for (const entry of [target, ...(sources ?? [])]) {
    for (const tok of extractAnchorTokens(entry?.summary)) {
      if (!haystack.includes(tok)) missing.push(tok)
    }
  }
  if (missing.length > 0) {
    return { ok: false, reason: `consolidation drops anchors: ${[...new Set(missing)].slice(0, 6).join(', ')}` }
  }
  // Consolidation may not balloon: the fold must stay shorter than the sum of
  // its parts, otherwise the LLM padded rather than compressed.
  const combinedLen = [target, ...(sources ?? [])]
    .reduce((n, e) => n + normalizeComparable(coreText(e)).length, 0)
  if (normalizeComparable(newText).length > combinedLen + 20) return { ok: false, reason: 'consolidation expands entries' }
  return { ok: true, reason: 'lossless consolidation' }
}

// ── Delete corroboration ─────────────────────────────────────────────────────
// Whitelisted delete reasons that conservative mode may auto-apply: a copy of
// a built-in/default rule, a bare restatement, an obsolete/already-implemented
// decision, or a past-event log. Anything else stays held for APPLY CYCLE3.
export const SAFE_DELETE_REASONS = new Set([
  'duplicate', 'dup', 'duplicate_of_default', 'default', 'redundant',
  'restatement', 'restate', 'restates_default',
  'obsolete', 'implemented', 'done', 'completed', 'resolved',
  'superseded_decision', 'stale', 'past_event', 'event_log', 'log',
])
// Reasons that claim redundancy with a built-in rule demand corroboration —
// the core text must actually echo the current rules digest.
export const DEFAULT_ECHO_REASONS = new Set([
  'duplicate', 'dup', 'duplicate_of_default', 'default', 'redundant',
  'restatement', 'restate', 'restates_default',
])

export function normalizeDeleteReason(reason) {
  return String(reason ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

const DIGEST_LEXICAL_THRESHOLD = 0.5
// multilingual-e5 keeps unrelated pairs around 0.70–0.78; true cross-language
// restatements sit above 0.85. Ask for a clear margin over the noise floor.
const DIGEST_SEMANTIC_THRESHOLD = 0.84
const DIGEST_MAX_LINES = 400

// Lexical echo: max trigram similarity against any substantive digest line.
export function digestRedundancy(text, rulesDigest) {
  if (!text || !rulesDigest) return 0
  const lines = String(rulesDigest).split('\n').map(l => l.trim()).filter(l => l.length >= 12)
  let best = 0
  for (const line of lines) {
    const d = charDice(text, line)
    if (d > best) best = d
    if (best >= 0.9) break
  }
  return best
}

// Semantic echo: max cosine against digest lines, so a Korean core entry that
// restates an English rule is still recognised. Digest line embeddings are
// cached per digest text (one cycle3 run per day re-uses them across cores).
let _digestEmbedCache = { key: null, vectors: [] }
async function digestLineVectors(rulesDigest, embed) {
  const key = String(rulesDigest)
  if (_digestEmbedCache.key === key) return _digestEmbedCache.vectors
  const lines = key.split('\n')
    .map(l => l.replace(/^[\s#>*\-\d.)]+/, '').trim())
    .filter(l => l.length >= 24)
    .slice(0, DIGEST_MAX_LINES)
  const vectors = []
  for (const line of lines) {
    try {
      const v = await embed(line)
      if (Array.isArray(v) && v.length) vectors.push(v)
    } catch { /* one bad line must not blank the whole digest */ }
  }
  _digestEmbedCache = { key, vectors }
  return vectors
}

// `embed` is injectable so callers without a live embedding runtime (tests,
// proposal-only dry runs) can pass a stub or `null` to skip the semantic leg.
export async function digestSemanticRedundancy(text, rulesDigest, { embed = embedText } = {}) {
  if (!text || !rulesDigest || typeof embed !== 'function') return 0
  let query
  try { query = await embed(text, { inputType: 'query' }) } catch { return 0 }
  if (!Array.isArray(query) || query.length === 0) return 0
  let best = 0
  for (const v of await digestLineVectors(rulesDigest, embed)) {
    const c = cosineSimilarity(query, v)
    if (c != null && c > best) best = c
  }
  return best
}

export async function isSafeConservativeDelete(core, action, rulesDigest, { embed = embedText } = {}) {
  const reason = normalizeDeleteReason(action?.reason)
  if (!reason) return { ok: false, reason: 'delete needs a junk reason → APPLY CYCLE3' }
  if (!SAFE_DELETE_REASONS.has(reason)) return { ok: false, reason: `delete reason "${reason}" not in safe set → APPLY CYCLE3` }
  if (DEFAULT_ECHO_REASONS.has(reason)) {
    const text = coreText(core)
    const lexical = digestRedundancy(text, rulesDigest)
    if (lexical >= DIGEST_LEXICAL_THRESHOLD) return { ok: true, reason: `${reason} (lexical echo sim=${lexical.toFixed(2)})` }
    const semantic = await digestSemanticRedundancy(text, rulesDigest, { embed })
    if (semantic >= DIGEST_SEMANTIC_THRESHOLD) return { ok: true, reason: `${reason} (semantic echo cosine=${semantic.toFixed(2)})` }
    return { ok: false, reason: `not redundant with defaults (sim=${lexical.toFixed(2)} cosine=${semantic.toFixed(2)})` }
  }
  return { ok: true, reason }
}
