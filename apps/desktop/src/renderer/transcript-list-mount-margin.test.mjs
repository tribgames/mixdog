import assert from 'node:assert/strict';
import test from 'node:test';
import { observeTranscriptWidth } from './transcript-list-resize-patch.ts';
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
  assert.deepEqual(transcriptMountMargin(rows(5, 100), { startIndex: 0, endIndex: 4, count: 5 }, 600), { from: 0, to: 4 });
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
  stop();
  assert.equal(observed[0].target, null);
  assert.equal(typeof observeTranscriptWidth(null, () => {}), 'function', 'no viewport, nothing to watch');
});
