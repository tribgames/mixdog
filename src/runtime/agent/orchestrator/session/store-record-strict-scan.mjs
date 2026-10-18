/**
 * Strict session-record read that decodes only what its caller needs.
 *
 * `readTopLevelLifecycleRecord` (lifecycle-scan.mjs) is the authority: a full
 * `JSON.parse`, then a top-level duplicate-key walk. On a transcript that
 * materializes every message object — about 2.5 ms per MB, most of it for
 * tool output nobody reads. This reader reaches the SAME verdict and the same
 * values while decoding only:
 *   - top-level values whose key is not in `skip`;
 *   - of `messages` (when it is an array): each element whose `role` is in
 *     `fullMessageRoles` in full; every other object element as `{ role }`
 *     (or `{}` without one); non-object elements in full.
 * Everything else is validated, never decoded.
 *
 * The fast path accepts a document only when it has PROVEN it valid:
 *   - no raw byte below 0x20 anywhere (one native regex test; JSON forbids
 *     them inside strings, so a document with whitespace other than spaces,
 *     i.e. a pretty-printed one, simply takes the authoritative path);
 *   - no invalid escape anywhere (one native regex test; a backslash outside
 *     a string fails the grammar walk below);
 *   - the complete grammar, walked over every byte outside strings: values,
 *     separators, exact number and literal spellings, nesting, and nothing
 *     but whitespace after the root object;
 *   - a root object without any repeated top-level key.
 * Anything it cannot prove — malformed, ambiguous, or merely unusual — is
 * handed to `readTopLevelLifecycleRecord` itself, so every rejection is the
 * authority's own. Decoded values are `JSON.parse` of their exact UTF-8
 * slices, which equal the full parse's sub-values (slices start and end at
 * ASCII delimiters, so UTF-8 decoding agrees too).
 */
import { lifecycleRecordOf, readTopLevelLifecycleRecord } from './lifecycle-scan.mjs';

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SPACE = 0x20;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;
const EMPTY = new Set();

// String-content faults, one native pass each (an alternation of the two is
// slower than both). Any raw control byte: inside a string JSON.parse rejects
// it; outside one only \t \n \r are whitespace, and those documents take the
// full path.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are exactly what this detects.
const CONTROL_BYTE = /[\x00-\x1f]/;
// An escape that is not one of \" \\ \/ \b \f \n \r \t \uXXXX. The run before
// it starts after a non-backslash, so escapes pair from the run's start.
const INVALID_ESCAPE = /(?<!\\)(?:\\\\)*\\(?:[^"\\/bfnrtu]|u(?![0-9a-fA-F]{4}))/;

const isDigit = (code) => code >= ZERO && code <= NINE;

// Only spaces can remain: CONTROL_BYTE already sent every \t \n \r away.
function skipSpaces(text, at) {
  let i = at;
  while (text.charCodeAt(i) === SPACE) i++;
  return i;
}

/** Index after the string opening at `at`, or -1. */
function stringEnd(text, at) {
  let quote = at;
  for (;;) {
    quote = text.indexOf('"', quote + 1);
    if (quote === -1) return -1;
    let run = 0;
    for (let k = quote - 1; text.charCodeAt(k) === BACKSLASH; k--) run++;
    if ((run & 1) === 0) return quote + 1;
  }
}

/** Index after the JSON number at `at`, or -1. */
function numberEnd(text, at) {
  let i = at;
  if (text.charCodeAt(i) === MINUS) i++;
  if (text.charCodeAt(i) === ZERO) i++;
  else if (isDigit(text.charCodeAt(i))) {
    while (isDigit(text.charCodeAt(i))) i++;
  } else return -1;
  if (text.charCodeAt(i) === DOT) {
    i++;
    if (!isDigit(text.charCodeAt(i))) return -1;
    while (isDigit(text.charCodeAt(i))) i++;
  }
  const exponent = text.charCodeAt(i);
  if (exponent === 0x65 || exponent === 0x45) {
    i++;
    if (text.charCodeAt(i) === PLUS || text.charCodeAt(i) === MINUS) i++;
    if (!isDigit(text.charCodeAt(i))) return -1;
    while (isDigit(text.charCodeAt(i))) i++;
  }
  return i;
}

/** Index after `"key" :` starting at `at`, or -1. */
function memberValueStart(text, at) {
  if (text.charCodeAt(at) !== QUOTE) return -1;
  const end = stringEnd(text, at);
  if (end === -1) return -1;
  const colon = skipSpaces(text, end);
  return text.charCodeAt(colon) === COLON ? colon + 1 : -1;
}

/** Index after one valid JSON value starting at or after `at`, or -1.
 *  Iterative, so nesting depth costs no stack. */
function valueEnd(text, at) {
  const closers = [];
  let i = at;
  for (;;) {
    i = skipSpaces(text, i);
    const code = text.charCodeAt(i);
    if (code === QUOTE) i = stringEnd(text, i);
    else if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
      const closer = code === OPEN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY;
      i = skipSpaces(text, i + 1);
      if (text.charCodeAt(i) === closer) i++;
      else {
        closers.push(closer);
        if (closer === CLOSE_OBJECT) {
          i = memberValueStart(text, i);
          if (i === -1) return -1;
        }
        continue;
      }
    } else if (code === 0x74) i = text.startsWith('true', i) ? i + 4 : -1;
    else if (code === 0x66) i = text.startsWith('false', i) ? i + 5 : -1;
    else if (code === 0x6e) i = text.startsWith('null', i) ? i + 4 : -1;
    else i = numberEnd(text, i);
    if (i === -1) return -1;
    // After a value: close containers or move to the next member/element.
    for (;;) {
      if (closers.length === 0) return i;
      i = skipSpaces(text, i);
      const next = text.charCodeAt(i);
      const closer = closers[closers.length - 1];
      if (next === closer) {
        closers.pop();
        i++;
        continue;
      }
      if (next !== COMMA) return -1;
      i = skipSpaces(text, i + 1);
      if (closer === CLOSE_OBJECT) {
        i = memberValueStart(text, i);
        if (i === -1) return -1;
      }
      break;
    }
  }
}

const decodeSlice = (bytes, start, end) => JSON.parse(bytes.toString('utf8', start, end));

/** The key of the string token [start, end): its own bytes unless escaped. */
function decodeKey(bytes, text, start, end) {
  for (let k = start + 1; k < end - 1; k++) {
    if (text.charCodeAt(k) === BACKSLASH) return decodeSlice(bytes, start, end);
  }
  return bytes.toString('utf8', start + 1, end - 1);
}

function defineMember(target, key, value) {
  // JSON.parse creates own data properties, `__proto__` included.
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

// "role" spelled with escapes is at most 6 escapes of 6 chars plus quotes.
const MAX_ESCAPED_ROLE_KEY = 26;

/** One `messages` element [start, ...): `{ end, item }`, or null. */
function messageElement(bytes, text, start, fullRoles) {
  if (text.charCodeAt(start) !== OPEN_OBJECT) {
    const end = valueEnd(text, start);
    return end === -1 ? null : { end, item: decodeSlice(bytes, start, end) };
  }
  let i = skipSpaces(text, start + 1);
  let role;
  let hasRole = false;
  if (text.charCodeAt(i) === CLOSE_OBJECT) return { end: i + 1, item: {} };
  for (;;) {
    if (text.charCodeAt(i) !== QUOTE) return null;
    const keyEnd = stringEnd(text, i);
    if (keyEnd === -1) return null;
    const isRole =
      (keyEnd - i === 6 && text.startsWith('"role"', i)) ||
      (keyEnd - i <= MAX_ESCAPED_ROLE_KEY && keyEnd - i > 6 && decodeKey(bytes, text, i, keyEnd) === 'role');
    const colon = skipSpaces(text, keyEnd);
    if (text.charCodeAt(colon) !== COLON) return null;
    const valueStart = skipSpaces(text, colon + 1);
    const end = valueEnd(text, valueStart);
    if (end === -1) return null;
    if (isRole) {
      // Duplicate members resolve last-wins, as in the full parse.
      role = decodeSlice(bytes, valueStart, end);
      hasRole = true;
    }
    i = skipSpaces(text, end);
    if (text.charCodeAt(i) === COMMA) {
      i = skipSpaces(text, i + 1);
      continue;
    }
    if (text.charCodeAt(i) !== CLOSE_OBJECT) return null;
    const elementEnd = i + 1;
    let item = {};
    if (hasRole && fullRoles.has(role)) item = decodeSlice(bytes, start, elementEnd);
    else if (hasRole) defineMember(item, 'role', role);
    return { end: elementEnd, item };
  }
}

/** The `messages` array [start, ...): `{ end, messages }`, or null. */
function messagesValue(bytes, text, start, fullRoles) {
  const messages = [];
  let i = skipSpaces(text, start + 1);
  if (text.charCodeAt(i) === CLOSE_ARRAY) return { end: i + 1, messages };
  for (;;) {
    const element = messageElement(bytes, text, i, fullRoles);
    if (!element) return null;
    messages.push(element.item);
    i = skipSpaces(text, element.end);
    if (text.charCodeAt(i) === COMMA) {
      i = skipSpaces(text, i + 1);
      continue;
    }
    return text.charCodeAt(i) === CLOSE_ARRAY ? { end: i + 1, messages } : null;
  }
}

/**
 * The proven-valid, duplicate-free root object of `bytes`, or null when
 * validity could not be proven (or the document is not such an object). Of
 * it only the members `decode(key)` accepts are decoded — `messages`, when an
 * array, as described in the module comment with `fullMessageRoles`; every
 * other member is validated and left out.
 */
export function provenTopLevelObject(bytes, decode, fullMessageRoles = EMPTY) {
  try {
    return provenDocument(bytes, decode, fullMessageRoles);
  } catch {
    return null;
  }
}

function provenDocument(bytes, decode, fullRoles) {
  const text = bytes.toString('latin1');
  if (CONTROL_BYTE.test(text) || INVALID_ESCAPE.test(text)) return null;
  let i = skipSpaces(text, 0);
  if (text.charCodeAt(i) !== OPEN_OBJECT) return null;
  const doc = {};
  const seen = new Set();
  i = skipSpaces(text, i + 1);
  if (text.charCodeAt(i) === CLOSE_OBJECT) i++;
  else {
    for (;;) {
      if (text.charCodeAt(i) !== QUOTE) return null;
      const keyEnd = stringEnd(text, i);
      if (keyEnd === -1) return null;
      const key = decodeKey(bytes, text, i, keyEnd);
      if (seen.has(key)) return null;
      seen.add(key);
      const colon = skipSpaces(text, keyEnd);
      if (text.charCodeAt(colon) !== COLON) return null;
      const start = skipSpaces(text, colon + 1);
      const wanted = decode(key);
      let end;
      if (wanted && key === 'messages' && text.charCodeAt(start) === OPEN_ARRAY) {
        const value = messagesValue(bytes, text, start, fullRoles);
        if (!value) return null;
        end = value.end;
        defineMember(doc, key, value.messages);
      } else {
        end = valueEnd(text, start);
        if (end === -1) return null;
        if (wanted) defineMember(doc, key, decodeSlice(bytes, start, end));
      }
      i = skipSpaces(text, end);
      if (text.charCodeAt(i) === COMMA) {
        i = skipSpaces(text, i + 1);
        continue;
      }
      if (text.charCodeAt(i) !== CLOSE_OBJECT) return null;
      i++;
      break;
    }
  }
  return skipSpaces(text, i) === text.length ? doc : null;
}

/**
 * `readTopLevelLifecycleRecord` of the UTF-8 document in `bytes`, with `doc`
 * decoded as described above — only for a proven document; a record from the
 * authoritative fallback carries the complete document. Consumers must read
 * nothing but non-skipped fields and, of non-full messages, `role`.
 */
export function readStrictRecordFields(bytes, { skip = EMPTY, fullMessageRoles = EMPTY } = {}) {
  const doc = provenTopLevelObject(bytes, (key) => !skip.has(key), fullMessageRoles);
  return doc ? lifecycleRecordOf(doc) : readTopLevelLifecycleRecord(bytes.toString('utf8'));
}
