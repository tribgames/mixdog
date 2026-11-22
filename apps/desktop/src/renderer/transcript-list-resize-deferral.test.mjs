import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

/** A reader's timeline (start anchored) whose reading line sits at 500px: the
 *  first row ends at `firstEnd`, a second row follows it. */
async function readerTimeline(root, firstEnd) {
  const { useVirtualizerResizePatch } = await import('./transcript-list-resize-patch.ts');
  const keys = ['folding', 'below'];
  const core = {
    options: { anchorTo: 'start', followOnAppend: false, count: 2, getItemKey: (index) => keys[index] },
    elementsCache: new Map(),
    itemSizeCache: new Map([
      ['folding', firstEnd],
      ['below', 300],
    ]),
    get measurementsCache() {
      let start = 0;
      return keys.map((key, index) => {
        const size = this.itemSizeCache.get(key);
        const item = { key, index, start, end: start + size, size, lane: 0 };
        start += size;
        return item;
      });
    },
    indexFromElement: () => -1,
    resizeItem: (index, size) => void core.itemSizeCache.set(keys[index], size),
  };
  const state = { pendingResizes: null };
  function Harness() {
    const pendingResizes = useRef(new Map());
    state.pendingResizes = pendingResizes.current;
    useVirtualizerResizePatch({
      virtualizer: core,
      viewport: { current: null },
      // A wheel notch just before the click: the reader's gesture window is open.
      hasScrollGestureRef: useRef(() => true),
      visibleTop: () => 500,
      maxScrollTop: () => 0,
      endPin: { request() {} },
      resizePinned: useRef([]),
      resizePinFrame: useRef(0),
      pendingResizes,
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
  return { core, state };
}

test('a row folding on screen lands at once during a reader gesture; one wholly above waits', async (t) => {
  // "Show less" at the bottom of an expanded message whose top is above the
  // view: its old box reaches into view, its folded box ends above it.
  const { root } = installTestDom(t, { rootId: 'root' });
  const onScreen = await readerTimeline(root, 800);
  onScreen.core.resizeItem(0, 150);
  assert.equal(onScreen.core.itemSizeCache.get('folding'), 150, 'the fold lands in the frame it paints');
  assert.equal(onScreen.state.pendingResizes.size, 0, 'nothing is left to land later with a scroll correction');

  const above = await readerTimeline(root, 400);
  above.core.resizeItem(0, 150);
  assert.equal(above.core.itemSizeCache.get('folding'), 400, 'a row wholly above the reader waits for the gesture');
  assert.equal(above.state.pendingResizes.get('folding')?.size, 150);
});
