// A hidden window delivers no ResizeObserver callbacks, and that callback was the
// only way an unmounted row left the virtualizer's element cache: a long session
// running behind other windows kept every row it ever mounted, detached, with its
// whole DOM subtree, until the window was shown again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><div id="root"></div></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement'],
});

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Virtualizer } = await import('@tanstack/virtual-core');
const { useTranscriptRowRegistration } = await import('./transcript-list-row-registration.ts');

test('rows unmounted while no ResizeObserver delivers leave the element cache', async () => {
  const keys = Array.from({ length: 40 }, (_, index) => `row:${index}`);
  // No scroll element, so no target window: the core's observer never delivers.
  const virtualizer = new Virtualizer({
    count: keys.length,
    getScrollElement: () => null,
    estimateSize: () => 20,
    getItemKey: (index) => keys[index],
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  });
  const virtualizerRef = { current: virtualizer };
  const spacer = { current: null };
  const content = { current: null };
  let measureRow;
  const List = ({ from, to }) => {
    ({ measureRow } = useTranscriptRowRegistration({ spacer, content, virtualizerRef }));
    return React.createElement(
      'div',
      null,
      keys.slice(from, to).map((key, offset) =>
        React.createElement('div', { key, 'data-index': from + offset, ref: measureRow }, key)
      )
    );
  };
  const host = document.getElementById('root');
  const root = createRoot(host);
  // Stream through the transcript: each window of rows replaces the last.
  for (let from = 0; from + 10 <= keys.length; from += 10) {
    await act(async () => root.render(React.createElement(List, { from, to: from + 10 })));
  }
  await act(async () => {});
  const cached = [...virtualizer.elementsCache.values()];
  assert.equal(cached.filter((element) => !element.isConnected).length, 0);
  assert.deepEqual(
    [...virtualizer.elementsCache.keys()].sort(),
    keys.slice(30).sort(),
    'mounted rows stay registered'
  );
  await act(async () => root.unmount());
});

test('the sweep in a mounted scroller keeps measurements, scroll and replaced rows', async () => {
  const keys = Array.from({ length: 60 }, (_, index) => `row:${index}`);
  const sizeOf = (index) => 20 + (index % 5) * 10;
  const ESTIMATE = 40;
  // A minimized window: the observer registers targets but never delivers.
  const observed = new Set();
  const view = document.defaultView;
  const previousObserver = view.ResizeObserver;
  view.ResizeObserver = class {
    observe(target) {
      observed.add(target);
    }
    unobserve(target) {
      observed.delete(target);
    }
    disconnect() {
      observed.clear();
    }
  };
  const scroller = document.createElement('div');
  document.body.append(scroller);
  const OFFSET = 300;
  const scrolls = [];
  const measured = [];
  const virtualizer = new Virtualizer({
    count: keys.length,
    getScrollElement: () => scroller,
    estimateSize: () => ESTIMATE,
    getItemKey: (index) => keys[index],
    measureElement: (element) => {
      measured.push(element);
      return Number(element.dataset.size);
    },
    scrollToFn: (offset) => scrolls.push(offset),
    observeElementRect: (_, notify) => {
      notify({ width: 500, height: 200 });
      return () => {};
    },
    observeElementOffset: (_, notify) => {
      notify(OFFSET, false);
      return () => {};
    },
  });
  virtualizer._willUpdate();
  const virtualizerRef = { current: virtualizer };
  let measureRow;
  const List = ({ from, to, generation }) => {
    ({ measureRow } = useTranscriptRowRegistration({ spacer: { current: null }, content: { current: null }, virtualizerRef }));
    return React.createElement(
      React.Fragment,
      null,
      keys.slice(from, to).map((key, offset) =>
        React.createElement('div', {
          key: `${key}:${generation[key] ?? 0}`,
          'data-index': from + offset,
          'data-size': sizeOf(from + offset),
          ref: measureRow,
        })
      )
    );
  };
  // Independent of the core: each start is the sum of the sizes before it,
  // measured rows at their size, the rest at the estimate.
  const expectedLayout = (measuredRows) => {
    let start = 0;
    return keys.map((key, index) => {
      const size = measuredRows.has(index) ? sizeOf(index) : ESTIMATE;
      const item = [key, start, size];
      start += size;
      return item;
    });
  };
  const layout = () => {
    const measurements = virtualizer.getMeasurements();
    return keys.map((_, index) => [measurements[index].key, measurements[index].start, measurements[index].size]);
  };
  const root = createRoot(scroller);
  const render = (from, to, generation = {}) =>
    act(async () =>
      root.render(React.createElement(React.StrictMode, null, React.createElement(List, { from, to, generation })))
    );

  // StrictMode attaches, detaches and re-attaches every row ref on mount.
  await render(10, 20);
  const firstRows = new Set(Array.from({ length: 10 }, (_, offset) => 10 + offset));
  const rowElements = () => [...scroller.children];
  assert.deepEqual(
    [...virtualizer.elementsCache.values()],
    rowElements(),
    'every mounted row stays registered through the StrictMode double invoke'
  );
  assert.deepEqual([...observed], rowElements(), 'and observed');
  assert.deepEqual(layout(), expectedLayout(firstRows));
  const scrollsAfterMount = scrolls.length;

  // The next window replaces these rows; row 19 remounts under the same key.
  const oldNineteen = rowElements().at(-1);
  measured.length = 0;
  await render(19, 30, { 'row:19': 1 });
  const nineteen = rowElements()[0];
  assert.notEqual(nineteen, oldNineteen);
  assert.equal(virtualizer.elementsCache.get('row:19'), nineteen, 'the replacement row is registered');
  assert.ok(observed.has(nineteen) && !observed.has(oldNineteen), 'the replacement row is observed');
  assert.ok(measured.includes(nineteen), 'the replacement row is measured');
  assert.equal(
    [...virtualizer.elementsCache.values()].filter((element) => !element.isConnected).length,
    0,
    'no unmounted row stays cached'
  );
  assert.deepEqual([...virtualizer.elementsCache.values()], rowElements());
  assert.deepEqual([...observed], rowElements());
  assert.ok(
    measured.every((element) => element.isConnected),
    'only mounted rows are measured'
  );
  const allRows = new Set([...firstRows, ...Array.from({ length: 11 }, (_, offset) => 19 + offset)]);
  assert.deepEqual(layout(), expectedLayout(allRows), 'measurements survive the sweep');
  assert.equal(virtualizer.getTotalSize(), expectedLayout(allRows).reduce((total, [, , size]) => total + size, 0));
  assert.deepEqual(scrolls.slice(scrollsAfterMount), [], 'the sweep never scrolls');
  assert.equal(virtualizer.scrollOffset, OFFSET, 'the scroll position holds');

  await act(async () => root.unmount());
  assert.equal(virtualizer.elementsCache.size, 0);
  scroller.remove();
  view.ResizeObserver = previousObserver;
});
