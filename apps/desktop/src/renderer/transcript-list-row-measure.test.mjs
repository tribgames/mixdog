import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

/** Mounts one list commit over `rows` (row elements with their boxes) and
 *  returns the sizes the commit's measurement applied. */
async function measureCommit(t, boxes) {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement'] });
  const { useMountedRowMeasurement } = await import('./transcript-list-row-measure.ts');
  const spacer = document.createElement('div');
  const keys = boxes.map((_, index) => `row-${index}`);
  boxes.forEach((box, index) => {
    const row = document.createElement('div');
    row.className = 'transcript-virtual-row';
    row.dataset.index = String(index);
    row.dataset.timelineKey = keys[index];
    row.append(document.createElement('div'));
    if (box.pending) row.firstElementChild.setAttribute('data-transcript-pending', '');
    row.getBoundingClientRect = () => ({ top: 0, left: 0, right: box.width, bottom: box.height, ...box });
    spacer.append(row);
  });
  document.body.append(spacer);
  const applied = [];
  const core = {
    options: { anchorTo: 'end', getItemKey: (index) => keys[index] },
    itemSizeCache: new Map(),
    // Every row was laid out at the flat 60px estimate.
    measurementsCache: keys.map((key, index) => ({ key, index, start: index * 60, end: index * 60 + 60, size: 60 })),
    // virtual-core's resizeItem is a bound arrow property.
    resizeItem: (index, size) => {
      applied.push([index, size]);
      core.itemSizeCache.set(keys[index], size);
    },
  };
  function Harness() {
    useMountedRowMeasurement({
      rows: useRef(keys.map((key) => ({ _tag: 'AssistantPart', key }))).current,
      spacer: useRef(spacer),
      virtualizerRef: useRef(core),
      baseResizeItem: useRef((index, size) => core.resizeItem(index, size)),
      pendingResizes: useRef(new Map()),
      indexForPendingKey: (_key, hint) => hint,
      laidOutRows: useRef([]),
      pendingAnchor: useRef(null),
      anchorHold: useRef(null),
      restoreReadingAnchor() {},
    });
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  return applied;
}

test('a laid-out row that paints nothing takes 0px in its own commit, not its estimate', async (t) => {
  // A reaction-only reply in an agent chat renders null inside its row: the
  // row is as wide as the timeline and 0px tall, and no ResizeObserver entry
  // ever reports that box.
  const applied = await measureCommit(t, [
    { width: 720, height: 106 },
    { width: 720, height: 0 },
  ]);
  assert.deepEqual(applied, [
    [0, 106],
    [1, 0],
  ]);
});

test('a page landing above the reader reads each mounted row once in its commit', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement'] });
  window.requestAnimationFrame = () => 0;
  const { useMountedRowMeasurement } = await import('./transcript-list-row-measure.ts');
  const spacer = document.createElement('div');
  const keys = ['row-0', 'row-1', 'row-2'];
  const reads = new Map();
  keys.forEach((key, index) => {
    const row = document.createElement('div');
    row.dataset.index = String(index);
    row.dataset.timelineKey = key;
    row.getBoundingClientRect = () => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return { top: 0, left: 0, right: 720, bottom: 90, width: 720, height: 90 };
    };
    spacer.append(row);
  });
  document.body.append(spacer);
  const core = {
    options: { anchorTo: 'start', getItemKey: (index) => keys[index] },
    itemSizeCache: new Map(),
    measurementsCache: keys.map((key, index) => ({ key, index, start: index * 60, end: index * 60 + 60, size: 60 })),
    resizeItem: (index, size) => core.itemSizeCache.set(keys[index], size),
  };
  const restores = [];
  let setRows;
  function Harness() {
    const [rows, set] = React.useState(() => keys.map((key) => ({ _tag: 'AssistantPart', key })));
    setRows = set;
    const pendingAnchor = useRef(null);
    useMountedRowMeasurement({
      rows,
      spacer: useRef(spacer),
      virtualizerRef: useRef(core),
      baseResizeItem: useRef((index, size) => core.resizeItem(index, size)),
      pendingResizes: useRef(new Map()),
      // The anchor moved down: older rows landed above it.
      indexForPendingKey: (key, hint) => (key === 'anchor' ? hint + 2 : hint),
      laidOutRows: useRef([]),
      pendingAnchor,
      anchorHold: useRef(null),
      restoreReadingAnchor: (landing) => restores.push(Boolean(landing)),
    });
    globalThis.__pendingAnchor = pendingAnchor;
    return null;
  }
  t.after(() => {
    delete globalThis.__pendingAnchor;
  });
  await act(async () => root.render(React.createElement(Harness)));
  reads.clear();
  restores.length = 0;
  await act(async () => {
    globalThis.__pendingAnchor.current = { base: [], anchor: { key: 'anchor', index: 0, offset: 0 } };
    setRows((rows) => [...rows]);
  });
  assert.deepEqual([...reads.values()], [1, 1, 1], 'one layout read per row, not one per effect');
  assert.deepEqual(restores, [true]);
});

test('a row pending at 0px takes it; only a hidden pane keeps the size the timeline holds', async (t) => {
  // An unread turn-changes card marks its row pending; in a reaction-only
  // turn it then resolves to nothing without any box change to observe.
  const applied = await measureCommit(t, [
    { width: 0, height: 0 },
    { width: 720, height: 0, pending: true },
  ]);
  assert.deepEqual(applied, [[1, 0]]);
});
