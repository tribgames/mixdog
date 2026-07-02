// Non-code text masker: blanks comment/string/regex bytes so downstream
// identifier scans never match inside them. Byte-offset preserving (fills
// with spaces, keeps newlines) so match.index maps back to the raw source.
// Extracted verbatim from code-graph.mjs.
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
export function _maskJsRegexLiteral(src, out, start) {
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

export function _maskNonCodeText(text, lang) {
  const src = String(text || '');
  const out = src.split('');
  let i = 0;
  let blockComment = false;
  // Stack of scanner frames. Top describes current state:
  //   { kind: 'string', delim }       — inside single-line string literal (mask body)
  //   { kind: 'triple', delim }       — inside triple-quote string (mask body)
  //   { kind: 'interp', braceDepth }  — inside backtick `${...}` interpolation
  //                                     (code mode; bytes preserved so callers
  //                                     analysis can see fn-calls inside)
  // Empty stack = top-level code.
  const stack = [];
  const top = () => (stack.length ? stack[stack.length - 1] : null);
  // prevToken tracks ECMAScript token context for the `/`-disambiguation:
  //   'expr'  = expression-start (regex literal may follow)
  //   'value' = value/operand (`/` is division)
  // Start of file = expression context.
  let prevToken = 'expr';
  while (i < src.length) {
    if (blockComment) {
      if (src.startsWith('*/', i)) {
        out[i] = ' ';
        if (i + 1 < out.length) out[i + 1] = ' ';
        i += 2;
        blockComment = false;
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    const t = top();
    if (t && t.kind === 'triple') {
      if (src.startsWith(t.delim, i)) {
        for (let j = 0; j < t.delim.length; j++) {
          if (src[i + j] !== '\n') out[i + j] = ' ';
        }
        i += t.delim.length;
        stack.pop();
        prevToken = 'value';
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (t && t.kind === 'luablock') {
      // Lua long-bracket comment `--[=*[ ... ]=*]` — mask until the EXACT
      // matching close delimiter (`]` + same number of `=` + `]`) recorded
      // on the frame, so `--[==[ ]] ]==]` closes only at `]==]`.
      if (t.close && src.startsWith(t.close, i)) {
        for (let j = 0; j < t.close.length; j++) {
          if (src[i + j] !== '\n') out[i + j] = ' ';
        }
        i += t.close.length;
        stack.pop();
        prevToken = 'value';
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (t && t.kind === 'string') {
      const d = t.delim;
      if (d === '`' && src.startsWith('${', i)) {
        // Enter interpolation. `${` itself is code-relevant — leave bytes intact.
        stack.push({ kind: 'interp', braceDepth: 1 });
        i += 2;
        prevToken = 'expr';
        continue;
      }
      // In bash single-quotes `'...'`, backslash is literal (no escape) — the
      // string closes at the first `'`. Skip the escape consumption there so
      // `'\'` is not mis-read as an escaped quote. bash `"..."` and all other
      // langs keep backslash-escape handling.
      const bashLiteralSingle = t.lang === 'bash' && d === '\'';
      if (!bashLiteralSingle && src[i] === '\\' && (d === '\'' || d === '"' || d === '`')) {
        if (src[i] !== '\n') out[i] = ' ';
        if (i + 1 < src.length && src[i + 1] !== '\n') out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (src[i] === d) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
        stack.pop();
        prevToken = 'value';
        continue;
      }
      // JS forbids a raw newline inside '...' or "..." — defensive reset. bash
      // quoted strings legally span newlines, so do NOT reset bash frames.
      if (src[i] === '\n' && t.lang !== 'bash' && (d === '\'' || d === '"')) {
        stack.pop();
        prevToken = 'value';
        i++;
        continue;
      }
      if (src[i] !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (t && t.kind === 'interp') {
      // Code mode inside `${...}`. Bytes preserved; track brace depth and
      // nested constructs so masking resumes once interpolation closes.
      if (src[i] === '{') {
        t.braceDepth++;
        prevToken = 'expr';
        i++;
        continue;
      }
      if (src[i] === '}') {
        t.braceDepth--;
        i++;
        if (t.braceDepth === 0) {
          stack.pop();
          prevToken = 'value';
        } else {
          prevToken = 'value';
        }
        continue;
      }
      if (_supportsSlashComments(lang) && src.startsWith('/*', i)) {
        out[i] = ' ';
        if (i + 1 < out.length) out[i + 1] = ' ';
        i += 2;
        blockComment = true;
        continue;
      }
      if (_supportsSlashComments(lang) && src.startsWith('//', i)) {
        while (i < src.length && src[i] !== '\n') {
          out[i] = ' ';
          i++;
        }
        continue;
      }
      if (src[i] === '/' && _isJsLike(lang) && prevToken === 'expr') {
        i = _maskJsRegexLiteral(src, out, i);
        prevToken = 'value';
        continue;
      }
      if (src[i] === '"' || (_supportsSingleQuoteStrings(lang) && src[i] === '\'') || (_supportsBacktickStrings(lang) && src[i] === '`')) {
        if (src[i] !== '\n') out[i] = ' ';
        stack.push({ kind: 'string', delim: src[i], lang });
        i++;
        continue;
      }
      if (_isWordStartChar(src[i])) {
        const start = i;
        while (i < src.length && _isWordChar(src[i])) i++;
        const word = src.substring(start, i);
        prevToken = REGEX_PRECEDENT_KEYWORDS.has(word) ? 'expr' : 'value';
        continue;
      }
      if (src[i] >= '0' && src[i] <= '9') {
        while (i < src.length && (src[i] === '.' || (src[i] >= '0' && src[i] <= '9'))) i++;
        prevToken = 'value';
        continue;
      }
      if (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n') {
        i++;
        continue;
      }
      if (REGEX_PRECEDENT_CHARS.has(src[i])) {
        prevToken = 'expr';
      } else {
        prevToken = 'value';
      }
      i++;
      continue;
    }
    // Top-level code.
    if (_supportsSlashComments(lang) && src.startsWith('/*', i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      i += 2;
      blockComment = true;
      continue;
    }
    if (_supportsSlashComments(lang) && src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
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
          prevToken = 'value';
          i++;
          continue;
        }
      }
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
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
        const open = lb[0];
        for (let j = 0; j < open.length; j++) {
          if (src[i + j] !== '\n') out[i + j] = ' ';
        }
        i += open.length;
        stack.push({ kind: 'luablock', close: `]${lb[1]}]` });
        continue;
      }
      // Plain `--` line comment (no long-bracket opener follows).
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (_supportsTripleSingleQuoteStrings(lang) && src.startsWith("'''", i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      if (i + 2 < out.length) out[i + 2] = ' ';
      i += 3;
      stack.push({ kind: 'triple', delim: "'''" });
      continue;
    }
    if (_supportsTripleDoubleQuoteStrings(lang) && src.startsWith('"""', i)) {
      out[i] = ' ';
      if (i + 1 < out.length) out[i + 1] = ' ';
      if (i + 2 < out.length) out[i + 2] = ' ';
      i += 3;
      stack.push({ kind: 'triple', delim: '"""' });
      continue;
    }
    if (src[i] === '/' && _isJsLike(lang) && prevToken === 'expr') {
      i = _maskJsRegexLiteral(src, out, i);
      prevToken = 'value';
      continue;
    }
    if (src[i] === '"' || (_supportsSingleQuoteStrings(lang) && src[i] === '\'') || (_supportsBacktickStrings(lang) && src[i] === '`')) {
      if (src[i] !== '\n') out[i] = ' ';
      stack.push({ kind: 'string', delim: src[i], lang });
      i++;
      continue;
    }
    if (_isWordStartChar(src[i])) {
      const start = i;
      while (i < src.length && _isWordChar(src[i])) i++;
      const word = src.substring(start, i);
      prevToken = REGEX_PRECEDENT_KEYWORDS.has(word) ? 'expr' : 'value';
      continue;
    }
    if (src[i] >= '0' && src[i] <= '9') {
      while (i < src.length && (src[i] === '.' || (src[i] >= '0' && src[i] <= '9'))) i++;
      prevToken = 'value';
      continue;
    }
    if (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n') {
      i++;
      continue;
    }
    if (REGEX_PRECEDENT_CHARS.has(src[i])) {
      prevToken = 'expr';
    } else {
      prevToken = 'value';
    }
    i++;
  }
  return out.join('');
}
