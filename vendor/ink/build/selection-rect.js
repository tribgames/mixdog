/**
 * selection-rect.js — double-click word bounds over the rendered cell grid.
 *
 * The grid stores one string per column. A wide glyph (CJK, emoji) keeps its
 * text in the HEAD column and leaves the column it overhangs as '' — a
 * continuation cell that carries the head's styling. Everything here works in
 * GLYPH units so a wide character is never split down the middle.
 *
 * Expansion stops at a character-class change rather than at whitespace, which
 * is what terminals do: double-clicking `foo` takes `foo`, `->` takes `->`, and
 * a path stays whole because terminals count a few punctuation marks as
 * word-forming. iTerm2 publishes that default set as / - + ~ _ . and the
 * backslash is added here so Windows paths behave the same way.
 */

const CLASS_BLANK = 0;
const CLASS_WORD = 1;
const CLASS_SYMBOL = 2;

const WORD_PUNCTUATION = new Set(['_', '/', '.', '-', '+', '~', '\\']);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function carriesWordPunctuation(value) {
  for (const character of value) {
    if (WORD_PUNCTUATION.has(character)) return true;
  }
  return false;
}

/** Blank, word-forming, or plain symbol. Empty and space are both blank. */
export function cellClass(value) {
  if (!value || value === ' ') return CLASS_BLANK;
  return LETTER_OR_DIGIT.test(value) || carriesWordPunctuation(value)
    ? CLASS_WORD
    : CLASS_SYMBOL;
}

/**
 * The glyph occupying `column`, as inclusive head/tail columns. A continuation
 * cell is an empty string directly after a non-blank glyph; anything else that
 * is empty — column 0, a run of empties, an empty after a space — is padding
 * and stands alone.
 */
function glyphAt(cells, column) {
  const continues = (index) => index > 0
    && cells[index] === ''
    && cellClass(cells[index - 1]) !== CLASS_BLANK;
  const head = continues(column) ? column - 1 : column;
  return { head, tail: continues(head + 1) ? head + 1 : head };
}

/**
 * Inclusive rect of the word at (x, y), or null when the cell is blank or out
 * of range. Blank cells deliberately yield nothing so a double-click on the
 * padding around transcript content does not select a run of spaces.
 */
export function wordRectAt(rows, x, y) {
  const cells = Array.isArray(rows?.[y]) ? rows[y] : null;
  if (!cells) return null;

  const origin = glyphAt(cells, x);
  const wordClass = cellClass(cells[origin.head]);
  if (wordClass === CLASS_BLANK) return null;

  let first = origin.head;
  while (first > 0) {
    const previous = glyphAt(cells, first - 1);
    if (cellClass(cells[previous.head]) !== wordClass) break;
    first = previous.head;
  }

  let last = origin.tail;
  while (last + 1 < cells.length) {
    const next = glyphAt(cells, last + 1);
    if (cellClass(cells[next.head]) !== wordClass) break;
    last = next.tail;
  }

  return { x1: first, y1: y, x2: last, y2: y };
}
