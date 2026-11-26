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

test('a measured row whose neighbours changed its spacing is read again in that commit, before the spacer is written', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement'] });
  const { useMountedRowMeasurement } = await import('./transcript-list-row-measure.ts');
  const spacer = document.createElement('div');
  const row = document.createElement('div');
  row.dataset.index = '0';
  row.dataset.timelineKey = 'reply';
  const content = document.createElement('div');
  row.append(content);
  let height = 26;
  row.getBoundingClientRect = () => ({ top: 0, left: 0, right: 720, bottom: height, width: 720, height });
  spacer.append(row);
  document.body.append(spacer);
  const applied = [];
  const core = {
    options: { anchorTo: 'end', getItemKey: () => 'reply' },
    itemSizeCache: new Map(),
    measurementsCache: [{ key: 'reply', index: 0, start: 0, end: 60, size: 60 }],
    resizeItem: (index, size) => {
      applied.push([index, size]);
      core.itemSizeCache.set('reply', size);
    },
  };
  let rerender;
  function Harness() {
    const [, set] = React.useState(0);
    rerender = () => set((n) => n + 1);
    useMountedRowMeasurement({
      rows: useRef([{ _tag: 'AssistantPart', key: 'reply' }]).current,
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
  assert.deepEqual(applied, [[0, 26]], 'read once as it mounted');
  // A tool card arrives above the streaming reply: the reply takes the part step.
  content.dataset.stepBefore = 'true';
  height = 34;
  await act(async () => rerender());
  assert.deepEqual(applied, [
    [0, 26],
    [0, 34],
  ]);
  // A commit that changes nothing around it reads nothing.
  await act(async () => rerender());
  assert.equal(applied.length, 2);
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

test('unrelated re-renders do not re-read mounted rows, no duplicate ResizeObserver is created, hidden 0x0 rows preserve --transcript-measured-height, and scroll mounts drain synchronously before parent layout effects', async (t) => {
  const resizeObservers = [];
  class FakeResizeObserver {
    constructor() {
      resizeObservers.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const { root, document } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement'],
    globals: { ResizeObserver: FakeResizeObserver },
  });
  const { useMountedRowMeasurement } = await import('./transcript-list-row-measure.ts');
  const spacer = document.createElement('div');
  const reads = new Map();
  const heights = new Map([
    ['row-0', { width: 720, height: 80 }],
    ['row-1', { width: 720, height: 90 }],
    ['row-2', { width: 720, height: 110 }],
    ['row-hidden', { width: 0, height: 0 }],
  ]);
  const makeRow = (key, index) => {
    const row = document.createElement('div');
    row.dataset.index = String(index);
    row.dataset.timelineKey = key;
    row.append(document.createElement('div'));
    row.getBoundingClientRect = () => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      const box = heights.get(key) ?? { width: 0, height: 0 };
      return { top: 0, left: 0, right: box.width, bottom: box.height, ...box };
    };
    return row;
  };
  const row0 = makeRow('row-0', 0);
  const row1 = makeRow('row-1', 1);
  const hiddenRow = makeRow('row-hidden', 3);
  hiddenRow.style.setProperty('--transcript-measured-height', '132px');
  spacer.append(row0, row1, hiddenRow);
  document.body.append(spacer);

  const keys = ['row-0', 'row-1', 'row-2', 'row-hidden'];
  const applied = [];
  const parentSawSizes = [];
  const core = {
    options: { anchorTo: 'end', getItemKey: (index) => keys[index] },
    itemSizeCache: new Map(),
    measurementsCache: keys.map((key, index) => ({ key, index, start: index * 60, end: index * 60 + 60, size: 60 })),
    resizeItem: (index, size) => {
      applied.push([index, size]);
      core.itemSizeCache.set(keys[index], size);
    },
  };
  let rerender;
  const stableRows = keys.map((key) => ({ _tag: 'AssistantPart', key }));
  function ChildMeasurement() {
    useMountedRowMeasurement({
      rows: stableRows,
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
  function ParentHarness() {
    const [tick, setTick] = React.useState(0);
    rerender = () => setTick((n) => n + 1);
    React.useLayoutEffect(() => {
      parentSawSizes.push({
        tick,
        row2: core.itemSizeCache.get('row-2'),
        rowHidden: core.itemSizeCache.get('row-hidden'),
      });
    });
    return React.createElement(ChildMeasurement);
  }

  await act(async () => root.render(React.createElement(ParentHarness)));
  assert.equal(resizeObservers.length, 0, 'does not attach a duplicate ResizeObserver alongside virtual-core');
  assert.deepEqual(applied, [
    [0, 80],
    [1, 90],
  ]);
  assert.equal(
    hiddenRow.style.getPropertyValue('--transcript-measured-height'),
    '132px',
    'a 0x0 hidden row never overwrites its remembered --transcript-measured-height with 0px'
  );

  // When the hidden pane becomes visible, the next commit measures the previously hidden row synchronously
  // before the parent layout effect runs.
  heights.set('row-hidden', { width: 720, height: 140 });
  reads.clear();
  await act(async () => rerender());
  assert.deepEqual([...reads.entries()], [['row-hidden', 1]], 'only the previously hidden row is read on reveal');
  assert.equal(
    parentSawSizes.at(-1)?.rowHidden,
    140,
    'parent layout effect observes the revealed row height in the same commit'
  );
  assert.equal(hiddenRow.style.getPropertyValue('--transcript-measured-height'), '140px');

  // Unrelated re-renders perform zero layout reads (O(1) fast path).
  reads.clear();
  await act(async () => rerender());
  await act(async () => rerender());
  assert.equal(reads.size, 0, 'unrelated renders never call getBoundingClientRect');

  // Mounting a new row during a scroll commit (same `rows` identity) drains synchronously before parent layout effects.
  const row2 = makeRow('row-2', 2);
  reads.clear();
  await act(async () => {
    spacer.append(row2);
    rerender();
  });
  assert.deepEqual([...reads.entries()], [['row-2', 1]], 'only the newly mounted scroll row is read');
  assert.equal(
    parentSawSizes.at(-1)?.row2,
    110,
    'parent layout effect sees the newly mounted row size before writing spacer geometry'
  );
  assert.deepEqual(applied.at(-1), [2, 110]);
});
