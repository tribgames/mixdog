import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { PaneKeyContext } from './pane-key-context.ts';
import { setHistoryPositions } from '../../../../packages/protocol-client/src/rows.ts';
import { _runIdleReclaimForTest } from './idle-reclaim.ts';
import { registerBudgetedCache } from './renderer-cache-budget.ts';
import { createSessionLaneStore, HIDDEN_SESSION_ROW_BUDGET } from './session-lane-store.ts';
import {
  holdsReaderTop,
  keepReaderPlaces,
  noteReaderPlaced,
  openReaderPlace,
  pendingReaderPlace,
  readerPlace,
  readerPlaceCount,
  useReaderPlace,
  voidReaderPlace,
} from './transcript-list-reader-place.ts';

const tabs = (entries) => new Map(Object.entries(entries).map(([pane, sessions]) => [pane, new Set(sessions)]));
const rows = (count, from = 0) =>
  Array.from({ length: count }, (_, n) => {
    const id = `r${from + n}`;
    return setHistoryPositions({ id, kind: 'assistant', text: id }, `p:${id}`, `p:${id}`);
  });
const positioned = (sessionId, items, extra = {}) => ({
  sessionId,
  snapshot: { sessionId, items, transcriptPositioned: true, transcriptWindowVersion: 1, ...extra },
  frameSource: 'live',
});

test("a reader's place is its pane's: two panes on one session keep one each, and a place outlives any number of other sessions", () => {
  keepReaderPlaces(tabs({ one: ['s', ...Array.from({ length: 200 }, (_, n) => `x${n}`)], two: ['s'] }));
  openReaderPlace('one', 's', { position: 'p:r10', top: -40 });
  openReaderPlace('two', 's', { position: 'p:r90', top: 12 });
  for (let n = 0; n < 200; n += 1) openReaderPlace('one', `x${n}`, { position: `p:x${n}`, top: 0 });
  assert.deepEqual(readerPlace('one', 's'), { position: 'p:r10', top: -40 });
  assert.deepEqual(pendingReaderPlace('two', 's'), { position: 'p:r90', top: 12 });
  assert.equal(readerPlaceCount(), 202);
  keepReaderPlaces(tabs({}));
});

test('a place lives as long as its pane holds a tab of the session, and a save that arrives after is dropped', () => {
  keepReaderPlaces(tabs({ one: ['s', 't'] }));
  openReaderPlace('one', 's', { position: 'p:r10', top: 0 });
  openReaderPlace('one', 't', { position: 'p:r20', top: 0 });
  keepReaderPlaces(tabs({ one: ['t'] }));
  assert.equal(readerPlace('one', 's'), null, 'the tab was closed: its place went with it');
  assert.deepEqual(readerPlace('one', 't'), { position: 'p:r20', top: 0 });
  openReaderPlace('one', 's', { position: 'p:r10', top: 0 });
  assert.equal(readerPlace('one', 's'), null, 'a save of the place let go');
  voidReaderPlace('one', 't');
  assert.equal(readerPlace('one', 't'), null, 'a record the history no longer holds leaves the reader at the end');
  keepReaderPlaces(tabs({}));
});

test('the row a list put its reader on keeps its top while it crosses the top of the view: its size settling is not compensated at its lower edge', () => {
  const list = {};
  const row = { key: 'r7', start: 700, end: 838 };
  assert.equal(holdsReaderTop(list, row, 811), false, 'no reader was put on it');
  noteReaderPlaced(list, 'r7');
  assert.equal(holdsReaderTop(list, { key: 'r6', start: 600, end: 700 }, 811), false, 'another row');
  assert.equal(holdsReaderTop(list, row, 811), true, 'the reader is 111px into the row');
  assert.equal(holdsReaderTop({}, row, 811), false, 'another list');
  // The reader scrolled on: the row is above the view, and is a row like any other from then on.
  assert.equal(holdsReaderTop(list, row, 900), false);
  assert.equal(holdsReaderTop(list, row, 811), false, 'also when it is back under the top of the view');
});

for (const [dpr, height] of [
  [2, 42.2],
  [3, 100.4],
]) {
  test(`a list kept mounted, handed its reader's place again at ${dpr}x, sizes the ${height}px row as the list does: rounded up to the device pixel`, async (t) => {
    const { root, document } = installTestDom(t, {
      html: '<!doctype html><div id="root"></div><div id="viewport"><div class="transcript-virtual-row" data-timeline-key="r1"></div></div>',
      rootId: 'root',
    });
    Object.defineProperty(document.defaultView, 'devicePixelRatio', { configurable: true, value: dpr });
    const viewport = { current: document.getElementById('viewport') };
    const node = viewport.current.querySelector('.transcript-virtual-row');
    node.getBoundingClientRect = () => ({ top: 10, bottom: 10 + height, height, width: 400 });
    // The slot an earlier pass held for the row at a whole pixel.
    const measurementsCache = [
      { index: 0, key: 'r0', start: 0, size: 300, end: 300 },
      { index: 1, key: 'r1', start: 300, size: Math.round(height), end: 300 + Math.round(height) },
    ];
    const instance = {
      options: { anchorTo: 'start' },
      measurementsCache,
      scrollOffset: 0,
      scrollAdjustments: 0,
      getSize: () => 600,
      getTotalSize: () => measurementsCache.at(-1).end,
      resizeItem(index, size) {
        measurementsCache[index] = { ...measurementsCache[index], size };
      },
    };
    const items = rows(2);
    const rowsRef = { current: items.map((item, at) => ({ _tag: 'AssistantPart', key: `r${at}`, item })) };
    const noop = () => {};
    function Harness() {
      useReaderPlace({
        sessionKey: 's',
        viewport,
        rowsRef,
        virtualizerRef: { current: instance },
        scrollInset: { current: 0 },
        deviation: { amount: () => 0 },
        anchorHold: { current: null },
        restoreReadingAnchor: noop,
        flushDeferredResizes: noop,
        syncDockInset: noop,
      });
      return null;
    }
    const tree = () => React.createElement(PaneKeyContext.Provider, { value: 'one' }, React.createElement(Harness));
    keepReaderPlaces(tabs({ one: ['s'] }));
    t.after(() => keepReaderPlaces(tabs({})));
    act(() => root.render(tree()));
    // The pane comes back to the session: the list kept mounted is handed the place its reader left.
    act(() => openReaderPlace('one', 's', { position: 'p:r1', top: 10 }));
    const held = measurementsCache[1].size;
    assert.equal(pendingReaderPlace('one', 's'), null, 'the reader is put on its row');
    assert.equal(held, Math.ceil(height * dpr) / dpr, 'the slot the row reads back at under the list rounding');
    assert.notEqual(held, Math.round(height));
  });
}

test('a surface outside the panes keeps no place', () => {
  openReaderPlace('', 's', { position: 'p:r10', top: 0 });
  assert.equal(readerPlace('', 's'), null);
});

test('a read of a shown session (its newest rows, no window) never takes the place of the window its subscription held', () => {
  const store = createSessionLaneStore();
  store.setShownSessionIds(['s']);
  const window_ = rows(40, 100);
  store.apply(positioned('s', window_));
  store.apply({ sessionId: 's', snapshot: { sessionId: 's', items: rows(10, 290) }, frameSource: 'replay' });
  assert.equal(store.get('s').items.length, 40, 'the window stands');
  assert.equal(store.get('s').transcriptPositioned, true);
  // No pane shows it: a read is the freshest there is.
  store.setShownSessionIds([]);
  store.apply({ sessionId: 's', snapshot: { sessionId: 's', items: rows(10, 290) }, frameSource: 'replay' });
  assert.equal(store.get('s').items.length, 10);
});

test('rows of sessions no pane shows are kept for an entry at their end: none without a tab, the tail within the budget, none beyond it, wherever a reader was', () => {
  const store = createSessionLaneStore();
  keepReaderPlaces(tabs({ one: ['end', 'read'] }));
  store.apply(positioned('closed', rows(50)));
  store.apply(positioned('end', rows(200)));
  store.apply(positioned('read', rows(800)));
  openReaderPlace('one', 'read', { position: 'p:r500', top: 0 });
  assert.equal(store.hiddenRows(), 1050);
  store.sweepHidden();
  assert.equal(store.get('closed'), null, 'no pane holds a tab of it');
  assert.equal(store.get('end').items.length, 200, 'the rows held fit the budget');
  assert.equal(
    store.get('read'),
    null,
    `a tail of more than ${HIDDEN_SESSION_ROW_BUDGET} rows is read again, a reader's place in it or not`
  );
  assert.equal(store.hiddenRows(), 200);
  // A session a pane shows is not swept.
  const off = store.subscribe('shown', () => {});
  store.apply(positioned('shown', rows(900)));
  store.sweepHidden();
  assert.equal(store.get('shown').items.length, 900);
  off();
  keepReaderPlaces(tabs({}));
});

test('idle reclaim uses bounded sweepHidden (keeping tabbed tails under budget, trimming apart views, evicting untabbed lanes and ended markers) and growing positioned views enforce the shared budget', () => {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const idleCallbacks = new Map();
  let nextIdleId = 1;
  const flushIdle = () => {
    for (const [id, callback] of [...idleCallbacks.entries()]) {
      idleCallbacks.delete(id);
      callback();
    }
  };
  globalThis.window = {
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    requestIdleCallback: (callback) => {
      const id = nextIdleId++;
      idleCallbacks.set(id, callback);
      return id;
    },
    cancelIdleCallback: (id) => {
      idleCallbacks.delete(id);
    },
  };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  let charsProbes = 0;
  let trimCalls = 0;
  let fakeBudgetChars = 25 * 1024 * 1024;
  const unregisterFake = registerBudgetedCache({
    name: 'test-positioned-view-budget-probe',
    chars() {
      charsProbes += 1;
      return fakeBudgetChars;
    },
    trim(target) {
      trimCalls += 1;
      fakeBudgetChars = Math.min(fakeBudgetChars, target);
    },
  });
  const store = createSessionLaneStore({ budget: true });
  const stop = store.start(() => () => {});
  try {
    // 1. Growing transcriptViews/transcriptViewItems on a subscribed lane refreshes bytes and enforces budget.
    const stableItems = rows(10);
    const offShown = store.subscribe('shown-views', () => {});
    store.setShownSessionIds(['shown-views']);
    store.apply({
      sessionId: 'shown-views',
      snapshot: { sessionId: 'shown-views', items: stableItems },
      frameSource: 'live',
    });
    const bytesBefore = store.stats().estimatedBytes;
    const beforeTrimCalls = trimCalls;
    fakeBudgetChars = 25 * 1024 * 1024;
    const heavyViewItems = Array.from({ length: 20 }, (_, i) => ({
      id: `old-${i}`,
      kind: 'assistant',
      text: 'V'.repeat(20_000),
    }));
    store.apply({
      sessionId: 'shown-views',
      snapshot: {
        sessionId: 'shown-views',
        items: stableItems,
        transcriptViewItems: heavyViewItems,
        transcriptViews: [{ items: heavyViewItems }],
      },
      frameSource: 'live',
    });
    assert.ok(store.stats().estimatedBytes > bytesBefore, 'positioned view growth updates lane byte accounting');
    assert.equal(trimCalls, beforeTrimCalls, 'budget enforcement stays off the synchronous frame commit path');
    flushIdle();
    assert.ok(trimCalls > beforeTrimCalls, 'growing positioned views enforces the shared renderer cache budget');

    // 1b. Streaming token frames on a subscribed lane do not probe budgeted caches on every token.
    const streamItems = [...stableItems, { id: 'stream-1', kind: 'assistant', text: 'tok', streaming: true }];
    store.apply({
      sessionId: 'shown-views',
      snapshot: {
        sessionId: 'shown-views',
        items: streamItems,
        streamingTail: { itemId: 'stream-1', text: 'tok' },
      },
      frameSource: 'live',
    });
    flushIdle();
    const probesBeforeStream = charsProbes;
    const trimsBeforeStream = trimCalls;
    fakeBudgetChars = 25 * 1024 * 1024;
    for (let step = 1; step <= 20; step += 1) {
      store.apply({
        sessionId: 'shown-views',
        snapshot: {
          sessionId: 'shown-views',
          items: [
            ...stableItems,
            { id: 'stream-1', kind: 'assistant', text: `tok ${'x'.repeat(step * 40)}`, streaming: true },
          ],
          streamingTail: { itemId: 'stream-1', text: `tok ${'x'.repeat(step * 40)}` },
        },
        frameSource: 'live',
      });
    }
    flushIdle();
    assert.equal(charsProbes, probesBeforeStream, 'streaming token frames do not probe budgeted caches per frame');
    assert.equal(trimCalls, trimsBeforeStream, 'streaming token frames do not trigger budget trims per frame');
    // Ending streaming enforces the budget once.
    store.apply({
      sessionId: 'shown-views',
      snapshot: {
        sessionId: 'shown-views',
        items: [...stableItems, { id: 'stream-1', kind: 'assistant', text: 'final', streaming: false }],
      },
      frameSource: 'live',
    });
    flushIdle();
    assert.ok(trimCalls > trimsBeforeStream, 'ending streaming enforces the shared budget');

    // 2. Idle reclaim runs bounded sweepHidden: recently viewed tabbed tails stay instant (apart views trimmed),
    // while untabbed/oversized hidden lanes are evicted with their positions and ended markers pruned.
    keepReaderPlaces(tabs({ one: ['hidden-tab', 'shown-views'] }));
    fakeBudgetChars = 0;
    store.apply({
      ...positioned('hidden-tab', rows(100), {
        transcriptViewItems: rows(20, 500),
        transcriptViews: [{ items: rows(20, 500) }],
      }),
      streamPosition: { epoch: 1, seq: 42, order: 0 },
    });
    store.apply({
      ...positioned('untabbed', rows(40)),
      streamPosition: { epoch: 1, seq: 9, order: 0 },
    });
    assert.deepEqual(store.streamPosition('hidden-tab'), { epoch: 1, seq: 42, order: 0 });
    assert.deepEqual(store.streamPosition('untabbed'), { epoch: 1, seq: 9, order: 0 });

    store.apply({ sessionId: 'ended-unshown', laneEnd: 'gone' });
    assert.equal(store.sessionEnded('ended-unshown'), true);

    _runIdleReclaimForTest();
    assert.equal(
      store.get('hidden-tab')?.items.length,
      100,
      'bounded idle reclaim keeps tabbed tail for instant revisit'
    );
    assert.deepEqual(
      store.get('hidden-tab')?.transcriptViews,
      [],
      'apart positioned views are trimmed on idle reclaim'
    );
    assert.equal(store.get('untabbed'), null, 'untabbed hidden lane is evicted on idle reclaim');
    assert.equal(store.streamPosition('untabbed'), null, 'positions are pruned when a lane is let go');
    assert.equal(store.sessionEnded('ended-unshown'), false, 'ended is pruned for unkept lanes on reclaim');
    assert.equal(store.get('shown-views')?.items.length, 11, 'shown lane remains pinned through idle reclaim');

    offShown();
  } finally {
    stop();
    unregisterFake();
    store.clear();
    keepReaderPlaces(tabs({}));
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
});
