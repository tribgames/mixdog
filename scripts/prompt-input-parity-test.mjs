import test from 'node:test';
import assert from 'node:assert/strict';

import {
  caretPosition,
  offsetAtCell,
  verticalOffset,
} from '../src/tui/input-editing.mjs';
import {
  promptContentRows,
  wrappedTextRows,
} from '../src/tui/app/text-layout.mjs';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Reference the pre-optimization behavior: enumerate every grapheme boundary,
// then independently rescan its prefix through caretPosition().
function referenceBoundaryPositions(text, width) {
  const value = String(text || '');
  const offsets = [0];
  for (const { index, segment } of graphemeSegmenter.segment(value)) {
    offsets.push(index + segment.length);
  }
  return [...new Set(offsets)]
    .map((offset) => ({ offset, ...caretPosition(value, offset, width) }));
}

function referenceOffsetAtCell(text, row, col, width) {
  const positions = referenceBoundaryPositions(text, width);
  let best = positions[0];
  let bestScore = Infinity;
  for (const position of positions) {
    const score = Math.abs(position.row - row) * 100000
      + Math.abs(position.col - col);
    if (score < bestScore) {
      best = position;
      bestScore = score;
    }
  }
  return best.offset;
}

function referenceVerticalOffset(text, offset, width, direction, preferredColumn = null) {
  const current = caretPosition(text, offset, width);
  const targetColumn = Number.isFinite(preferredColumn) ? preferredColumn : current.col;
  const targetRow = current.row + direction;
  if (targetRow < 0) return { cursor: offset, preferredColumn: targetColumn };

  const candidates = referenceBoundaryPositions(text, width)
    .filter((position) => position.row === targetRow);
  if (candidates.length === 0) return { cursor: offset, preferredColumn: targetColumn };

  let best = candidates[0];
  for (const candidate of candidates) {
    const bestDistance = Math.abs(best.col - targetColumn);
    const candidateDistance = Math.abs(candidate.col - targetColumn);
    if (
      candidateDistance < bestDistance
      || (
        candidateDistance === bestDistance
        && candidate.col <= targetColumn
        && candidate.col > best.col
      )
    ) {
      best = candidate;
    }
  }
  return { cursor: best.offset, preferredColumn: targetColumn };
}

const parityCases = [
  { name: 'combining marks', text: 'Ae\u0301o\u0308Z' },
  { name: 'emoji ZWJ sequences', text: 'a👨‍👩‍👧‍👦b👩🏽‍💻c' },
  { name: 'wide CJK', text: 'ab界語cd漢字' },
  { name: 'newlines at wrap boundaries', text: 'abc\n123456\n界a\nxyz' },
  { name: 'trailing spaces', text: 'abc   \nxy  ' },
  { name: 'tabs', text: 'a\tbc\t\n\tde' },
  { name: 'ambiguous-width characters', text: 'A·Ω—α※B' },
];

test('mouse hit-testing matches prefix-rescan reference for complex graphemes and wrapping', () => {
  const widths = [1, 2, 3, 4, 5, 7];
  for (const { name, text } of parityCases) {
    for (const width of widths) {
      const positions = referenceBoundaryPositions(text, width);
      const lastRow = Math.max(...positions.map((position) => position.row));
      for (let row = -1; row <= lastRow + 2; row += 1) {
        for (let col = -1; col <= width + 2; col += 1) {
          assert.equal(
            offsetAtCell(text, row, col, width),
            referenceOffsetAtCell(text, row, col, width),
            `${name}: width=${width}, row=${row}, col=${col}`,
          );
        }
      }
    }
  }
});

test('prompt row cache stays isolated across alternating text and width keys', () => {
  const alternatingPairs = [
    ['x', 4],
    ['abcdefghijkl', 4],
    ['x', 4],
    ['abc界', 3],
    ['abc界', 7],
    ['Ae\u0301o\u0308Z', 7],
    ['abc界', 3],
    ['Ae\u0301o\u0308Z', 2],
    ['👨‍👩‍👧‍👦 trailing  ', 5],
    ['abc界', 7],
    ['👨‍👩‍👧‍👦 trailing  ', 1],
    ['Ae\u0301o\u0308Z', 2],
  ];

  for (const [text, width] of alternatingPairs) {
    assert.equal(
      promptContentRows(text, width),
      wrappedTextRows(`${text} `, width),
      `prompt rows: text=${JSON.stringify(text)}, width=${width}`,
    );
  }
});

test('vertical navigation matches reference while widths alternate between calls', () => {
  // Deliberately revisit values non-consecutively so a future single-entry
  // boundary/layout cache cannot accidentally reuse positions from another width.
  const alternatingWidths = [2, 7, 3, 6, 1, 5, 2, 4, 7, 3];
  const preferredColumns = [null, 0, 1, 3, 8];
  for (const { name, text } of parityCases) {
    for (const width of alternatingWidths) {
      for (let offset = 0; offset <= text.length; offset += 1) {
        for (const direction of [-1, 1]) {
          for (const preferredColumn of preferredColumns) {
            assert.deepEqual(
              verticalOffset(text, offset, width, direction, preferredColumn),
              referenceVerticalOffset(text, offset, width, direction, preferredColumn),
              `${name}: width=${width}, offset=${offset}, direction=${direction}, preferred=${preferredColumn}`,
            );
          }
        }
      }
    }
  }
});
