// Final parse of a Devin tool call's streamed arguments.
//
// Empty or whitespace-only arguments are `{}` (zero-argument tools may omit
// them). Valid JSON parses as is; otherwise a tolerant grammar repairs the
// common model malformations:
//   - single-quoted strings and unquoted object keys;
//   - stray / doubled / trailing commas, `//` and block comments;
//   - Python `True` / `False` / `None`, relaxed numbers (`+1`, `.5`, `0x1f`);
//   - invalid `\x` escapes kept literally;
//   - an apostrophe inside a single-quoted string (`'it's'`) stays content;
//   - an unquoted string value (`{"paths": src/*}`) up to `,` `}` `]` or newline.
// Truncated input, trailing garbage, non-finite numbers and barewords that
// could swallow a sibling field still fail: the call then carries Mixdog's
// invalid-arguments marker and never runs with half-formed arguments.
import { makeInvalidToolArgsMarker } from './lib/openai-tool-args.mjs';

const QUOTE = 0x22;
const SQUOTE = 0x27;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const COLON = 0x3a;
const COMMA = 0x2c;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;

const KEYWORDS = Object.freeze([
  ['true', true],
  ['false', false],
  ['null', null],
  ['True', true],
  ['False', false],
  ['None', null],
]);
// Atoms never recovered as strings: a tool must not run with a non-finite or
// undefined value posing as text.
const NON_RECOVERABLE_BAREWORDS = new Set(['NaN', 'Infinity', '-Infinity', '+Infinity', 'undefined']);
const SIMPLE_ESCAPES = Object.freeze({
  [QUOTE]: '"',
  [SQUOTE]: "'",
  [BACKSLASH]: '\\',
  [SLASH]: '/',
  98: '\b',
  102: '\f',
  110: '\n',
  114: '\r',
  116: '\t',
});

const isWhitespace = (cp) => cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
const isHexDigit = (cp) => (cp >= 0x30 && cp <= 0x39) || ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x66);
const isIdentChar = (cp) =>
  (cp >= 0x30 && cp <= 0x39) || ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7a) || cp === 0x5f || cp === 0x24;
const isNumberStart = (cp) => cp === 0x2d || cp === 0x2b || cp === 0x2e || (cp >= 0x30 && cp <= 0x39);
const isNumberChar = (cp) =>
  (cp >= 0x30 && cp <= 0x39) ||
  cp === 0x2d ||
  cp === 0x2b ||
  cp === 0x2e ||
  ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x66) ||
  (cp | 0x20) === 0x78;

// The first index at or after `i` past whitespace and comments.
function skipInsignificant(s, i) {
  const n = s.length;
  for (;;) {
    while (i < n && isWhitespace(s.charCodeAt(i))) i += 1;
    if (i + 1 < n && s.charCodeAt(i) === SLASH) {
      const next = s.charCodeAt(i + 1);
      if (next === SLASH) {
        i += 2;
        while (i < n && s.charCodeAt(i) !== 0x0a) i += 1;
        continue;
      }
      if (next === 0x2a) {
        i += 2;
        while (i + 1 < n && !(s.charCodeAt(i) === 0x2a && s.charCodeAt(i + 1) === SLASH)) i += 1;
        i = Math.min(i + 2, n);
        continue;
      }
    }
    return i;
  }
}

function hex4(s, pos) {
  if (pos + 4 > s.length) return -1;
  for (let k = pos; k < pos + 4; k += 1) if (!isHexDigit(s.charCodeAt(k))) return -1;
  return Number.parseInt(s.slice(pos, pos + 4), 16);
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

class TolerantJsonParser {
  constructor(src) {
    this.src = src;
    this.pos = 0;
  }

  peek() {
    return this.src.charCodeAt(this.pos);
  }

  get atEnd() {
    return this.pos >= this.src.length;
  }

  ws() {
    this.pos = skipInsignificant(this.src, this.pos);
  }

  fail(message) {
    throw new SyntaxError(message);
  }

  parse() {
    this.ws();
    if (this.atEnd) this.fail('Unexpected end of JSON input');
    const value = this.value(false);
    this.ws();
    if (!this.atEnd) this.fail(`Unexpected trailing characters at position ${this.pos}`);
    return value;
  }

  value(allowBareword) {
    const c = this.peek();
    if (c === LBRACE) return this.object();
    if (c === LBRACKET) return this.array();
    if (c === QUOTE || c === SQUOTE) return this.string(c);
    if (isNumberStart(c)) return this.number();
    const keyword = this.keyword();
    if (keyword !== undefined) return keyword;
    if (allowBareword) return this.bareword();
    return this.fail(`Unexpected token at position ${this.pos}`);
  }

  object() {
    this.pos += 1;
    const out = {};
    for (;;) {
      this.ws();
      if (this.atEnd) this.fail('Unterminated object');
      const c = this.peek();
      if (c === RBRACE) {
        this.pos += 1;
        return out;
      }
      if (c === COMMA) {
        this.pos += 1;
        continue;
      }
      const key = this.key();
      this.ws();
      if (this.peek() !== COLON) this.fail("Expected ':' in object");
      this.pos += 1;
      this.ws();
      if (this.atEnd) this.fail("Expected value after ':'");
      setOwn(out, key, this.value(true));
      this.ws();
      const d = this.peek();
      if (d === COMMA) {
        this.pos += 1;
        continue;
      }
      if (d === RBRACE) {
        this.pos += 1;
        return out;
      }
      this.fail("Expected ',' or '}' in object");
    }
  }

  array() {
    this.pos += 1;
    const out = [];
    for (;;) {
      this.ws();
      if (this.atEnd) this.fail('Unterminated array');
      const c = this.peek();
      if (c === RBRACKET) {
        this.pos += 1;
        return out;
      }
      if (c === COMMA) {
        this.pos += 1;
        continue;
      }
      out.push(this.value(true));
      this.ws();
      const d = this.peek();
      if (d === COMMA) {
        this.pos += 1;
        continue;
      }
      if (d === RBRACKET) {
        this.pos += 1;
        return out;
      }
      this.fail("Expected ',' or ']' in array");
    }
  }

  key() {
    const c = this.peek();
    if (c === QUOTE || c === SQUOTE) return this.string(c);
    const s = this.src;
    const start = this.pos;
    while (this.pos < s.length) {
      const cc = s.charCodeAt(this.pos);
      if (cc === COLON || cc === COMMA || cc === RBRACE || isWhitespace(cc)) break;
      this.pos += 1;
    }
    if (this.pos === start) this.fail('Expected object key');
    return s.slice(start, this.pos);
  }

  // A single quote closes only before a value terminator (or the end), so an
  // apostrophe stays content; a double quote always closes.
  closesSingleQuote(from) {
    const k = skipInsignificant(this.src, from);
    if (k >= this.src.length) return true;
    const c = this.src.charCodeAt(k);
    return c === COMMA || c === RBRACE || c === RBRACKET || c === COLON;
  }

  string(quote) {
    const s = this.src;
    const n = s.length;
    let i = this.pos + 1;
    let out = '';
    let runStart = i;
    while (i < n) {
      const cc = s.charCodeAt(i);
      if (cc === quote) {
        if (quote === QUOTE || this.closesSingleQuote(i + 1)) {
          out += s.slice(runStart, i);
          this.pos = i + 1;
          return out;
        }
        i += 1;
        continue;
      }
      if (cc !== BACKSLASH) {
        i += 1;
        continue;
      }
      out += s.slice(runStart, i);
      i += 1;
      if (i >= n) break;
      const esc = s.charCodeAt(i);
      if (SIMPLE_ESCAPES[esc] !== undefined) {
        out += SIMPLE_ESCAPES[esc];
      } else if (esc === 0x75) {
        const unit = hex4(s, i + 1);
        if (unit >= 0) {
          out += String.fromCharCode(unit);
          i += 4;
        } else {
          out += '\\u';
        }
      } else {
        out += `\\${s[i]}`;
      }
      i += 1;
      runStart = i;
    }
    return this.fail('Unterminated string');
  }

  number() {
    const s = this.src;
    const start = this.pos;
    while (this.pos < s.length && isNumberChar(s.charCodeAt(this.pos))) this.pos += 1;
    const token = s.slice(start, this.pos);
    const value = Number(token);
    if (!Number.isFinite(value)) this.fail(`Invalid number: ${token}`);
    return value;
  }

  keyword() {
    for (const [word, value] of KEYWORDS) {
      if (this.src.startsWith(word, this.pos) && !isIdentChar(this.src.charCodeAt(this.pos + word.length))) {
        this.pos += word.length;
        return value;
      }
    }
    return undefined;
  }

  // An unquoted value up to `,` `}` `]` or a newline, trailing space trimmed.
  // It fails at the end of input and on `"`, `{`, `[` or a key-like `:`
  // (a missed comma must not swallow the next field); `:/` and `:\` stay
  // literal so URLs and Windows paths recover.
  bareword() {
    const s = this.src;
    const start = this.pos;
    let i = start;
    while (i < s.length) {
      const cc = s.charCodeAt(i);
      if (cc === COMMA || cc === RBRACE || cc === RBRACKET || cc === 0x0a || cc === 0x0d) break;
      const next = s.charCodeAt(i + 1);
      if (cc === QUOTE || cc === LBRACE || cc === LBRACKET || (cc === COLON && next !== SLASH && next !== BACKSLASH)) {
        return this.fail(`Unexpected token at position ${start}`);
      }
      i += 1;
    }
    if (i >= s.length) return this.fail(`Unexpected token at position ${start}`);
    let end = i;
    while (end > start && isWhitespace(s.charCodeAt(end - 1))) end -= 1;
    const word = s.slice(start, end);
    if (NON_RECOVERABLE_BAREWORDS.has(word)) return this.fail(`Unexpected token at position ${start}`);
    this.pos = i;
    return word;
  }
}

/** A JSON value with the common model malformations repaired; throws when unrepairable. */
export function parseDevinJsonWithRepair(json) {
  try {
    return JSON.parse(json);
  } catch {
    return new TolerantJsonParser(json).parse();
  }
}

/** Final tool-call arguments: `{}` when empty, else repaired JSON, else the invalid-arguments marker. */
export function parseDevinToolArguments(raw) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!text.trim()) return {};
  try {
    return parseDevinJsonWithRepair(text);
  } catch (error) {
    return makeInvalidToolArgsMarker(text, error instanceof Error ? error.message : String(error));
  }
}

/** parseToolCalls for the compat stream consumer, with Devin's final argument parse. */
export function parseDevinToolCalls(choice) {
  const calls = choice?.message?.tool_calls;
  if (!calls?.length) return undefined;
  return calls
    .filter((call) => call.type === 'function')
    .map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: parseDevinToolArguments(call.function.arguments),
    }));
}
