import { isWhitespace } from './token-estimate-floors.mjs';

// --- Identity serialization -------------------------------------------------
//
// A message's identity is hashed as the UTF-8 bytes of JSON.stringify(identity)
// followed by '\0'. The bytes are produced here directly into a reused scratch
// buffer: the transcript text inside an identity is escaped (and, for the
// shape identity, normalized) on the fly instead of first building the
// escaped JSON, the placeholder-stripped copy and the whitespace-collapsed
// copy of every message. The byte stream — and so every digest — is exactly
// the one JSON.stringify produces.
const IDENTITY_SCRATCH = Buffer.allocUnsafe(1 << 16);
const HEX_DIGITS = '0123456789abcdef';
// \b \t \n \f \r: the control characters JSON.stringify escapes by letter.
const SHORT_ESCAPES = new Uint8Array(32);
SHORT_ESCAPES[0x08] = 0x62;
SHORT_ESCAPES[0x09] = 0x74;
SHORT_ESCAPES[0x0a] = 0x6e;
SHORT_ESCAPES[0x0c] = 0x66;
SHORT_ESCAPES[0x0d] = 0x72;
let identityPos = 0;
let identityHash = null;

function flushIdentity() {
  if (identityPos) identityHash.update(IDENTITY_SCRATCH.subarray(0, identityPos));
  identityPos = 0;
}

function reserveIdentity(bytes) {
  if (identityPos + bytes > IDENTITY_SCRATCH.length) flushIdentity();
}

function putUnicodeEscape(code) {
  const s = IDENTITY_SCRATCH;
  s[identityPos++] = 0x5c;
  s[identityPos++] = 0x75;
  s[identityPos++] = HEX_DIGITS.charCodeAt((code >> 12) & 15);
  s[identityPos++] = HEX_DIGITS.charCodeAt((code >> 8) & 15);
  s[identityPos++] = HEX_DIGITS.charCodeAt((code >> 4) & 15);
  s[identityPos++] = HEX_DIGITS.charCodeAt(code & 15);
}

// Writes the code unit at `index` of `text` (a whole surrogate pair when one
// starts there) as UTF-8, JSON-escaped when `jsonEscape`; returns the next index.
function putCodeUnit(text, index, jsonEscape) {
  reserveIdentity(6);
  const s = IDENTITY_SCRATCH;
  const c = text.charCodeAt(index);
  if (c < 0x80) {
    if (!jsonEscape || (c >= 0x20 && c !== 0x22 && c !== 0x5c)) {
      s[identityPos++] = c;
    } else if (c === 0x22 || c === 0x5c) {
      s[identityPos++] = 0x5c;
      s[identityPos++] = c;
    } else if (SHORT_ESCAPES[c]) {
      s[identityPos++] = 0x5c;
      s[identityPos++] = SHORT_ESCAPES[c];
    } else {
      putUnicodeEscape(c);
    }
    return index + 1;
  }
  if (c < 0x800) {
    s[identityPos++] = 0xc0 | (c >> 6);
    s[identityPos++] = 0x80 | (c & 0x3f);
    return index + 1;
  }
  if (c >= 0xd800 && c <= 0xdfff) {
    const next = c <= 0xdbff && index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
    if (next >= 0xdc00 && next <= 0xdfff) {
      const point = (c - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
      s[identityPos++] = 0xf0 | (point >> 18);
      s[identityPos++] = 0x80 | ((point >> 12) & 0x3f);
      s[identityPos++] = 0x80 | ((point >> 6) & 0x3f);
      s[identityPos++] = 0x80 | (point & 0x3f);
      return index + 2;
    }
    // A lone surrogate: JSON.stringify escapes it (raw JSON never has one).
    putUnicodeEscape(c);
    return index + 1;
  }
  s[identityPos++] = 0xe0 | (c >> 12);
  s[identityPos++] = 0x80 | ((c >> 6) & 0x3f);
  s[identityPos++] = 0x80 | (c & 0x3f);
  return index + 1;
}

export function putRaw(text) {
  for (let index = 0; index < text.length; ) index = putCodeUnit(text, index, false);
}

export function putJsonString(text) {
  putRaw('"');
  for (let index = 0; index < text.length; ) index = putCodeUnit(text, index, true);
  putRaw('"');
}

// One element of an identity array (strings escaped here; the other values
// are small plain data and serialize through JSON.stringify).
export function putJsonElement(value) {
  if (typeof value === 'string') putJsonString(value);
  else putRaw(JSON.stringify(value) ?? 'null');
}

const STORED_MEDIA_PLACEHOLDER_PREFIXES = ['[Image omitted from stored history', '[File omitted from stored history'];

// JSON.stringify of
//   text.replace(/\[(?:Image|File) omitted from stored history[^\]]*\]/g, ' ')
//       .replace(/\s+/g, ' ').trim()
// written in one pass; returns how many placeholders were replaced.
export function putShapeText(text) {
  putRaw('"');
  let placeholders = 0;
  let emitted = false;
  let pendingSpace = false;
  let closable = true;
  for (let index = 0; index < text.length; ) {
    const c = text.charCodeAt(index);
    if (c === 0x5b && closable) {
      let prefix = null;
      for (const candidate of STORED_MEDIA_PLACEHOLDER_PREFIXES) {
        if (text.startsWith(candidate, index)) prefix = candidate;
      }
      if (prefix) {
        const close = text.indexOf(']', index + prefix.length);
        // No `]` after this one means no later placeholder can close either.
        if (close < 0) {
          closable = false;
        } else {
          placeholders += 1;
          pendingSpace = emitted;
          index = close + 1;
          continue;
        }
      }
    }
    if (isWhitespace(c)) {
      pendingSpace = emitted;
      index += 1;
      continue;
    }
    if (pendingSpace) {
      putRaw(' ');
      pendingSpace = false;
    }
    index = putCodeUnit(text, index, true);
    emitted = true;
  }
  putRaw('"');
  return placeholders;
}

export function beginIdentity(hash) {
  identityHash = hash;
  identityPos = 0;
}

export function endIdentity() {
  putRaw('\0');
  flushIdentity();
  identityHash = null;
}
