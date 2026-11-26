import assert from 'node:assert/strict';
import test from 'node:test';

import { dragEdgeScrollDelta, mergeNewAtDefault } from './use-persisted-list-order.ts';

test('a saved order missing a newer id keeps that id at its default place', () => {
  const ids = ['agents', 'favorites', 'projects', 'recent', 'archived'];
  // Bots joined the section order after users had saved one: they stay on top.
  assert.deepEqual(mergeNewAtDefault(['recent', 'projects'], ids), [
    'agents',
    'favorites',
    'recent',
    'archived',
    'projects',
  ]);
  // The status groups joined later still: they follow Favorites wherever the user put it.
  const withStatus = ['agents', 'favorites', 'needs', 'working', 'recent', 'projects', 'archived'];
  assert.deepEqual(mergeNewAtDefault(['recent', 'favorites', 'agents', 'projects', 'archived'], withStatus), [
    'recent',
    'favorites',
    'needs',
    'working',
    'agents',
    'projects',
    'archived',
  ]);
  // A saved order that already places them keeps them there; the rest follow their default neighbours.
  assert.deepEqual(mergeNewAtDefault(['projects', 'agents'], ids), [
    'projects',
    'recent',
    'archived',
    'agents',
    'favorites',
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
