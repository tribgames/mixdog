import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { useSidePanelOpenFlip } from './app-side-panel-flip.ts';
import { createTranscriptWidthSync, registerTranscriptWidthSync } from './transcript-list-resize-patch.ts';
import { installTestDom } from './test-support/test-dom.mjs';

/** A mounted timeline: real row elements under a spacer, each reporting the
 *  height it lays out at the current viewport width. */
function timeline(t, { width = 600, anchorTo = 'end', scrollOffset = 0, sizes }) {
  installTestDom(t, { expose: ['HTMLElement'] });
  const keys = sizes.map((_, index) => `row-${index}`);
  const laidOut = new Map(keys.map((key, index) => [key, sizes[index]]));
  const viewport = document.createElement('div');
  let viewportWidth = width;
  Object.defineProperty(viewport, 'offsetWidth', { get: () => viewportWidth });
  const spacer = document.createElement('div');
  viewport.appendChild(spacer);
  document.body.appendChild(viewport);
  keys.forEach((key, index) => {
    const row = document.createElement('div');
    row.className = 'transcript-virtual-row';
    row.dataset.timelineKey = key;
    row.dataset.index = String(index);
    row.getBoundingClientRect = () => ({ height: laidOut.get(key) });
    spacer.appendChild(row);
  });
  const instance = {
    scrollRect: { width, height: 400 },
    scrollOffset,
    scrollAdjustments: 0,
    options: { anchorTo, followOnAppend: anchorTo === 'end', getItemKey: (index) => keys[index] },
    itemSizeCache: new Map(keys.map((key, index) => [key, sizes[index]])),
    get measurementsCache() {
      let start = 0;
      return keys.map((key, index) => {
        const size = this.itemSizeCache.get(key);
        const item = { key, index, start, end: start + size, size, lane: 0 };
        start += size;
        return item;
      });
    },
  };
  const calls = [];
  const suppressAdjustment = { current: false };
  const anchorHold = { current: null };
  const sync = createTranscriptWidthSync({
    getViewport: () => viewport,
    getSpacer: () => spacer,
    getVirtualizer: () => instance,
    rows: () => keys.map((key) => ({ _tag: 'TurnGap', key })),
    scrollInset: () => 0,
    indexForPendingKey: (key, hint) => (keys[hint] === key ? hint : keys.indexOf(key)),
    pendingResizes: { current: new Map() },
    baseResizeItem: {
      current: (index, size) => {
        calls.push({ kind: 'resize', index, size, suppressed: suppressAdjustment.current });
        instance.itemSizeCache.set(keys[index], size);
      },
    },
    suppressAdjustment,
    endPin: { request: () => calls.push({ kind: 'end-pin' }) },
    anchorHold,
    restoreReadingAnchor: (landing) => calls.push({ kind: 'anchor', landing, hold: { ...anchorHold.current } }),
  });
  return {
    sync,
    calls,
    instance,
    suppressAdjustment,
    resize(nextWidth, nextSizes) {
      viewportWidth = nextWidth;
      keys.forEach((key, index) => {
        laidOut.set(key, nextSizes[index]);
      });
    },
  };
}

test('an unchanged width reads no row and writes nothing', (t) => {
  const list = timeline(t, { sizes: [100, 200, 300] });
  list.sync();
  assert.deepEqual(list.calls, []);
});

test('a following timeline re-measures every mounted row in one pass and pins its end once', (t) => {
  const list = timeline(t, { sizes: [100, 200, 300] });
  list.resize(420, [130, 200, 360]);
  list.sync();
  assert.deepEqual(list.calls, [
    { kind: 'resize', index: 0, size: 130, suppressed: true },
    { kind: 'resize', index: 2, size: 360, suppressed: true },
    { kind: 'end-pin' },
  ]);
  assert.equal(list.suppressAdjustment.current, false, 'per-row compensation is back on after the batch');
  // The rows' own observers deliver the same boxes later: nothing is left.
  list.calls.length = 0;
  list.sync();
  assert.deepEqual(list.calls, []);
});

test('a reader away from the end keeps the row they read at its offset', (t) => {
  // Reading at 250: row 1 (start 100) is the first row on screen, 150px above the top.
  const list = timeline(t, { anchorTo: 'start', scrollOffset: 250, sizes: [100, 200, 300] });
  list.resize(420, [160, 260, 300]);
  list.sync();
  const anchor = list.calls.at(-1);
  assert.equal(anchor.kind, 'anchor');
  assert.equal(anchor.landing, true, 'the anchor is restored absolutely, in this task');
  assert.equal(anchor.hold.key, 'row-1');
  assert.equal(anchor.hold.offset, -150, 'captured before the new sizes moved the row');
  assert.ok(anchor.hold.until > anchor.hold.landedAt, 'late sizes above it stay compensated for a while');
  assert.equal(list.calls.filter((call) => call.kind === 'end-pin').length, 0);
  assert.ok(list.calls.filter((call) => call.kind === 'resize').every((call) => call.suppressed));
});

test('the commit that flips the sidebar re-measures the transcripts before it paints', async (t) => {
  const { root } = installTestDom(t, { rootId: 'root' });
  let syncs = 0;
  // Counted inside the layout effect: the sizes it applies land pre-paint.
  t.after(registerTranscriptWidthSync(() => syncs++));
  function Shell({ collapsed }) {
    const { mainPanel } = useSidePanelOpenFlip();
    return React.createElement(
      'div',
      { className: `app-shell ${collapsed ? 'sidebar-collapsed' : ''}` },
      React.createElement('main', { className: 'main-panel', ref: mainPanel })
    );
  }
  await act(async () => root.render(React.createElement(Shell, { collapsed: false })));
  assert.equal(syncs, 0, 'mounting is not a width change');
  await act(async () => root.render(React.createElement(Shell, { collapsed: false })));
  assert.equal(syncs, 0, 'an unrelated commit reads no layout');
  await act(async () => root.render(React.createElement(Shell, { collapsed: true })));
  assert.equal(syncs, 1);
  await act(async () => root.render(React.createElement(Shell, { collapsed: false })));
  assert.equal(syncs, 2);
});
