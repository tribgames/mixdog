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
  '\uC0AC\uC6A9\uC790', '\uC720\uC800', '\uC694\uCCAD', '\uC9C8\uBB38', '\uB2F5\uBCC0', '\uC5B8\uAE09', '\uB9D0\uC500', '\uC124\uBA85', '\uBCF4\uACE0', '\uBB34\uC2A8', '\uBB50\uC57C', '\uD588\uC9C0', 'user', 'asks', 'asked', 'request', 'requested', 'question', 'answer', 'reply', 'said', 'mentioned', 'explained', 'reported', 'what', 'huh',
])

export function normalizeMemoryToken(token) {
  let normalized = String(token ?? '').trim().toLowerCase()
  if (!normalized) return ''

  // Korean suffix stripping: basic particles + compound endings
  if (/[\uAC00-\uD7AF]/.test(normalized) && normalized.length > 2) {
    const stripped = normalized
      .replace(/(\uD588\uC5C8\uC9C0|\uD588\uB354\uB77C|\uB410\uC5C8\uB098|\uB410\uB358\uAC00|\uD588\uB294\uC9C0|\uC600\uB294\uC9C0|\uC778\uAC74\uAC00|\uD558\uB824\uBA74|\uC5D0\uC11C\uB294|\uC774\uB77C\uC11C|\uC600\uB354\uB77C|\uC5D0\uC11C\uB3C4|\uC774\uC5C8\uC9C0|\uC73C\uB85C\uB3C4|\uAC70\uC600\uC9C0|\uD55C\uAC74\uC9C0|\uC774\uC5C8\uB098)$/u, '')
      .replace(/(\uD588\uB358|\uD588\uC9C0|\uB410\uB358|\uB410\uC9C0|\uD558\uAC8C|\uB418\uB358|\uC774\uB77C|\uC5D0\uC11C|\uC73C\uB85C|\uD558\uB294|\uC5C6\uB294|\uC788\uB294|\uC5C8\uB358|\uD558\uC790|\uC54A\uAC8C|\uD560\uB54C|\uC778\uC9C0|\uC778\uB370|\uC778\uAC74|\uC774\uACE0|\uBCF4\uB2E4|\uCC98\uB7FC|\uAE4C\uC9C0|\uBD80\uD130|\uB9C8\uB2E4|\uBC16\uC5D0|\uC5C6\uC774)$/u, '')
      .replace(/(\uC740|\uB294|\uC774|\uAC00|\uC744|\uB97C|\uB791|\uACFC|\uC640|\uB3C4|\uC5D0|\uC758|\uB85C|\uB9CC|\uBA70|\uB098|\uACE0|\uC11C|\uC790|\uC694)$/u, '')
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


