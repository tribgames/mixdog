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
  '사용자', '유저', '요청', '질문', '답변', '언급', '말씀', '설명', '보고', '무슨', '뭐야', '했지', 'user', 'asks', 'asked', 'request', 'requested', 'question', 'answer', 'reply', 'said', 'mentioned', 'explained', 'reported', 'what', 'huh',
])

export function normalizeMemoryToken(token) {
  let normalized = String(token ?? '').trim().toLowerCase()
  if (!normalized) return ''

  // Korean suffix stripping: basic particles + compound endings
  if (/[\uAC00-\uD7AF]/.test(normalized) && normalized.length > 2) {
    const stripped = normalized
      .replace(/(했었지|했더라|됐었나|됐던가|했는지|였는지|인건가|하려면|에서는|이라서|였더라|에서도|이었지|으로도|거였지|한건지|이었나)$/u, '')
      .replace(/(했던|했지|됐던|됐지|하게|되던|이라|에서|으로|하는|없는|있는|었던|하자|않게|할때|인지|인데|인건|이고|보다|처럼|까지|부터|마다|밖에|없이)$/u, '')
      .replace(/(은|는|이|가|을|를|랑|과|와|도|에|의|로|만|며|나|고|서|자|요)$/u, '')
    if (stripped.length >= 2) normalized = stripped
  }

  if (/^[a-z][a-z0-9_-]+$/i.test(normalized)) {
    if (normalized.length > 5 && normalized.endsWith('ing')) normalized = normalized.slice(0, -3)
    else if (normalized.length > 4 && normalized.endsWith('ed')) normalized = normalized.slice(0, -2)
    else if (normalized.length > 4 && normalized.endsWith('es')) normalized = normalized.slice(0, -2)
    else if (normalized.length > 3 && normalized.endsWith('s')) normalized = normalized.slice(0, -1)
  }

  return normalized
}

export function tokenizeMemoryText(text) {
  return cleanMemoryText(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map(token => normalizeMemoryToken(token))
    .filter(token => token.length >= 2)
    .filter(token => !MEMORY_TOKEN_STOPWORDS.has(token))
    .slice(0, 24)
}

export function buildFtsQuery(text) {
  const tokens = tokenizeMemoryText(text)
  if (tokens.length === 0) return ''
  // Include 2-char Korean tokens (they carry meaning unlike 2-char English)
  const ftsTokens = [...new Set(tokens)].filter(t => t.length >= 3 || (t.length === 2 && /[\uAC00-\uD7AF]/.test(t)))
  if (ftsTokens.length === 0) return ''
  // websearch_to_tsquery handles tokenization + OR/AND/quoting itself; pass plain tokens space-joined.
  return ftsTokens.map(t => t.replace(/["']/g, '')).filter(t => t.length > 0).join(' ')
}

const HANGUL_RE = /[\uAC00-\uD7AF]/

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
  const tokens = tokenizeMemoryText(text)
  if (tokens.length === 0) return null
  const ftsTokens = [...new Set(tokens)].filter(t => t.length >= 3 || (t.length === 2 && HANGUL_RE.test(t)))
  if (ftsTokens.length === 0) return null

  const lexemes = []
  const seen = new Set()
  for (const tok of ftsTokens) {
    if (HANGUL_RE.test(tok)) {
      // Analyze against the ORIGINAL token (pre suffix-strip) so Kiwi sees the
      // real inflection; normalizeMemoryToken already ran, so also feed the
      // stripped form — union of both keeps recall high.
      const st = koMorphStems(tok)
      const forms = (st && st.length > 0) ? st : [tok]
      for (const f of forms) {
        const lex = sanitizeLexeme(f)
        if (lex.length >= 1 && !seen.has(lex)) { seen.add(lex); lexemes.push(lex) }
      }
    } else {
      const lex = sanitizeLexeme(tok)
      if (lex.length >= 1 && !seen.has(lex)) { seen.add(lex); lexemes.push(lex) }
    }
  }
  if (lexemes.length === 0) return null
  const query = lexemes.map(l => `${l}:*`).join(' & ')
  return { query, prefix: true }
}


