import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moveCursor,
  previousWordOffset,
  nextWordOffset,
  selectionRange,
  verticalOffset,
  wordRangeAt,
  lineStart,
  lineEnd,
} from './input-editing.mjs';

// Whole-word extend (Ctrl+Shift+Left/Right) relies on moveCursor(extend:true)
// starting/keeping an anchor while jumping by word.
test('ctrl+shift+right extends selection by whole word', () => {
  const draft = { value: 'hello world foo', cursor: 0, selectionAnchor: null };
  const next = moveCursor(draft, nextWordOffset(draft.value, draft.cursor), { extend: true });
  assert.equal(next.cursor, 'hello'.length);
  assert.equal(next.selectionAnchor, 0);
  assert.deepEqual(selectionRange(next), { start: 0, end: 5 });
});

test('ctrl+shift+left extends selection backward by whole word', () => {
  const value = 'hello world';
  const draft = { value, cursor: value.length, selectionAnchor: null };
  const next = moveCursor(draft, previousWordOffset(value, value.length), { extend: true });
  assert.equal(next.selectionAnchor, value.length);
  assert.deepEqual(selectionRange(next), { start: 'hello '.length, end: value.length });
});

// Shift+Up on the first line yields no vertical move (targetRow < 0) → callers
// then extend to document start (offset 0).
test('verticalOffset returns same cursor on first line (up)', () => {
  const value = 'line1\nline2';
  const moved = verticalOffset(value, 2, 80, -1, null);
  assert.equal(moved.cursor, 2, 'no vertical move available above first line');
});

test('shift+up to document start extends selection to offset 0', () => {
  const value = 'abc';
  const draft = { value, cursor: 2, selectionAnchor: null };
  const next = moveCursor(draft, 0, { extend: true });
  assert.deepEqual(selectionRange(next), { start: 0, end: 2 });
});

test('shift+down to document end extends selection to value.length', () => {
  const value = 'abc';
  const draft = { value, cursor: 1, selectionAnchor: null };
  const next = moveCursor(draft, value.length, { extend: true });
  assert.deepEqual(selectionRange(next), { start: 1, end: 3 });
});

// Double-click word select: clicking anywhere inside a word run selects the
// whole run, and a click on punctuation/whitespace selects that run instead.
test('wordRangeAt selects the word run under the offset', () => {
  const value = 'hello world foo';
  assert.deepEqual(wordRangeAt(value, 2), { start: 0, end: 5 });
  assert.deepEqual(wordRangeAt(value, 6), { start: 6, end: 11 });
  assert.deepEqual(wordRangeAt(value, 0), { start: 0, end: 5 });
  assert.deepEqual(wordRangeAt(value, value.length), { start: 12, end: 15 });
});

test('wordRangeAt selects a punctuation/whitespace run distinctly from words', () => {
  const value = 'foo---bar';
  assert.deepEqual(wordRangeAt(value, 4), { start: 3, end: 6 });
});

// Triple-click line select uses lineStart/lineEnd directly.
test('lineStart/lineEnd bound the current line for triple-click select', () => {
  const value = 'line1\nline2\nline3';
  const offset = value.indexOf('line2') + 2;
  assert.equal(lineStart(value, offset), 6);
  assert.equal(lineEnd(value, offset), 11);
});
