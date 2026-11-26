import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTranscriptWidthSync,
  observeTranscriptWidth,
  registerTranscriptWidthSync,
  syncTranscriptWidths,
} from './transcript-list-resize-patch.ts';
import { beginActiveResize, endActiveResize } from './resize-gesture.ts';
import { transcriptMountMargin } from './transcript-list-virtualizer.ts';

/** Rows of the given heights laid end to end. */
function laid(heights) {
  let start = 0;
  return heights.map((size) => {
    const row = { start, end: start + size };
    start += size;
    return row;
  });
}
const rows = (count, size) => laid(Array.from({ length: count }, () => size));

test('the mounted margin is a viewport height on each side, whatever the rows are tall', () => {
  // 30px rows in a 600px viewport: rows 100..119 are in view, and 20 rows more fill a viewport on each side.
  const short = transcriptMountMargin(rows(400, 30), { startIndex: 100, endIndex: 119, count: 400 }, 600);
  assert.deepEqual(short, { from: 80, to: 139 });
  // 1500px rows: one row past the view reaches a viewport away.
  const tall = transcriptMountMargin(rows(50, 1500), { startIndex: 20, endIndex: 20, count: 50 }, 600);
  assert.deepEqual(tall, { from: 19, to: 21 });
  // The ends of the list.
  assert.deepEqual(transcriptMountMargin(rows(5, 100), { startIndex: 0, endIndex: 4, count: 5 }, 600), {
    from: 0,
    to: 4,
  });
});

test('rows that take no room do not extend the margin without end', () => {
  // 500 rows of no height around one that fills the view: a side holds at most a viewport of 24px rows.
  const heights = [...Array.from({ length: 500 }, () => 0), 600, ...Array.from({ length: 500 }, () => 0)];
  const margin = transcriptMountMargin(laid(heights), { startIndex: 500, endIndex: 500, count: 1001 }, 600);
  assert.deepEqual(margin, { from: 475, to: 525 });
});

test('before the viewport is measured there is no margin to compute', () => {
  assert.equal(transcriptMountMargin(rows(10, 30), { startIndex: 0, endIndex: 3, count: 10 }, 0), null);
  assert.equal(transcriptMountMargin([], { startIndex: 0, endIndex: 0, count: 0 }, 600), null);
});

test("every change of the list's box runs its width pass: the sidebar and a split's divider are seen on the viewport itself", (t) => {
  const observed = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      observed.push(this);
    }
    observe(target) {
      this.target = target;
    }
    disconnect() {
      this.target = null;
    }
  };
  t.after(() => {
    globalThis.ResizeObserver = original;
  });
  const viewport = {};
  let passes = 0;
  const stop = observeTranscriptWidth(viewport, () => (passes += 1));
  assert.equal(observed.length, 1);
  assert.equal(observed[0].target, viewport);
  observed[0].callback([]);
  assert.equal(passes, 1, 'a layout of the box at another size runs the pass');
  beginActiveResize();
  observed[0].callback([]);
  assert.equal(passes, 1, 'width sync defers while a horizontal drag resize is active');
  endActiveResize();
  assert.equal(passes, 2, 'deferred width sync flushes once when drag resize ends');
  stop();
  assert.equal(observed[0].target, null);
  assert.equal(typeof observeTranscriptWidth(null, () => {}), 'function', 'no viewport, nothing to watch');
});

test('createTranscriptWidthSync detects spacer width changes and re-measures dock inset in the same pass', () => {
  const viewport = { isConnected: true, offsetWidth: 1000, clientHeight: 600, scrollHeight: 1200, scrollTop: 600 };
  const spacer = { offsetWidth: 848, children: [], querySelectorAll: () => [] };
  let dockSyncs = 0;
  let endPins = 0;
  const sync = createTranscriptWidthSync({
    getViewport: () => viewport,
    getSpacer: () => spacer,
    getVirtualizer: () => ({
      options: { anchorTo: 'end', followOnAppend: true },
      scrollRect: { width: 1000, height: 600 },
      scrollOffset: 600,
      measurementsCache: [],
      getTotalSize: () => 1200,
      getVirtualItems: () => [],
      measure: () => {},
    }),
    rows: () => [],
    scrollInset: () => 0,
    indexForPendingKey: () => -1,
    pendingResizes: { current: new Map() },
    baseResizeItem: { current: () => {} },
    suppressAdjustment: { current: false },
    endPin: { now: () => (endPins += 1) },
    anchorHold: { current: null },
    restoreReadingAnchor: () => {},
    syncDockInset: () => {
      dockSyncs += 1;
      return true;
    },
  });
  sync();
  assert.equal(dockSyncs, 1, 'initial pass records spacer width');
  sync();
  assert.equal(dockSyncs, 1, 'unchanged viewport and spacer widths skip work');
  // Padding change (--session-rail-over) alters spacer width while viewport offsetWidth stays 1000.
  spacer.offsetWidth = 700;
  sync();
  assert.equal(dockSyncs, 2, 'spacer width change triggers width sync and dock inset measurement');
  assert.equal(endPins, 2, 'end pin runs in the same pass');
  // Height-only dock inset sync via syncTranscriptWidths({ dockInset: true }) runs syncDockInset + endPin.now()
  // even when viewport and spacer widths are unchanged.
  const unregister = registerTranscriptWidthSync(sync);
  try {
    syncTranscriptWidths({ dockInset: true });
    assert.equal(dockSyncs, 3, 'dockInset option forces dock inset measurement with unchanged widths');
    assert.equal(endPins, 3, 'endPin.now() runs when height-only dock inset changes');
  } finally {
    unregister();
  }
});

test('height-only dockInset width sync does not restore a reading anchor after the reader scrolled away', () => {
  const viewport = { isConnected: true, offsetWidth: 1000, clientHeight: 600, scrollHeight: 1200, scrollTop: 300 };
  const spacer = { offsetWidth: 848, children: [], querySelectorAll: () => [] };
  const anchorHold = { current: { key: 'row-10', index: 10, offset: 0, start: 500 } };
  let scrollOffset = 500;
  let restores = 0;
  const readingAnchorHeld = () => {
    const hold = anchorHold.current;
    if (!hold) return false;
    if (hold.start !== null && Math.abs(hold.start - hold.offset - scrollOffset) >= 1) {
      anchorHold.current = null;
      return false;
    }
    return true;
  };
  const sync = createTranscriptWidthSync({
    getViewport: () => viewport,
    getSpacer: () => spacer,
    getVirtualizer: () => ({
      options: { anchorTo: 'start', followOnAppend: false },
      scrollRect: { width: 1000, height: 600 },
      scrollOffset,
      measurementsCache: [],
      getTotalSize: () => 1200,
      getVirtualItems: () => [],
      measure: () => {},
    }),
    rows: () => [],
    scrollInset: () => 0,
    indexForPendingKey: () => -1,
    pendingResizes: { current: new Map() },
    baseResizeItem: { current: () => {} },
    suppressAdjustment: { current: false },
    endPin: { now: () => {} },
    anchorHold,
    readingAnchorHeld,
    restoreReadingAnchor: () => {
      restores += 1;
    },
    syncDockInset: () => true,
  });
  // Seed initial width state.
  sync();
  assert.equal(restores, 0);
  // While the reader still holds the landed anchor (scrollOffset === 500), a height-only dockInset sync restores it.
  const unregister = registerTranscriptWidthSync(sync);
  try {
    syncTranscriptWidths({ dockInset: true });
    assert.equal(restores, 1, 'held landed anchor still restores on height-only dockInset change');
    // Reader scrolls away from the landed row without any row resize clearing anchorHold.
    scrollOffset = 300;
    syncTranscriptWidths({ dockInset: true });
    assert.equal(restores, 1, 'moved reader is not snapped back to the old landed anchor');
    assert.equal(anchorHold.current, null, 'stale anchorHold is cleared once movement is detected');
  } finally {
    unregister();
  }
});
