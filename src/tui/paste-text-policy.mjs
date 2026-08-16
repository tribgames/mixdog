// Pasted-text folding policy, shared by the TUI prompt and the desktop
// composer so both surfaces fold the SAME pastes into the same chip token.
// A big paste is replaced in the prompt by a compact token so the editor does
// not choke on thousands of raw characters; the original text lives in the
// surface's pasted-text map and is expanded back on submit.
export const PASTE_TOKEN_MIN_LINES = 10;
export const PASTE_TOKEN_MIN_CHARS = 200;

// VISIBLE lines: a copy that ends in a newline ("a\nb\n") is two lines, not
// three. Counting the empty trailing chunk folded ordinary two-line copies
// into chips and mislabelled the chip's line count.
export function pastedTextLineCount(text) {
  const value = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!value) return 0;
  return value.split('\n').length;
}

export function shouldFoldPastedText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  return pastedTextLineCount(value) >= PASTE_TOKEN_MIN_LINES
    || value.length > PASTE_TOKEN_MIN_CHARS;
}

export function formatPastedTextRef(id, text) {
  return `[Pasted text #${id} +${pastedTextLineCount(text)} lines]`;
}
