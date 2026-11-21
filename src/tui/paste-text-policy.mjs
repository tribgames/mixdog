// Same rule as Claude Code / Codex (LARGE_PASTE_CHAR_THRESHOLD): only a paste
// longer than this many characters folds; the line count never matters.
export const PASTE_TOKEN_MIN_CHARS = 1000;

// VISIBLE lines: a copy that ends in a newline ("a\nb\n") is two lines, not
// three. Counting the empty trailing chunk folded ordinary two-line copies
// into chips and mislabelled the chip's line count.
export function pastedTextLineCount(text) {
  const value = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '');
  if (!value) return 0;
  return value.split('\n').length;
}

export function shouldFoldPastedText(text) {
  return String(text ?? '').length > PASTE_TOKEN_MIN_CHARS;
}

export function formatPastedTextRef(id, text) {
  return `[Pasted text #${id} +${pastedTextLineCount(text)} lines]`;
}
