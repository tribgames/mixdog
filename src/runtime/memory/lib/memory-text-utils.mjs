import {
  cleanMemoryText,
} from './memory-extraction.mjs'
import { lightKoMorphStems, stripLightKoreanParticle } from './light-ko-morph.mjs'

const MEMORY_TOKEN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'did', 'do', 'does', 'for', 'from',
  'how', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the',
  'their', 'them', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'who', 'why', 'you',
  'your', 'unless', 'with',
  'user', 'assistant', 'requested', 'request', 'asked', 'ask', 'stated', 'state', 'reported', 'report',
  'mentioned', 'mention', 'clarified', 'clarify', 'explicitly', 'currently',
  'asks', 'question', 'answer', 'reply', 'said', 'explained', 'huh',
])

function normalizeMemoryToken(token) {
  let normalized = stripLightKoreanParticle(String(token ?? '').trim().toLowerCase())
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

function isStructuralTimeToken(token) {
  return /^\d{4}-\d{2}-\d{2}(?:~\d{4}-\d{2}-\d{2})?$/u.test(token)
    || /^\d{1,2}:\d{2}(?:~\d{1,2}:\d{2})?$/u.test(token)
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
  const rankingEntityConcepts = entityConcepts.filter((token) => !isStructuralTimeToken(token))
  const useEntityConcepts = rankingEntityConcepts.some(isIdentifierToken)
    || rankingEntityConcepts.length > 2
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
  return mergeRecallConceptTokens(text, lightKoMorphStems(text), limit)
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

// Prefix-form (to_tsquery) builder. Korean query tokens use the model-free
// normalizer, non-Korean tokens stay unchanged, and every lexeme gets a ':*'
// prefix match. The set is '&'-joined to preserve the current AND semantics.
//
// Returns { query, prefix:true } on success, or null.
export function buildFtsPrefixQuery(text) {
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


