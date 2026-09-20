// Non-code text masker: blanks comment/string/regex bytes so downstream
// identifier scans never match inside them. Byte-offset preserving (fills
// with spaces, keeps newlines) so match.index maps back to the raw source.

import {
  _supportsHashComments,
  _supportsSlashComments,
  _supportsSingleQuoteStrings,
  _supportsBacktickStrings,
  _supportsTripleSingleQuoteStrings,
  _supportsTripleDoubleQuoteStrings,
  _isJsLike,
  _isWordStartChar,
  _isWordChar,
  REGEX_PRECEDENT_KEYWORDS,
  REGEX_PRECEDENT_CHARS,
} from './lang-predicates.mjs';

// Mask a JS regex literal body starting at `start` (which points at `/`).
// Handles `\` escapes and `[...]` character classes per ECMAScript spec.
// Returns the index just past the closing `/flags`. Bytes between the
// delimiters are replaced with spaces in `out` so downstream identifier
// searches do not see them.
function _maskJsRegexLiteral(src, out, start) {
  if (src[start] !== '\n') out[start] = ' ';
  let j = start + 1;
  let inCharClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\n') return j;
    if (c === '\\') {
      if (src[j] !== '\n') out[j] = ' ';
      if (j + 1 < src.length && src[j + 1] !== '\n') out[j + 1] = ' ';
      j += 2;
      continue;
    }
    if (c === '[' && !inCharClass) {
      inCharClass = true;
      if (src[j] !== '\n') out[j] = ' ';
      j++;
      continue;
    }
    if (c === ']' && inCharClass) {
      inCharClass = false;
      if (src[j] !== '\n') out[j] = ' ';
      j++;
      continue;
    }
    if (c === '/' && !inCharClass) {
      if (src[j] !== '\n') out[j] = ' ';
      j++;
      while (j < src.length && src[j] >= 'a' && src[j] <= 'z') {
        if (src[j] !== '\n') out[j] = ' ';
        j++;
      }
      return j;
    }
    if (src[j] !== '\n') out[j] = ' ';
    j++;
  }
  return j;
}

// Interpolation dialect of a string literal, decided when the literal opens:
//   'dollar-brace' — `${expr}`  (JS/TS backticks, kotlin "…")
//   'brace'        — `{expr}`   (python f-strings, C# $"…", `{{` = literal)
//   'bash'         — `$(cmd)` / `${var}` inside double quotes
// null = the whole literal is opaque text. Without this only JS backticks had
// their interpolations analysed, so calls inside python/C#/kotlin/bash
// interpolation were masked away entirely.
function _stringLiteralPrefix(src, quoteIndex, allowed) {
  let k = quoteIndex - 1;
  let prefix = '';
  while (k >= 0 && allowed.test(src[k]) && prefix.length < 2) {
    prefix = src[k] + prefix;
    k -= 1;
  }
  // A prefix glued to a longer identifier is not a string prefix.
  if (prefix && k >= 0 && _isWordChar(src[k])) return '';
  return prefix;
}

function _stringInterpKind(lang, delim, src, quoteIndex) {
  const triple = delim === '"""' || delim === "'''";
  if (delim === '`') return _isJsLike(lang) ? 'dollar-brace' : null;
  // Kotlin templates work the same in "…" and in """…""" raw strings.
  if (lang === 'kotlin' && (delim === '"' || triple)) return 'dollar-brace';
  if (lang === 'bash' && delim === '"') return 'bash';
  if (lang === 'python' && (triple || delim === '"' || delim === "'")) {
    const prefix = _stringLiteralPrefix(src, quoteIndex, /[fFrRbBuU]/);
    return /[fF]/.test(prefix) ? 'brace' : null;
  }
  if (lang === 'csharp' && (delim === '"' || triple)) {
    const prefix = _stringLiteralPrefix(src, quoteIndex, /[$@]/);
    return prefix.includes('$') ? 'brace' : null;
  }
  return null;
}

// Interpolation handling shared by single- and triple-quoted frames. Returns
// the next index when it consumed bytes, or -1 when the character is ordinary
// string text.
function _handleInterpolationInString(src, out, i, frame, stack) {
  const kind = frame?.interp;
  if (!kind) return -1;
  if (kind === 'brace' && src[i] === '{' && src[i + 1] === '{') {
    // `{{` is an escaped literal brace inside an f-string / $"…".
    if (src[i] !== '\n') out[i] = ' ';
    if (src[i + 1] !== '\n') out[i + 1] = ' ';
    return i + 2;
  }
  const opened = _interpolationOpenerAt(src, i, kind);
  if (opened) {
    // Enter interpolation: the expression bytes stay intact.
    stack.push({ kind: 'interp', depth: 1, open: opened.open, close: opened.close });
    return i + opened.length;
  }
  // Bare `$name` (kotlin template, bash expansion) is a real reference, so its
  // identifier bytes stay visible; only the `$` is masked. JS template literals
  // have no bare form — `$foo` there is literal text.
  if (
    (kind === 'bash' || (kind === 'dollar-brace' && frame.lang === 'kotlin')) &&
    src[i] === '$' &&
    _isWordStartChar(src[i + 1])
  ) {
    if (src[i] !== '\n') out[i] = ' ';
    let j = i + 1;
    while (j < src.length && _isWordChar(src[j])) j += 1;
    return j;
  }
  return -1;
}

// Interpolation opener at `i` for a frame of the given dialect.
function _interpolationOpenerAt(src, i, kind) {
  if (kind === 'dollar-brace') {
    return src.startsWith('${', i) ? { length: 2, open: '{', close: '}' } : null;
  }
  if (kind === 'brace') {
    // `{{` is an escaped literal brace — handled by the caller.
    if (src[i] !== '{' || src[i + 1] === '{') return null;
    return { length: 1, open: '{', close: '}' };
  }
  if (kind === 'bash') {
    if (src.startsWith('$(', i)) return { length: 2, open: '(', close: ')' };
    if (src.startsWith('${', i)) return { length: 2, open: '{', close: '}' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scanner. `s` is the mutable scan state:
//   src, out        — raw source and the byte-aligned masked copy
//   i               — cursor
//   lang            — language id (drives the comment/string predicates)
//   blockComment    — inside `/* … */`
//   prevToken       — ECMAScript token context for the `/`-disambiguation:
//                     'expr' = expression-start (regex literal may follow),
//                     'value' = value/operand (`/` is division). Start of
//                     file = expression context.
//   stack           — scanner frames; top describes the current state:
//     { kind: 'string', delim }       — inside single-line string literal (mask body)
//     { kind: 'triple', delim }       — inside triple-quote string (mask body)
//     { kind: 'luablock', close }     — inside a Lua long-bracket comment
//     { kind: 'interp', depth, open, close }
//                                     — inside a string interpolation
//                                       (`${…}`, f-string `{…}`, bash `$( … )`;
//                                       code mode, bytes preserved so caller
//                                       analysis sees fn-calls inside)
//   Empty stack = top-level code.
// Every step consumes at least one byte.

function blank(s, start, count) {
  for (let j = start; j < start + count && j < s.src.length; j++) {
    if (s.src[j] !== '\n') s.out[j] = ' ';
  }
}

function blankOne(s) {
  if (s.src[s.i] !== '\n') s.out[s.i] = ' ';
  s.i++;
}

function maskToLineEnd(s) {
  while (s.i < s.src.length && s.src[s.i] !== '\n') {
    s.out[s.i] = ' ';
    s.i++;
  }
}

function closeFrame(s, consumed) {
  blank(s, s.i, consumed);
  s.i += consumed;
  s.stack.pop();
  s.prevToken = 'value';
}

function enterInterpolation(s, frame) {
  const nextIndex = _handleInterpolationInString(s.src, s.out, s.i, frame, s.stack);
  if (nextIndex < 0) return false;
  s.i = nextIndex;
  s.prevToken = 'expr';
  return true;
}

function blockCommentStep(s) {
  if (s.src.startsWith('*/', s.i)) {
    blank(s, s.i, 2);
    s.i += 2;
    s.blockComment = false;
    return;
  }
  blankOne(s);
}

function tripleStep(s, frame) {
  if (s.src.startsWith(frame.delim, s.i)) return closeFrame(s, frame.delim.length);
  // Triple-quoted literals interpolate too (python f"""…""", kotlin """…""").
  if (enterInterpolation(s, frame)) return;
  blankOne(s);
}

// Lua long-bracket comment `--[=*[ ... ]=*]` — mask until the EXACT matching
// close delimiter (`]` + same number of `=` + `]`) recorded on the frame, so
// `--[==[ ]] ]==]` closes only at `]==]`.
function luaBlockStep(s, frame) {
  if (frame.close && s.src.startsWith(frame.close, s.i)) return closeFrame(s, frame.close.length);
  blankOne(s);
}

function stringStep(s, frame) {
  const { src } = s;
  const d = frame.delim;
  if (enterInterpolation(s, frame)) return;
  // In bash single-quotes `'...'`, backslash is literal (no escape) — the
  // string closes at the first `'`. Skip the escape consumption there so
  // `'\'` is not mis-read as an escaped quote. bash `"..."` and all other
  // langs keep backslash-escape handling.
  const bashLiteralSingle = frame.lang === 'bash' && d === "'";
  if (!bashLiteralSingle && src[s.i] === '\\' && (d === "'" || d === '"' || d === '`')) {
    blank(s, s.i, 2);
    s.i += 2;
    return;
  }
  if (src[s.i] === d) return closeFrame(s, 1);
  // JS forbids a raw newline inside '...' or "..." — defensive reset. bash
  // quoted strings legally span newlines, so do NOT reset bash frames.
  if (src[s.i] === '\n' && frame.lang !== 'bash' && (d === "'" || d === '"')) {
    s.stack.pop();
    s.prevToken = 'value';
    s.i++;
    return;
  }
  blankOne(s);
}

// Code mode inside an interpolation. Bytes preserved; track the frame's own
// delimiter depth so masking resumes once the expression closes.
function interpStep(s, frame) {
  const c = s.src[s.i];
  if (c === frame.open) {
    frame.depth++;
    s.prevToken = 'expr';
    s.i++;
    return;
  }
  if (c === frame.close) {
    frame.depth--;
    s.i++;
    if (frame.depth === 0) s.stack.pop();
    s.prevToken = 'value';
    return;
  }
  codeStep(s, false);
}

// Top-level-only openers: hash comments, Lua comments and triple-quoted
// strings. Returns true when it consumed bytes.
function topLevelOpenerStep(s) {
  const { src, lang } = s;
  const i = s.i;
  if (_supportsHashComments(lang) && src[i] === '#') {
    // Bash `#` is a comment ONLY at line start or after whitespace. When it
    // follows a non-space char it is part of `${var#pat}` / `${var##pat}`
    // parameter expansion (or `$#`, `arr[#]`, etc.), NOT a comment — masking
    // there would erase the rest of the line. `#!` shebang sits at file
    // start (a line start) so it is still masked.
    if (lang === 'bash') {
      const prev = i > 0 ? src[i - 1] : '\n';
      const atCommentPos = prev === '\n' || prev === ' ' || prev === '\t' || prev === '\r';
      if (!atCommentPos) {
        s.prevToken = 'value';
        s.i++;
        return true;
      }
    }
    maskToLineEnd(s);
    return true;
  }
  // Lua comments: `--[=*[ ... ]=*]` long-bracket block and `--` line. Lua is
  // neither slash nor hash (see comment predicates), so it needs this
  // dedicated branch. Checked before number/operator handling so the leading
  // `--` is consumed as a comment, not as two minus operators.
  if (lang === 'lua' && src.startsWith('--', i)) {
    // Long-bracket opener: `--` then `[` + zero-or-more `=` + `[`. The level
    // (`=` count) selects the matching close `]` + same `=` + `]`.
    const lb = /^--\[(=*)\[/.exec(src.slice(i, i + 64));
    if (lb) {
      blank(s, i, lb[0].length);
      s.i += lb[0].length;
      s.stack.push({ kind: 'luablock', close: `]${lb[1]}]` });
      return true;
    }
    // Plain `--` line comment (no long-bracket opener follows).
    maskToLineEnd(s);
    return true;
  }
  for (const delim of ["'''", '"""']) {
    const supported =
      delim === "'''" ? _supportsTripleSingleQuoteStrings(lang) : _supportsTripleDoubleQuoteStrings(lang);
    if (supported && src.startsWith(delim, i)) {
      blank(s, i, 3);
      s.i += 3;
      s.stack.push({ kind: 'triple', delim, lang, interp: _stringInterpKind(lang, delim, src, i) });
      return true;
    }
  }
  return false;
}

// Ordinary code token: identifier, number, whitespace or punctuation. Only
// updates the `/`-disambiguation context.
function tokenStep(s) {
  const { src } = s;
  const c = src[s.i];
  if (_isWordStartChar(c)) {
    const start = s.i;
    while (s.i < src.length && _isWordChar(src[s.i])) s.i++;
    s.prevToken = REGEX_PRECEDENT_KEYWORDS.has(src.substring(start, s.i)) ? 'expr' : 'value';
    return;
  }
  if (c >= '0' && c <= '9') {
    while (s.i < src.length && (src[s.i] === '.' || (src[s.i] >= '0' && src[s.i] <= '9'))) s.i++;
    s.prevToken = 'value';
    return;
  }
  if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
    s.i++;
    return;
  }
  s.prevToken = REGEX_PRECEDENT_CHARS.has(c) ? 'expr' : 'value';
  s.i++;
}

// Code mode shared by top-level and interpolation frames: slash comments,
// regex literals, string openers, then ordinary tokens. Top-level additionally
// recognises the hash/Lua comment and triple-quote openers.
function codeStep(s, topLevel) {
  const { src, lang } = s;
  const i = s.i;
  if (_supportsSlashComments(lang) && src.startsWith('/*', i)) {
    blank(s, i, 2);
    s.i += 2;
    s.blockComment = true;
    return;
  }
  if (_supportsSlashComments(lang) && src.startsWith('//', i)) return maskToLineEnd(s);
  if (topLevel && topLevelOpenerStep(s)) return;
  if (src[i] === '/' && _isJsLike(lang) && s.prevToken === 'expr') {
    s.i = _maskJsRegexLiteral(src, s.out, i);
    s.prevToken = 'value';
    return;
  }
  if (
    src[i] === '"' ||
    (_supportsSingleQuoteStrings(lang) && src[i] === "'") ||
    (_supportsBacktickStrings(lang) && src[i] === '`')
  ) {
    s.stack.push({ kind: 'string', delim: src[i], lang, interp: _stringInterpKind(lang, src[i], src, i) });
    blankOne(s);
    return;
  }
  tokenStep(s);
}

export function _maskNonCodeText(text, lang) {
  const src = String(text || '');
  const s = { src, out: src.split(''), i: 0, lang, stack: [], prevToken: 'expr', blockComment: false };
  while (s.i < src.length) {
    if (s.blockComment) {
      blockCommentStep(s);
      continue;
    }
    const frame = s.stack.length ? s.stack[s.stack.length - 1] : null;
    if (frame?.kind === 'triple') tripleStep(s, frame);
    else if (frame?.kind === 'luablock') luaBlockStep(s, frame);
    else if (frame?.kind === 'string') stringStep(s, frame);
    else if (frame?.kind === 'interp') interpStep(s, frame);
    else codeStep(s, true);
  }
  return s.out.join('');
}
