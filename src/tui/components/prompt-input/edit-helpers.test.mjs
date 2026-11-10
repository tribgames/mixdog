import assert from 'node:assert/strict';
import test from 'node:test';
import {
  csiBody,
  deleteBackwardChar,
  deleteForwardChar,
  isModifiedEnterSequence,
  leftArrowOffset,
  rightArrowOffset,
} from './edit-helpers.mjs';

const selected = { value: 'alpha beta gamma', cursor: 10, selectionAnchor: 6 };
const caret = { value: 'alpha beta gamma', cursor: 8, selectionAnchor: null };

test('a plain arrow press collapses a live selection to its near edge', () => {
  assert.equal(leftArrowOffset(selected, { word: false, extend: false }), 6);
  assert.equal(rightArrowOffset(selected, { word: false, extend: false }), 10);
});

test('Shift keeps stepping from the caret instead of collapsing the selection', () => {
  assert.equal(leftArrowOffset(selected, { word: false, extend: true }), 9);
  assert.equal(rightArrowOffset(selected, { word: false, extend: true }), 11);
});

test('the word chord steps by word, ignoring a live selection', () => {
  assert.equal(leftArrowOffset(selected, { word: true, extend: false }), 6);
  assert.equal(rightArrowOffset(selected, { word: true, extend: false }), 16);
  assert.equal(leftArrowOffset(caret, { word: true, extend: false }), 6);
  assert.equal(rightArrowOffset(caret, { word: true, extend: false }), 10);
});

test('without a selection the caret steps one character', () => {
  assert.equal(leftArrowOffset(caret, { word: false, extend: false }), 7);
  assert.equal(rightArrowOffset(caret, { word: false, extend: false }), 9);
});

test('Backspace/Delete remove a live selection, else one grapheme around the caret', () => {
  const removed = { value: 'alpha  gamma', cursor: 6, selectionAnchor: null };
  assert.deepEqual(deleteBackwardChar(selected), removed);
  assert.deepEqual(deleteForwardChar(selected), removed);
  assert.deepEqual(deleteBackwardChar(caret), { value: 'alpha bta gamma', cursor: 7, selectionAnchor: null });
  assert.deepEqual(deleteForwardChar(caret), { value: 'alpha bea gamma', cursor: 8, selectionAnchor: null });
  const flag = { value: 'a🇰🇷', cursor: 5, selectionAnchor: null };
  assert.deepEqual(deleteBackwardChar(flag), { value: 'a', cursor: 1, selectionAnchor: null });
});

test('Backspace at the start and Delete at the end leave the draft unchanged', () => {
  const start = { value: 'abc', cursor: 0, selectionAnchor: null };
  const end = { value: 'abc', cursor: 3, selectionAnchor: null };
  assert.equal(deleteBackwardChar(start), start);
  assert.equal(deleteForwardChar(end), end);
});

test('Shift, Alt and Ctrl + Enter are newline chords; plain Enter is not', () => {
  // xterm modifier param = 1 + bitmask (shift=1, alt=2, ctrl=4).
  for (const mod of [2, 3, 5, 4, 7]) {
    assert.equal(isModifiedEnterSequence(`\x1b[13;${mod}u`), true, `kitty mod ${mod}`);
    assert.equal(isModifiedEnterSequence(`\x1b[27;${mod};13~`), true, `modifyOtherKeys mod ${mod}`);
  }
  assert.equal(isModifiedEnterSequence('\x1b[13;1u'), false);
  assert.equal(isModifiedEnterSequence('\x1b[27;1;13~'), false);
  assert.equal(isModifiedEnterSequence('\r'), false);
});

test('csiBody accepts the CSI body with or without its ESC prefix', () => {
  assert.equal(csiBody('\x1b[13;2u'), '13;2u');
  assert.equal(csiBody('[27;5;13~'), '27;5;13~');
  assert.equal(csiBody('13;2u'), '');
});
