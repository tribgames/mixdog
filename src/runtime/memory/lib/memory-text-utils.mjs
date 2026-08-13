import {
  cleanMemoryText,
} from './memory-extraction.mjs'
import { isReady as koMorphReady, stems as koMorphStems } from './ko-morph.mjs'

const MEMORY_TOKEN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'did', 'do', 'does', 'for', 'from',
  'how', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the',
  'their', 'them', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'who', 'why', 'you',
  'your', 'unless', 'with',
  'user', 'assistant', 'requested', 'request', 'asked', 'ask', 'stated', 'state', 'reported', 'report',
  'mentioned', 'mention', 'clarified', 'clarify', 'explicitly', 'currently',
  'asks', 'question', 'answer', 'reply', 'said', 'explained', 'huh',
])

const MIXED_SCRIPT_KOREAN_PARTICLES = [
  '으로부터', '에게서', '한테서', '께서는', '에서는', '으로는', '에게는', '한테는',
  '께서', '에서', '으로', '에게', '한테', '처럼', '보다', '부터', '까지',
  '은', '는', '이', '가', '을', '를', '에', '로', '와', '과', '의', '도', '만',
]

function hangulFinalConsonantIndex(text) {
  const point = String(text ?? '').codePointAt(String(text ?? '').length - 1)
  if (!Number.isFinite(point) || point < 0xAC00 || point > 0xD7A3) return null
  return (point - 0xAC00) % 28
}

function stripFallbackKoreanParticle(token) {
  const value = String(token ?? '').trim()
  if (!value) return ''

  const mixed = value.match(/^([a-z0-9_./:-]{2,})([\p{Script=Hangul}]+)$/iu)
  if (mixed && MIXED_SCRIPT_KOREAN_PARTICLES.includes(mixed[2])) return mixed[1]
  if (!/^[\p{Script=Hangul}]+$/u.test(value)) return value

  for (const suffix of ['으로부터', '에게서', '한테서', '께서는', '에서는', '에게는', '한테는', '께서', '에서', '에게', '한테', '부터', '까지']) {
    const stem = value.slice(0, -suffix.length)
    if (stem.length >= 2 && value.endsWith(suffix)) return stem
  }

  const pairs = [
    ['으로', (jong) => jong !== 0 && jong !== 8],
    ['은', (jong) => jong !== 0],
    ['는', (jong) => jong === 0],
    ['이', (jong) => jong !== 0],
    ['가', (jong) => jong === 0],
    ['을', (jong) => jong !== 0],
    ['를', (jong) => jong === 0],
    ['과', (jong) => jong !== 0],
    ['와', (jong) => jong === 0],
  ]
  for (const [suffix, accepts] of pairs) {
    if (!value.endsWith(suffix)) continue
    const stem = value.slice(0, -suffix.length)
    if (stem.length < 2) continue
    const jong = hangulFinalConsonantIndex(stem)
    if (jong != null && accepts(jong)) return stem
  }
  return value
}

function normalizeMemoryToken(token) {
  let normalized = stripFallbackKoreanParticle(String(token ?? '').trim().toLowerCase())
  if (!normalized) return ''

  if (/^[a-z][a-z0-9_-]+$/i.test(normalized)) {
    if (normalized.length > 5 && normalized.endsWith('ing')) normalized = normalized.slice(0, -3)
    else if (normalized.length > 4 && normalized.endsWith('ed')) normalized = normalized.slice(0, -2)
    else if (normalized.length > 4 && normalized.endsWith('es')) normalized = normalized.slice(0, -2)
    else if (normalized.length > 3 && normalized.endsWith('s')) normalized = normalized.slice(0, -1)
  }

  return normalized
}

function rawRecallTokens(text) {
  return cleanMemoryText(text)
    .match(/-{0,2}[\p{L}\p{N}_][\p{L}\p{N}_./:-]*/gu) || []
}

function isIdentifierToken(token) {
  return /[_./:-]/u.test(token)
    || /\p{N}/u.test(token)
    || /^[A-Z][A-Z0-9_-]{1,}$/u.test(token)
}

function isEntityConcept(token) {
  return !/\p{Script=Hangul}/u.test(token)
    || isIdentifierToken(token)
}

function isConceptCompound(token, concepts) {
  const normalized = normalizeMemoryToken(token)
  if (!normalized) return false
  const parts = concepts.map(normalizeMemoryToken).filter(Boolean)
  for (let start = 0; start < parts.length; start += 1) {
    let joined = ''
    for (let index = start; index < parts.length; index += 1) {
      joined += parts[index]
      if (joined === normalized) return index > start
      if (!normalized.startsWith(joined)) break
    }
  }
  return false
}

export function mergeRecallConceptTokens(text, conceptTokens, limit = 24) {
  const cap = Math.max(1, Math.min(64, Math.floor(Number(limit) || 24)))
  const raw = rawRecallTokens(text)
  const concepts = Array.isArray(conceptTokens)
    ? conceptTokens.map((token) => String(token ?? '').trim()).filter(Boolean)
    : []
  const entityConcepts = concepts.filter(isEntityConcept)
  const useEntityConcepts = entityConcepts.some(isIdentifierToken) || entityConcepts.length > 1
  const source = concepts.length > 0
    ? [
        ...raw.filter(token => isIdentifierToken(token) || isConceptCompound(token, concepts)),
        ...(useEntityConcepts ? entityConcepts : concepts),
      ]
    : raw
  return [...new Set(source
    .map(token => normalizeMemoryToken(token))
    .filter(token => token.length >= 2 || /^\d$/u.test(token))
    .filter(token => !MEMORY_TOKEN_STOPWORDS.has(token)))]
    .slice(0, cap)
}

export function tokenizeRecallQuery(text, limit = 24) {
  return mergeRecallConceptTokens(text, koMorphStems(text), limit)
}

export function buildFtsQuery(text) {
  const tokens = tokenizeRecallQuery(text)
  if (tokens.length === 0) return ''
  const ftsTokens = [...new Set(tokens)].filter((token) => (
    Array.from(token).length >= 3
    || (Array.from(token).length >= 2 && /[^\p{ASCII}]/u.test(token))
  ))
  if (ftsTokens.length === 0) return ''
  // websearch_to_tsquery handles tokenization + OR/AND/quoting itself; pass plain tokens space-joined.
  return ftsTokens.map(t => t.replace(/["']/g, '')).filter(t => t.length > 0).join(' ')
}

// Sanitize a single lexeme for embedding inside a to_tsquery string. Strips the
// tsquery operator characters so a raw token can never inject syntax.
function sanitizeLexeme(t) {
  return String(t ?? '').replace(/[&|!():*'"\\\s]+/g, '')
}

// Prefix-form (to_tsquery) builder. Returns null when kiwi morph is not ready,
// signalling the caller to keep the websearch_to_tsquery fallback path. When
// ready: Korean tokens → Kiwi content-morpheme stems (NNG/NNP/VV/VA/XR/SL),
// non-Korean tokens kept as-is; every lexeme gets a ':*' prefix match and the
// set is '&'-joined to preserve the current AND semantics.
//
// Returns { query, prefix:true } on success, or null.
export function buildFtsPrefixQuery(text) {
  if (!koMorphReady()) return null
  const tokens = tokenizeRecallQuery(text)
  if (tokens.length === 0) return null
  const ftsTokens = [...new Set(tokens)].filter((token) => (
    Array.from(token).length >= 3
    || (Array.from(token).length >= 2 && /[^\p{ASCII}]/u.test(token))
  ))
  if (ftsTokens.length === 0) return null

  const lexemes = []
  const seen = new Set()
  for (const tok of ftsTokens) {
    const lex = sanitizeLexeme(tok)
    if (lex.length >= 1 && !seen.has(lex)) { seen.add(lex); lexemes.push(lex) }
  }
  if (lexemes.length === 0) return null
  const query = lexemes.map(l => `${l}:*`).join(' & ')
  return { query, prefix: true }
}


