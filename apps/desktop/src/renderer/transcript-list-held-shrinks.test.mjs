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
      endPin: { request() {}, now() {}, cancel() {} },
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
  // Parsed: the settle lands on commit (MutationObserver microtask or rAF fallback), far below the estimate.
  reply.parse(100);
  await Promise.resolve();
  for (const frame of frames.splice(0)) frame();
  assert.equal(core.itemSizeCache.get('reply'), 100, 'the parsed height lands; the estimate is not held');
  // A later dip below that real measurement IS a held streaming reflow.
  virtualizer.resizeItem(1, 90);
  assert.equal(core.itemSizeCache.get('reply'), 100);
});

test('a held shrink kept alive past 350ms by a pending parse stops polling timers and settles via MutationObserver', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const { useVirtualizerResizePatch } = await import('./transcript-list-resize-patch.ts');
  const { HELD_SHRINK_WINDOW_MS } = await import('./transcript-list-held-shrinks.ts');

  // Unit check: nextExpiryMs returns null once expired if held solely by a pending marker.
  let clock = 1_000;
  const unitHeld = createHeldRowShrinks(() => clock);
  const unitReply = pendingReplyElement(document);
  const unitHost = virtualHost(unitHeld, [{ key: 'reply', size: 600, element: unitReply.element }]);
  assert.equal(unitHeld.hold(unitHost, 'reply', 420), true);
  assert.equal(unitHeld.nextExpiryMs(unitHost), HELD_SHRINK_WINDOW_MS);
  clock += HELD_SHRINK_WINDOW_MS + 50;
  assert.equal(unitHeld.nextExpiryMs(unitHost), null, 'expired hold with pending marker needs no poll timer');
  unitReply.parse(420);
  assert.equal(unitHeld.nextExpiryMs(unitHost), 0, 'once pending marker clears, expiry is immediate');

  // Integration check with useVirtualizerResizePatch: no 16ms polling loop after 350ms expires.
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (cb, delay) => {
    const entry = { cb, delay, cleared: false };
    timers.push(entry);
    return entry;
  };
  globalThis.clearTimeout = (entry) => {
    if (entry) entry.cleared = true;
  };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

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
    resizeItem: (index, size) => void core.itemSizeCache.set(keys[index], size),
  };
  function Harness() {
    useVirtualizerResizePatch({
      virtualizer: core,
      viewport: { current: null },
      hasScrollGestureRef: useRef(() => false),
      visibleTop: () => 0,
      maxScrollTop: () => 0,
      endPin: { request() {}, now() {}, cancel() {} },
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
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  // Establish real measured slot, then shrink while streaming + pending.
  core.resizeItem(1, 600);
  assert.equal(core.itemSizeCache.get('reply'), 600);
  core.resizeItem(1, 420);
  assert.equal(core.itemSizeCache.get('reply'), 600, 'shrink is held');
  assert.equal(timers.length, 1, 'one timer scheduled for the 350ms window');

  // Fire the 350ms timer while pending marker is still present.
  now += HELD_SHRINK_WINDOW_MS + 10;
  timers[0].cb();
  assert.equal(core.itemSizeCache.get('reply'), 600, 'still held while pending parse marker remains');
  assert.equal(timers.length, 1, 'no 16ms polling timer loop scheduled while pending parse remains');

  // Removing the pending marker triggers MutationObserver and lands the held shrink.
  reply.parse(420);
  await Promise.resolve();
  assert.equal(core.itemSizeCache.get('reply'), 420, 'held shrink settles as soon as pending marker leaves DOM');
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
    indexFromElement: (element) => (element === reply.element ? 1 : -1),
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
  reply.parse(180);
  await Promise.resolve();
  for (const frame of frames.splice(0)) frame();
  assert.equal(followed.itemSizeCache.get('reply'), 180, 'the parse still settles the real box');
});

test('a bottom-anchored settled row with pending markdown holds its estimate instead of collapsing to 0px, then settles once parsed', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root' });
  const frames = [];
  window.requestAnimationFrame = (cb) => frames.push(cb);
  window.cancelAnimationFrame = () => {};
  const { useProvisionalRowResize } = await import('./transcript-list-provisional-resize.ts');
  const reply = pendingReplyElement(document);
  reply.element.querySelector('.message').classList.remove('streaming');
  const keys = ['prompt', 'reply'];
  const core = (anchorTo) => ({
    options: { anchorTo, followOnAppend: false, count: 2, getItemKey: (index) => keys[index] },
    elementsCache: new Map([['reply', reply.element]]),
    itemSizeCache: new Map([['prompt', 66]]),
    indexFromElement: (element) => (element === reply.element ? 1 : -1),
    resizeItem(index, size) {
      this.itemSizeCache.set(keys[index], size);
    },
  });
  const followed = core('end');
  const reading = core('start');
  const coldFallback = core('end');
  function Harness({ virtualizer, fallback }) {
    const virtualizerRef = useRef(virtualizer);
    const heldEstimates = useRef(new Map([['reply', 119]]));
    const fallbackEstimates = useRef(new Set(fallback ? ['reply'] : []));
    useProvisionalRowResize({ virtualizer, virtualizerRef, heldEstimates, fallbackEstimates });
    return null;
  }
  for (const [virtualizer, fallback, key] of [
    [followed, false, 'end-learned'],
    [reading, false, 'start-learned'],
    [coldFallback, true, 'end-fallback'],
  ]) {
    virtualizer.resizeItem = virtualizer.resizeItem.bind(virtualizer);
    await act(async () => root.render(React.createElement(Harness, { virtualizer, fallback, key })));
  }
  // An unparsed markdown body (<span hidden data-transcript-pending />) measures 0px before parsing finishes.
  followed.resizeItem(1, 0);
  reading.resizeItem(1, 0);
  coldFallback.resizeItem(1, 0);
  assert.equal(
    followed.itemSizeCache.get('reply'),
    119,
    'bottom-anchored settled row holds its estimate while pending'
  );
  assert.equal(reading.itemSizeCache.get('reply'), 119, 'reading row keeps its estimate while pending');
  assert.equal(
    coldFallback.itemSizeCache.get('reply'),
    119,
    'cold-start fallback estimate also holds instead of collapsing to 0px'
  );
  // Once markdown parsing finishes, the settle pass lands the real parsed height.
  reply.parse(184);
  await Promise.resolve();
  for (const frame of frames.splice(0)) frame();
  assert.equal(followed.itemSizeCache.get('reply'), 184, 'settled height lands once pending marker clears');
  assert.equal(coldFallback.itemSizeCache.get('reply'), 184, 'cold fallback settles to parsed height');
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
      endPin: { request() {}, now() {}, cancel() {} },
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

test('held shrinks expire after the bounded reparse window when markdown is not reparsing', () => {
  let now = 1_000;
  const held = createHeldRowShrinks(() => now);
  const element = {
    isConnected: true,
    pending: false,
    querySelector(selector) {
      if (selector === '.message.streaming') return {};
      if (selector === '[data-transcript-pending]') return this.pending ? {} : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-transcript-pending]') return this.pending ? [{ closest: () => null }] : [];
      return [];
    },
  };
  const host = virtualHost(held, [{ key: 'reply', size: 600, element }]);
  const landed = [];
  const resize = (index, size) => landed.push([index, size]);
  assert.equal(held.hold(host, 'reply', 540), true);
  assert.ok(held.nextExpiryMs() !== null && held.nextExpiryMs() <= 350, 'schedules bounded expiry');
  // While body is actively reparsing, even past the window it stays held.
  element.pending = true;
  now += 500;
  held.settle(host, resize);
  assert.deepEqual(landed, [], 'active markdown reparse keeps holding');
  // Once reparse finishes and window has elapsed, held shrink settles immediately.
  element.pending = false;
  held.settle(host, resize);
  assert.deepEqual(landed, [[0, 540]], 'expired hold settles without waiting for stream end');
});

test('provisional row settles on DOM commit via MutationObserver without rAF polling', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['Node', 'Element', 'HTMLElement', 'MutationObserver'],
  });
  let rafCalls = 0;
  window.requestAnimationFrame = () => {
    rafCalls += 1;
    return rafCalls;
  };
  window.cancelAnimationFrame = () => {};
  const { useProvisionalRowResize } = await import('./transcript-list-provisional-resize.ts');
  const reply = pendingReplyElement(document);
  const keys = ['prompt', 'reply'];
  const core = {
    options: { anchorTo: 'end', followOnAppend: false, count: 2, getItemKey: (index) => keys[index] },
    elementsCache: new Map([['reply', reply.element]]),
    itemSizeCache: new Map([['prompt', 66]]),
    indexFromElement: (element) => (element === reply.element ? 1 : -1),
    resizeItem: (index, size) => void core.itemSizeCache.set(keys[index], size),
  };
  function Harness() {
    const virtualizerRef = useRef(core);
    const heldEstimates = useRef(new Map([['reply', 140]]));
    const fallbackEstimates = useRef(new Set());
    useProvisionalRowResize({ virtualizer: core, virtualizerRef, heldEstimates, fallbackEstimates });
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  core.resizeItem(1, 0);
  assert.equal(core.itemSizeCache.get('reply'), 140);
  assert.equal(rafCalls, 0, 'does not poll requestAnimationFrame when MutationObserver is available');
  reply.parse(188);
  await Promise.resolve();
  assert.equal(core.itemSizeCache.get('reply'), 188, 'settles immediately on DOM mutation commit');
});

test('settling a held shrink re-reads the connected element live box height instead of replaying a stale dip', async () => {
  const { HELD_SHRINK_WINDOW_MS } = await import('./transcript-list-held-shrinks.ts');
  let clock = 1_000;
  const held = createHeldRowShrinks(() => clock);
  let liveHeight = 480;
  const recovered = {
    ...rowElement(),
    getBoundingClientRect: () => ({ top: 0, bottom: liveHeight, height: liveHeight, left: 0, right: 600, width: 600 }),
  };
  let grownHeight = 520;
  const grown = {
    ...rowElement(),
    getBoundingClientRect: () => ({
      top: 0,
      bottom: grownHeight,
      height: grownHeight,
      left: 0,
      right: 600,
      width: 600,
    }),
  };
  const host = virtualHost(held, [
    { key: 'recovered', size: 600, element: recovered },
    { key: 'grown', size: 600, element: grown },
  ]);
  assert.equal(held.hold(host, 'recovered', 480), true);
  assert.equal(held.hold(host, 'grown', 520), true);
  // Both elements recover before the 350ms window expires.
  liveHeight = 600;
  grownHeight = 625;
  clock += HELD_SHRINK_WINDOW_MS + 10;
  const landed = [];
  held.settle(host, (index, size) => landed.push([index, size]));
  assert.deepEqual(
    landed,
    [[1, 625]],
    'recovered row skips writing a stale dip and grown row lands its live box height'
  );
  assert.equal(held.size, 0);
});

test('a shrink held for a pending markdown parse settles immediately on readiness with the live box height', () => {
  let clock = 1_000;
  const held = createHeldRowShrinks(() => clock);
  let liveHeight = 420;
  const element = {
    isConnected: true,
    pending: true,
    getBoundingClientRect: () => ({ top: 0, bottom: liveHeight, height: liveHeight, left: 0, right: 600, width: 600 }),
    querySelector(selector) {
      if (selector === '.message.streaming') return {};
      if (selector === '[data-transcript-pending]') return this.pending ? {} : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-transcript-pending]') return this.pending ? [{ parentElement: null }] : [];
      return [];
    },
  };
  const host = virtualHost(held, [{ key: 'reply', size: 600, element }]);
  assert.equal(held.hold(host, 'reply', 420), true);
  // Pending parse finishes after only 40ms (well before 350ms) and live box is 590px.
  clock += 40;
  element.pending = false;
  liveHeight = 590;
  const landed = [];
  held.settle(host, (index, size) => landed.push([index, size]));
  assert.deepEqual(landed, [[0, 590]], 'settles immediately on pending-parse completion at the live box height');
  assert.equal(held.size, 0);
});

test('settling a held shrink in a hidden pane (0x0 rect) discards the stale shrink and preserves the cached slot', async () => {
  const { HELD_SHRINK_WINDOW_MS } = await import('./transcript-list-held-shrinks.ts');
  let clock = 1_000;
  const held = createHeldRowShrinks(() => clock);
  let hiddenRect = { top: 0, bottom: 420, height: 420, left: 0, right: 600, width: 600 };
  const hiddenRow = {
    ...rowElement(),
    getBoundingClientRect: () => hiddenRect,
  };
  let collapsedRect = { top: 0, bottom: 420, height: 420, left: 0, right: 600, width: 600 };
  const collapsedRow = {
    ...rowElement(),
    getBoundingClientRect: () => collapsedRect,
  };
  const host = virtualHost(held, [
    { key: 'hidden', size: 600, element: hiddenRow },
    { key: 'collapsed', size: 600, element: collapsedRow },
  ]);
  assert.equal(held.hold(host, 'hidden', 420), true);
  assert.equal(held.hold(host, 'collapsed', 420), true);

  // Pane becomes hidden (0x0 rect) while another row intentionally collapses (width > 0, height === 0).
  hiddenRect = { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
  collapsedRect = { top: 0, bottom: 0, height: 0, left: 0, right: 600, width: 600 };
  clock += HELD_SHRINK_WINDOW_MS + 10;
  const landed = [];
  held.settle(host, (index, size) => landed.push([index, size]));
  assert.deepEqual(
    landed,
    [[1, 0]],
    'hidden 0x0 row discards the held shrink without writing 420px; intentional collapse with width > 0 lands 0px'
  );
  assert.equal(host.itemSizeCache.get('hidden'), 600, 'hidden row preserves its 600px cached slot');
  assert.equal(held.size, 0);
});

test('hold skips DOM pending-marker scans on ordinary streaming growth', () => {
  const held = createHeldRowShrinks();
  let queries = 0;
  const element = {
    isConnected: true,
    querySelector(selector) {
      queries += 1;
      return selector === '.message.streaming' ? {} : null;
    },
    querySelectorAll() {
      queries += 1;
      return [];
    },
  };
  const host = virtualHost(held, [{ key: 'reply', size: 600, element }]);
  assert.equal(held.hold(host, 'reply', 600), false);
  assert.equal(held.hold(host, 'reply', 640), false);
  assert.equal(queries, 0, 'ordinary growth performs zero DOM queries');
});
