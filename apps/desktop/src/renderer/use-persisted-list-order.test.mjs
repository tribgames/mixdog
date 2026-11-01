import assert from 'node:assert/strict';
import test from 'node:test';

import { dragEdgeScrollDelta, mergeNewAtDefault } from './use-persisted-list-order.ts';

test('a saved order missing a newer id keeps that id at its default place', () => {
  const ids = ['agents', 'favorites', 'projects', 'recent', 'archived'];
  // Bots joined the section order after users had saved one: they stay on top.
  assert.deepEqual(mergeNewAtDefault(['recent', 'projects'], ids), [
    'agents',
    'recent',
    'projects',
    'favorites',
    'archived',
  ]);
  // A saved order that already places them keeps them there; other missing ids go last.
  assert.deepEqual(mergeNewAtDefault(['projects', 'agents'], ids), [
    'projects',
    'agents',
    'favorites',
    'recent',
    'archived',
  ]);
});

test('drag edge scrolling accelerates toward and beyond the top edge', () => {
  assert.equal(dragEdgeScrollDelta(148, 100, 500), 0);
  assert.equal(dragEdgeScrollDelta(124, 100, 500), -9);
  assert.equal(dragEdgeScrollDelta(100, 100, 500), -18);
  assert.equal(dragEdgeScrollDelta(80, 100, 500), -18);
});

test('drag edge scrolling accelerates toward and beyond the bottom edge', () => {
  assert.equal(dragEdgeScrollDelta(452, 100, 500), 0);
  assert.equal(dragEdgeScrollDelta(476, 100, 500), 9);
  assert.equal(dragEdgeScrollDelta(500, 100, 500), 18);
  assert.equal(dragEdgeScrollDelta(520, 100, 500), 18);
});
