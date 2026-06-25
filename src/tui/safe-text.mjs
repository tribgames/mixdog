/**
 * Terminal-safe UI text normalization.
 *
 * Keep user/content Unicode and Mixdog's own UI glyphs intact. No glyph
 * substitution is performed. The only normalization provided is deterministic
 * newline normalization (CRLF/CR -> LF) for paste handling.
 */

/**
 * Identity pass-through — retained so existing import sites compile without
 * changes. Returns the string value unchanged; no glyph substitution.
 */
export function terminalSafeText(value) {
  return String(value ?? '');
}

/** Structural UI glyphs are no longer downgraded by environment flags. */
export function asciiUiEnabled() {
  return false;
}

/** Normalize line endings: CRLF and bare CR -> LF. */
export function normalizeLineEndings(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}
