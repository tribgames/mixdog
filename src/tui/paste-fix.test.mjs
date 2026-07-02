import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {
  shouldFoldPastedText,
  formatPastedTextRef,
  pastedTextReferenceIds,
  expandPastedTextTokens,
} from './paste-attachments.mjs';
import { caretPosition } from './input-editing.mjs';

// --- Part 1: pasted-text token folding ----------------------------------

test('shouldFoldPastedText fires on >=3 lines or >200 chars', () => {
  assert.equal(shouldFoldPastedText('a\nb\nc'), true);        // 3 lines
  assert.equal(shouldFoldPastedText('a\nb'), false);          // 2 lines, short
  assert.equal(shouldFoldPastedText('x'.repeat(201)), true);  // > 200 chars
  assert.equal(shouldFoldPastedText('x'.repeat(200)), false); // == 200, not over
  assert.equal(shouldFoldPastedText(''), false);
});

test('token round-trips through format + expand', () => {
  const original = 'line1\nline2\nline3';
  const token = formatPastedTextRef(7, original);
  assert.equal(token, '[Pasted text #7 +3 lines]');
  const refs = pastedTextReferenceIds(`before ${token} after`);
  assert.deepEqual([...refs], [7]);
  const map = { 7: { id: 7, text: original } };
  assert.equal(
    expandPastedTextTokens(`before ${token} after`, map),
    `before ${original} after`,
  );
});

test('broken / partially-deleted tokens do not expand', () => {
  const map = { 3: { id: 3, text: 'HIDDEN' } };
  // Missing the "+N lines" tail — not a valid token, left verbatim.
  assert.equal(expandPastedTextTokens('[Pasted text #3]', map), '[Pasted text #3]');
  // Truncated bracket.
  assert.equal(expandPastedTextTokens('[Pasted text #3 +2 lines', map), '[Pasted text #3 +2 lines');
  // Unknown id stays as-is.
  assert.equal(expandPastedTextTokens('[Pasted text #9 +2 lines]', map), '[Pasted text #9 +2 lines]');
});

// --- Part 2: caret row math vs ink wrap-ansi (hard, wordWrap:false) -------

// Faithful re-implementation of wrap-ansi's wrapWord loop for a single
// space-free line (the prompt caret math walks graphemes the same way). ink
// renders <Text wrap="hard"> which calls wrapAnsi(text, w, {hard,wordWrap:false}).
// For a run with no spaces the whole line goes through wrapWord, so the visual
// row count is what this produces.
function inkWrapWordRows(line, columns) {
  const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line), (s) => s.segment);
  let rows = 1;
  let visible = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const cw = stringWidth(chars[i]);
    if (visible + cw <= columns) {
      // stays on current row
    } else {
      rows += 1;
      visible = 0;
    }
    visible += cw;
    if (visible === columns && i < chars.length - 1) {
      rows += 1;
      visible = 0;
    }
  }
  return rows;
}

// caretPosition row for the END of the string == (visual row count - 1).
function caretRowsForWholeString(text, w) {
  return caretPosition(text, text.length, w).row + 1;
}

test('caret rows agree with ink wrap for wide-char lines at odd widths', () => {
  // A width where a width-2 glyph cannot sit flush on the last column exposes
  // the mismatch: caretPosition must NOT advance an extra row when the char is
  // simply pushed to the next line (ink does the same — it never leaves a
  // half-column then over-counts).
  const cases = [
    { text: '가'.repeat(30), w: 41 },
    { text: '가'.repeat(30), w: 40 },
    { text: '가나다'.repeat(10) + 'ascii', w: 13 },
    { text: '한글'.repeat(8), w: 7 },
    { text: '가'.repeat(5), w: 2 },
  ];
  for (const { text, w } of cases) {
    assert.equal(
      caretRowsForWholeString(text, w),
      inkWrapWordRows(text, w),
      `width ${w} on ${JSON.stringify(text.slice(0, 6))}…`,
    );
  }
});

// Cursor exactly at a soft-wrap boundary MID-text: ink renders the following
// glyph on the next row, so the caret must report {row N+1, col 0}, never
// {row N, col == w} (which would sit outside the box).
test('caret at mid-text wrap boundary rolls to next row (col 0)', () => {
  const value = '가나다라마';        // 5 wide glyphs, width 2 each
  const w = 4;                        // 2 glyphs per row
  // offset 2 = after '나' (each glyph is ONE UTF-16 unit) = end of visual
  // row 0; content ('다라마') follows, so the caret rolls to the next row.
  const at = caretPosition(value, 2, w);
  assert.deepEqual(at, { row: 1, col: 0 }, 'boundary caret must sit on next row');
  // offset 4 = after '라' = end of visual row 1 (rows 0-1 are full).
  assert.deepEqual(caretPosition(value, 4, w), { row: 2, col: 0 }, 'second boundary rolls too');
  // Cursor at the very end of a FLUSH-ending text ('가나다라' fills rows 0-1
  // exactly) with a trailing cell (PromptInput appends one) also rolls.
  const flush = '가나다라';
  const end = caretPosition(flush, flush.length, w, true);
  assert.deepEqual(end, { row: 2, col: 0 }, 'flush end with trailing cell rolls to next row');
  // Non-flush end ('마' leaves col 2) must NOT roll even with a trailing cell.
  const nonFlush = caretPosition(value, value.length, w, true);
  assert.deepEqual(nonFlush, { row: 2, col: 2 }, 'non-flush end stays on its row');
});
