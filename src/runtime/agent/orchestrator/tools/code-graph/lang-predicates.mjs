// Per-language lexical predicates + JS tokenizer character/keyword sets.
// Pure functions, no state. Extracted verbatim from code-graph.mjs; shared
// by the text masker, symbol index, and search/format layers.

export function _langUsesDollarInIdentifiers(lang) {
  // `$` is a valid identifier char only in JS/TS/PHP. The 5 new langs are
  // deliberately excluded: kotlin/swift/scala/lua have no `$` in identifiers,
  // and bash's `$` is a variable-expansion sigil (`$var`), not an identifier
  // char — treating it as a word-boundary char would mis-tokenize.
  // Second batch (dart/objc/elixir/zig/r) likewise excluded: none use `$` as
  // an identifier char (objc `$` is invalid; elixir/dart/zig/r have no `$` in
  // names), so they stay out.
  return lang === 'javascript' || lang === 'typescript' || lang === 'php';
}

export function _langAllowsBangQuestionSuffix(lang) {
  // Method names may end in `!`/`?` only in ruby (`save!`/`empty?`) and rust
  // (`!` macros). Kotlin is NOT here: its `!!` is the not-null assertion
  // OPERATOR, not an identifier suffix — including it would fold `foo!!` into
  // the `foo` reference and break matching. swift `?`/`!` are optional/
  // force-unwrap operators (not name chars); scala/bash/lua have no suffix.
  // Second batch: elixir function names may end in `?`/`!` (`valid?`/`save!`)
  // exactly like ruby → included. dart/objc/zig/r have no such suffix.
  return lang === 'ruby' || lang === 'rust' || lang === 'elixir';
}

export function _supportsHashComments(lang) {
  // Hash-comment langs: python/ruby/php plus bash. lua is NOT hash — it uses
  // `--` line + `--[[ ]]` block comments (see _maskNonCodeText). kotlin/
  // swift/scala are slash-comment C-family (see _supportsSlashComments).
  // Second batch: elixir and r are `#`-only line-comment langs → included.
  // (dart/objc/zig are slash-comment, handled by _supportsSlashComments.)
  return lang === 'python' || lang === 'ruby' || lang === 'php'
    || lang === 'bash' || lang === 'elixir' || lang === 'r';
}

export function _supportsSlashComments(lang) {
  // Slash-comment langs: everything C-family, incl. new kotlin/swift/scala.
  // Excluded: python/ruby/bash (hash) and lua (`--` comments; `//` is lua
  // integer division, so it must not be treated as a comment opener).
  // Second batch: dart/objc/zig are C-family slash-comment (kept by the
  // default). Excluded here: elixir/r (hash-only, see _supportsHashComments).
  return lang !== 'python' && lang !== 'ruby'
    && lang !== 'bash' && lang !== 'lua'
    && lang !== 'elixir' && lang !== 'r';
}

export function _supportsSingleQuoteStrings(lang) {
  return lang === 'typescript'
    || lang === 'javascript'
    || lang === 'python'
    || lang === 'ruby'
    || lang === 'php'
    // New langs with single-quote string literals: swift uses double quotes
    // only (excluded); kotlin uses double/triple-double (excluded); scala
    // single-quotes are Char literals not strings (excluded); bash and lua
    // both support `'...'` single-quoted strings.
    || lang === 'bash'
    || lang === 'lua'
    // Second batch. dart: `'...'` is a primary string form → included. r:
    // `'...'` is a string literal equivalent to `"..."` → included. objc:
    // `'x'` is a char literal — INCLUDED here so its contents are masked as a
    // single-quote string. This deliberately DIVERGES from c/cpp, which are
    // NOT in this list: objc's masker benefits from neutralizing char-literal
    // bytes, whereas c/cpp char literals are left unmasked.
    // elixir: EXCLUDED — `'...'` is a charlist, not a string; but charlists
    // are single-line and `\\`-escaped just like a string, so masking them as
    // strings would be safe — they are nonetheless left out to keep elixir
    // string handling limited to `"..."`/`"""` (charlist contents are rare in
    // code-graph anchors and excluding avoids masking a stray apostrophe in a
    // comment-less context). zig: EXCLUDED — `'c'` is a char literal only and
    // zig multiline strings are `\\`-prefixed lines (out of scope), so no
    // single-quote string form applies.
    || lang === 'dart'
    || lang === 'r'
    || lang === 'objc';
}

export function _supportsBacktickStrings(lang) {
  return lang === 'typescript' || lang === 'javascript' || lang === 'go';
}

export function _supportsTripleSingleQuoteStrings(lang) {
  // `'''` triple-single-quote strings: python, and dart (which supports BOTH
  // `'''` and `"""` multiline strings). kotlin/scala/swift have `"""` but NOT
  // `'''`; treating `'''` as a string opener there would mis-mask a
  // single-quote char/string followed by an empty string.
  return lang === 'python' || lang === 'dart';
}

export function _supportsTripleDoubleQuoteStrings(lang) {
  // `"""` triple-double-quote raw/multiline strings: python, kotlin, scala
  // and swift. bash/lua have no triple-quote form (lua long strings use
  // `[[ ]]`).
  // Second batch: elixir `"""` heredoc docstrings → included. dart supports
  // BOTH `'''` and `"""` multiline strings → included here (and in the triple-
  // single predicate). objc/zig/r have no `"""` form.
  return lang === 'python' || lang === 'kotlin'
    || lang === 'scala' || lang === 'swift' || lang === 'elixir'
    || lang === 'dart';
}

export function _isJsLike(lang) {
  return lang === 'javascript' || lang === 'typescript';
}

export function _isWordStartChar(c) {
  return c === '_' || c === '$'
    || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

export function _isWordChar(c) {
  return _isWordStartChar(c) || (c >= '0' && c <= '9');
}

// ECMAScript expression-context keywords that can precede a regex literal.
// After any of these, a `/` opens a RegExp literal; after a value (identifier,
// number, `)`, `]`), `/` is the division operator. This list is from the
// language spec — not a heuristic — and resolves the `/`-ambiguity.
export const REGEX_PRECEDENT_KEYWORDS = new Set([
  'return', 'typeof', 'delete', 'void', 'new', 'throw', 'await', 'yield',
  'in', 'of', 'instanceof', 'case', 'do', 'else', 'if', 'while',
]);

export const REGEX_PRECEDENT_CHARS = new Set([
  '=', '(', ',', ';', ':', '?', '!', '~', '&', '|', '^', '+', '-',
  '*', '%', '<', '>', '{', '[',
]);
