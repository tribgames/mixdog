import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef } from 'react';
import { createHeldRowShrinks } from './transcript-list-held-shrinks.ts';
import { useRememberVirtualMeasurements, useTranscriptHandles } from './transcript-list-handles.ts';
import { measureTranscriptRow, SCROLL_END_THRESHOLD_PX } from './transcript-list-geometry.ts';
import { readTranscriptVirtualSnapshot } from './transcript-virtual-cache.ts';
import { installTestDom } from './test-support/test-dom.mjs';

/** A mounted row element: connected, streaming until told otherwise. */
function rowElement() {
  return {
    isConnected: true,
    streaming: true,
    querySelector(selector) {
      return selector === '.message.streaming' && this.streaming ? {} : null;
    },
  };
}

/** The virtual-core surface the hold reads: rows with a slot measured
 *  through the resize path each, unless `measured: false` (still at its
 *  estimate). */
function virtualHost(held, rows, anchorTo = 'end') {
  const measured = rows.filter((row) => row.measured !== false);
  const host = {
    options: { anchorTo, count: rows.length },
    measurementsCache: rows.map((row, index) => ({ key: row.key, index, size: row.size })),
    itemSizeCache: new Map(measured.map((row) => [row.key, row.size])),
    elementsCache: new Map(rows.filter((row) => row.element).map((row) => [row.key, row.element])),
    indexFromElement: (element) => rows.findIndex((row) => row.element === element),
  };
  for (const row of measured) held.measured(host, row.key, row.size);
  return host;
}

test('a laid-out row collapsing to zero height gives up its slot; a hidden or pending row keeps it', () => {
  const instance = {
    options: { getItemKey: () => 'band' },
    indexFromElement: () => 0,
    itemSizeCache: new Map([['band', 62]]),
    measurementsCache: [{ key: 'band', size: 62 }],
  };
  const element = (pending = false) => ({
    style: { setProperty() {} },
    querySelector: (selector) => (pending && selector === '[data-transcript-pending]' ? {} : null),
  });
  const entry = (inlineSize, blockSize) => ({ borderBoxSize: [{ inlineSize, blockSize }] });
  // The agent chat's typing bubble (62px) empties once the reply streams above it.
  assert.equal(measureTranscriptRow(element(), entry(720, 0), instance), 0, 'the collapsed band takes no room');
  assert.equal(measureTranscriptRow(element(), entry(0, 0), instance), 62, 'a hidden pane keeps the held size');
  assert.equal(measureTranscriptRow(element(true), entry(720, 0), instance), 62, 'a pending row keeps the held size');
  assert.equal(measureTranscriptRow(element(), entry(720, 40), instance), 40);
});

test("a new streaming row's first size lands even below its estimate (no estimate gap above the live band)", () => {
  const held = createHeldRowShrinks();
  const host = virtualHost(held, [
    { key: 'prompt', size: 66 },
    { key: 'reply', size: 60, measured: false, element: rowElement() },
  ]);
  assert.equal(held.hold(host, 'reply', 8), false, 'the 60px estimate is not a slot to hold');
  assert.equal(held.size, 0);
});

test("a followed streaming dip keeps the measured slot; the row's latest real size lands when it stops streaming", () => {
  const held = createHeldRowShrinks();
  const element = rowElement();
  const host = virtualHost(held, [
    { key: 'prompt', size: 66 },
    { key: 'reply', size: 600, element },
  ]);
  const landed = [];
  const resize = (index, size) => landed.push([index, size]);
  assert.equal(held.hold(host, 'reply', 560), true);
  assert.equal(held.hold(host, 'reply', 540), true, 'a deeper dip is held too');
  held.settle(host, resize);
  assert.deepEqual(landed, [], 'still streaming and followed: the slot is kept');
  element.streaming = false;
  held.settle(host, resize);
  assert.deepEqual(landed, [[1, 540]], 'the latest real size lands, once');
  held.settle(host, resize);
  assert.deepEqual(landed, [[1, 540]]);
});

test('growing back past the slot ends the hold', () => {
  const held = createHeldRowShrinks();
  const host = virtualHost(held, [{ key: 'reply', size: 600, element: rowElement() }]);
  assert.equal(held.hold(host, 'reply', 560), true);
  assert.equal(held.hold(host, 'reply', 620), false);
  assert.equal(held.size, 0);
});

test('a released tail and a forced settle land holds of rows still streaming', () => {
  for (const [anchorTo, force] of [
    ['start', false],
    ['end', true],
  ]) {
    const held = createHeldRowShrinks();
    const host = virtualHost(held, [{ key: 'reply', size: 600, element: rowElement() }]);
    assert.equal(held.hold(host, 'reply', 560), true);
    host.options.anchorTo = anchorTo;
    const landed = [];
    held.settle(host, (index, size) => landed.push([index, size]), force);
    assert.deepEqual(landed, [[0, 560]], `${anchorTo}${force ? ' (forced)' : ''}`);
  }
});

test('a landing goes through the resize path without being held again', () => {
  const held = createHeldRowShrinks();
  const host = virtualHost(held, [{ key: 'reply', size: 600, element: rowElement() }]);
  held.hold(host, 'reply', 560);
  const applied = [];
  // The list's patched resizeItem consults the hold first, like this one.
  const resize = (index, size) => {
    if (held.hold(host, host.measurementsCache[index].key, size)) return;
    applied.push(size);
  };
  held.settle(host, resize, true);
  assert.deepEqual(applied, [560]);
  assert.equal(held.size, 0);
});

test('a held row that left the DOM is corrected at its last size; one that left the list drops its stale slot', () => {
  const held = createHeldRowShrinks();
  const unmounted = rowElement();
  const removed = rowElement();
  const host = virtualHost(held, [
    { key: 'reply', size: 600, element: unmounted },
    { key: 'gone', size: 400, element: removed },
  ]);
  assert.equal(held.hold(host, 'reply', 560), true);
  assert.equal(held.hold(host, 'gone', 380), true);
  unmounted.isConnected = false;
  removed.isConnected = false;
  // The second row left the list: the core no longer lays it out.
  host.measurementsCache.pop();
  host.options.count = 1;
  const landed = [];
  held.settle(host, (index, size) => landed.push([index, size]));
  assert.deepEqual(landed, [[0, 560]]);
  assert.equal(host.itemSizeCache.has('gone'), false, 'no stale held slot survives for the removed row');
  assert.equal(held.size, 0);
});

test('a slot set from a substituted estimate is not held; one set from the observed size is', () => {
  const held = createHeldRowShrinks();
  const host = virtualHost(held, [{ key: 'reply', size: 600, measured: false, element: rowElement() }]);
  // The resize path was given 272 but the cache took a 600px estimate.
  host.itemSizeCache.set('reply', 600);
  held.measured(host, 'reply', 272);
  assert.equal(held.hold(host, 'reply', 100), false);
  host.itemSizeCache.set('reply', 300);
  held.measured(host, 'reply', 300);
  assert.equal(held.hold(host, 'reply', 280), true);
});

/** A reply row element: streaming, pending markdown until `parse(height)`. */
function pendingReplyElement(document) {
  const element = document.createElement('div');
  element.className = 'transcript-virtual-row';
  const message = document.createElement('div');
  message.className = 'message streaming';
  const pending = document.createElement('span');
  pending.setAttribute('data-transcript-pending', '');
  message.append(pending);
  element.append(message);
  document.body.append(element);
  let height = 272;
  element.getBoundingClientRect = () => ({ top: 0, bottom: height, height, left: 0, right: 0, width: 0 });
  return {
    element,
    parse(next) {
      pending.remove();
      height = next;
    },
  };
}

test('a provisional estimate is not a slot to hold: the first parsed height below it lands', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  const frames = [];
  window.requestAnimationFrame = (cb) => frames.push(cb);
  window.cancelAnimationFrame = () => {};
  const { useProvisionalRowResize } = await import('./transcript-list-provisional-resize.ts');
  const { useVirtualizerResizePatch } = await import('./transcript-list-resize-patch.ts');
  const reply = pendingReplyElement(document);
  const keys = ['prompt', 'reply'];
  const core = {
    options: { anchorTo: 'end', followOnAppend: false, count: 2, getItemKey: (index) => keys[index] },
    elementsCache: new Map([['reply', reply.element]]),
    itemSizeCache: new Map([['prompt', 66]]),
    get measurementsCache() {
      let start = 0;
      return keys.map((key, index) => {
        const size = this.itemSizeCache.get(key) ?? 60;
        const item = { key, index, start, end: start + size, size, lane: 0 };
        start += size;
        return item;
      });
    },
    indexFromElement: (element) => (element === reply.element ? 1 : -1),
    // virtual-core's resizeItem is a bound arrow property.
    resizeItem: (index, size) => void core.itemSizeCache.set(keys[index], size),
  };
  let virtualizer = null;
  function Harness() {
    const virtualizerRef = useRef(core);
    const heldEstimates = useRef(new Map([['reply', 600]]));
    const fallbackEstimates = useRef(new Set());
    useProvisionalRowResize({ virtualizer: core, virtualizerRef, heldEstimates, fallbackEstimates });
    useVirtualizerResizePatch({
      virtualizer: core,
      viewport: { current: null },
      hasScrollGestureRef: useRef(() => false),
      visibleTop: () => 0,
      maxScrollTop: () => 0,
      endPin: { request() {} },
      resizePinned: useRef([]),
      resizePinFrame: useRef(0),
      pendingResizes: useRef(new Map()),
      baseResizeItem: useRef(null),
      applyingDeferred: useRef(false),
      scheduleResizeFlush() {},
      pendingAnchor: useRef(null),
      anchorHold: useRef(null),
      readingAnchorHeld: () => false,
      queueAnchorRestore() {},
    });
    virtualizer = core;
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  // First observation while pending: the learned 600px estimate stands in.
  virtualizer.resizeItem(1, 272);
  assert.equal(core.itemSizeCache.get('reply'), 600, 'the pending row keeps its learned estimate');
  // Parsed: the settle frame lands the first real box, far below the estimate.
  reply.parse(100);
  for (const frame of frames.splice(0)) frame();
  assert.equal(core.itemSizeCache.get('reply'), 100, 'the parsed height lands; the estimate is not held');
  // A later dip below that real measurement IS a held streaming reflow.
  virtualizer.resizeItem(1, 90);
  assert.equal(core.itemSizeCache.get('reply'), 100);
});

test('a followed pending row that outgrows its estimate takes its box in the same frame', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  const frames = [];
  window.requestAnimationFrame = (cb) => frames.push(cb);
  window.cancelAnimationFrame = () => {};
  const { useProvisionalRowResize } = await import('./transcript-list-provisional-resize.ts');
  const reply = pendingReplyElement(document);
  const keys = ['prompt', 'reply'];
  const core = (anchorTo) => ({
    options: { anchorTo, followOnAppend: false, count: 2, getItemKey: (index) => keys[index] },
    elementsCache: new Map([['reply', reply.element]]),
    itemSizeCache: new Map([['prompt', 66]]),
    resizeItem(index, size) {
      this.itemSizeCache.set(keys[index], size);
    },
  });
  const followed = core('end');
  const reading = core('start');
  function Harness({ virtualizer }) {
    const virtualizerRef = useRef(virtualizer);
    const heldEstimates = useRef(new Map([['reply', 120]]));
    const fallbackEstimates = useRef(new Set());
    useProvisionalRowResize({ virtualizer, virtualizerRef, heldEstimates, fallbackEstimates });
    return null;
  }
  for (const virtualizer of [followed, reading]) {
    virtualizer.resizeItem = virtualizer.resizeItem.bind(virtualizer);
    await act(async () =>
      root.render(React.createElement(Harness, { virtualizer, key: virtualizer.options.anchorTo }))
    );
  }
  // The streaming fallback grows a line past the learned estimate.
  followed.resizeItem(1, 146);
  reading.resizeItem(1, 146);
  assert.equal(followed.itemSizeCache.get('reply'), 146, 'the pinned tail grows with the row, no frame later');
  assert.equal(reading.itemSizeCache.get('reply'), 120, 'a row above the reader keeps its estimate until parsed');
  // A smaller fallback never shrinks a followed slot below its estimate.
  followed.resizeItem(1, 90);
  assert.equal(followed.itemSizeCache.get('reply'), 120);
  assert.equal(frames.length > 0, true, 'the parse still settles the real box');
});

function fakeVirtualizer(log) {
  return {
    options: { anchorTo: 'end', followOnAppend: true, scrollEndThreshold: SCROLL_END_THRESHOLD_PX },
    setOptions(options) {
      log.push(`options:${options.anchorTo}`);
      this.options = options;
    },
    takeSnapshot() {
      log.push('snapshot');
      return [{ key: 'reply', index: 0, start: 0, end: 540, size: 540, lane: 0 }];
    },
  };
}

test("the reader's release and the measurement snapshot land held sizes without a render", async (t) => {
  const { root } = installTestDom(t, { rootId: 'root' });
  const log = [];
  const virtualizer = fakeVirtualizer(log);
  const handles = { setAnchorBottom: null };
  function Harness() {
    const virtualizerRef = useRef(virtualizer);
    const scrollToEndRef = useRef(() => {});
    const setAnchorBottomRef = useRef(() => {});
    const anchorOverride = useRef(null);
    const viewport = useRef(null);
    const settleHeldShrinks = useRef((force = false) => log.push(`settle:${force}`)).current;
    useRememberVirtualMeasurements({
      sessionKey: 'held-session',
      viewport,
      virtualizerRef,
      flushDeferredResizes: () => log.push('flush'),
      settleHeldShrinks,
    });
    useTranscriptHandles({
      endPin: { request() {} },
      scrollToEndRef,
      setAnchorBottomRef,
      virtualizerRef,
      anchorOverride,
      settleHeldShrinks,
    });
    handles.setAnchorBottom = setAnchorBottomRef;
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  handles.setAnchorBottom.current(true);
  assert.deepEqual(log, [], 'keeping the end anchor lands nothing');
  handles.setAnchorBottom.current(false);
  assert.deepEqual(log, ['options:start', 'settle:false'], 'the release lands holds after the core lets go');
  log.length = 0;
  await act(async () => root.render(null));
  assert.deepEqual(log, ['settle:true', 'flush', 'snapshot'], 'held sizes land before the snapshot');
  assert.equal(readTranscriptVirtualSnapshot('held-session')?.measurements[0].size, 540);
});
