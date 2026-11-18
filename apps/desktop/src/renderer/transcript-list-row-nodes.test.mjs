import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranscriptRowNodes } from './transcript-list-row-nodes.ts';

const rowsOf = (paints) => paints.map((paint, index) => ({ _tag: 'AssistantPart', key: String(index), paint }));

test('painted neighbours skip blank rows and each row renders at most once', () => {
  const rows = rowsOf([true, false, false, true, false, true, false]);
  const calls = [];
  const nodes = createTranscriptRowNodes(rows, (row, index) => {
    calls.push(index);
    return row.paint ? `row-${index}` : null;
  });
  assert.equal(nodes.paintedAbove(3), 0);
  assert.equal(nodes.paintedBelow(0), 3);
  assert.equal(nodes.paintedAbove(5), 3);
  assert.equal(nodes.paintedBelow(5), 7);
  assert.equal(nodes.paintedAbove(0), -1);
  // Blank rows inside an already walked run reuse its answer.
  assert.equal(nodes.paintedAbove(2), 0);
  assert.equal(nodes.paintedBelow(1), 3);
  assert.equal(nodes.paintedBelow(6), 7);
  assert.equal(nodes.nodeAt(3), 'row-3');
  assert.equal(new Set(calls).size, calls.length, 'no row rendered twice');
  assert.ok(!calls.includes(5), 'a row is rendered only when something reads it');
});

test('a run walked from below agrees with a fresh walk', () => {
  const paints = [false, true, false, false, false, true, false, false, true];
  const rows = rowsOf(paints);
  const render = (row) => (row.paint ? 'x' : false);
  const cached = createTranscriptRowNodes(rows, render);
  for (let index = rows.length - 1; index >= 0; index -= 1) cached.paintedAbove(index);
  for (let index = 0; index < rows.length; index += 1) {
    const fresh = createTranscriptRowNodes(rows, render);
    assert.equal(cached.paintedAbove(index), fresh.paintedAbove(index), `above ${index}`);
    assert.equal(cached.paintedBelow(index), fresh.paintedBelow(index), `below ${index}`);
    let above = index - 1;
    while (above >= 0 && !paints[above]) above -= 1;
    let below = index + 1;
    while (below < rows.length && !paints[below]) below += 1;
    assert.equal(fresh.paintedAbove(index), above);
    assert.equal(fresh.paintedBelow(index), below);
  }
});
