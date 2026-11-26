import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { dragEdgeScrollDelta, mergeNewAtDefault, usePersistedListOrder } from './use-persisted-list-order.ts';

// A session row dragged while its list re-rendered it away stayed dimmed for good: its drag never ended for the list.
test('a row removed from the list mid-drag is no longer the dragged row once its drag ends', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  function List({ ids }) {
    const order = usePersistedListOrder('test:list-order', ids, { onCommit: () => {} });
    return React.createElement(
      'ul',
      null,
      ids.map((id) => {
        const { draggable, onDragStart, onDragEnd, 'data-reordering': reordering } = order.getReorderProps(id);
        return React.createElement('li', { key: id, id, draggable, onDragStart, onDragEnd, 'data-reordering': reordering });
      })
    );
  }
  const render = (ids) => act(async () => root.render(React.createElement(List, { ids })));
  await render(['a', 'b']);
  const dragged = document.getElementById('a');
  const start = new window.Event('dragstart', { bubbles: true });
  Object.defineProperty(start, 'dataTransfer', { value: { setData() {}, effectAllowed: '' } });
  await act(async () => dragged.dispatchEvent(start));
  assert.equal(dragged.getAttribute('data-reordering'), 'true');

  await render(['b']);
  await act(async () => dragged.dispatchEvent(new window.Event('dragend', { bubbles: true })));
  await render(['a', 'b']);
  assert.equal(document.getElementById('a').getAttribute('data-reordering'), null);
});

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
