import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import React, { useState } from 'react';
import { Text, render } from 'ink';
import { useTranscriptScroll } from './use-transcript-scroll.mjs';
import { theme } from '../theme.mjs';

const VIEW_ROWS = 10;
const TOTAL_ROWS = 100;
const COLUMNS = 40;
const STATUSLINE_BAND_ROWS = 2;

function makeGeometry() {
  const items = Array.from({ length: TOTAL_ROWS / VIEW_ROWS }, (_, index) => ({ id: `i${index}` }));
  const prefixRows = Array.from({ length: items.length + 1 }, (_, index) => index * VIEW_ROWS);
  return { totalRows: TOTAL_ROWS, viewRows: VIEW_ROWS, prefixRows, items };
}

function makeRefs() {
  return {
    scrollPositionRef: { current: 0 },
    scrollTargetRef: { current: 0 },
    maxScrollRowsRef: { current: TOTAL_ROWS - VIEW_ROWS },
    transcriptBottomSlackRowsRef: { current: 0 },
    followingRef: { current: true },
    transcriptAnchorRef: { current: null },
    transcriptAnchorDirtyRef: { current: false },
    transcriptGeomRef: { current: makeGeometry() },
    dragRef: { current: { active: false, region: null, rect: null } },
    frameRowsRef: { current: VIEW_ROWS + STATUSLINE_BAND_ROWS },
    transcriptViewportRef: { current: { top: 0, bottom: VIEW_ROWS - 1 } },
    selectionLayoutRef: { current: null },
    selectionTextRef: { current: '' },
  };
}

function makeStore() {
  const store = {
    state: {},
    painted: [],
    restoredOlder: 0,
    restoredNewer: 0,
    selectionRows: [],
    selectionText: '',
    getState: () => store.state,
    restoreOlderTranscript: () => {
      store.restoredOlder += 1;
      return true;
    },
    restoreNewerTranscript: () => {
      store.restoredNewer += 1;
      return true;
    },
    setRenderSelection: (rect) => {
      store.painted.push(rect);
    },
    getRenderSelectionRows: () => store.selectionRows,
    getRenderSelectionText: () => store.selectionText,
    getWordRectAt: (x, y) => (x >= 9 && x <= 12 ? { x1: 9, y1: y, x2: 12, y2: y } : null),
    getLineRectAt: () => null,
  };
  return store;
}

function Harness({ refs, store, control }) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [publish] = useState(() => (value) => {
    control.offsets.push(value);
    setScrollOffset(value);
  });
  control.scrollOffset = scrollOffset;
  control.api = useTranscriptScroll({
    store,
    frameColumns: COLUMNS,
    statuslineBandRows: STATUSLINE_BAND_ROWS,
    setScrollOffset: publish,
    ...refs,
  });
  return React.createElement(Text, null, `offset ${scrollOffset}`);
}

function mount(context) {
  const stdout = new PassThrough();
  stdout.columns = COLUMNS;
  stdout.rows = VIEW_ROWS + STATUSLINE_BAND_ROWS;
  stdout.on('data', () => {});
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const refs = makeRefs();
  const store = makeStore();
  const control = { offsets: [] };
  const element = () => React.createElement(Harness, { refs, store, control });
  const view = render(element(), {
    stdout,
    stdin,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  context.after(() => {
    view.unmount();
    stdin.end();
    stdout.end();
  });
  const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
  return { refs, store, control, view, element, settle };
}

const clipped = (rect, { captureText } = {}) => ({
  ...rect,
  clipY1: 0,
  clipY2: VIEW_ROWS - 1,
  selectionForeground: theme.selectionHighlightText || theme.selectionText,
  selectionBackground: theme.selectionHighlightBackground || theme.selectionBackground,
  ...(captureText === false ? { captureText: false } : {}),
});

test('manual scroll captures the reading anchor and a near-bottom downward scroll snaps back to the tail', async (context) => {
  const { refs, control, settle } = mount(context);
  await settle();
  control.api.scrollTranscriptRows(3);
  assert.equal(refs.scrollTargetRef.current, 3);
  assert.equal(refs.scrollPositionRef.current, 3);
  assert.equal(refs.followingRef.current, false);
  assert.deepEqual(refs.transcriptAnchorRef.current, { id: 'i8', offset: 7 });
  assert.equal(refs.transcriptAnchorDirtyRef.current, false);
  assert.deepEqual(control.offsets, [3]);

  control.api.scrollTranscriptRows(-1);
  assert.equal(refs.scrollTargetRef.current, 0, 'within the snap band the target lands on 0');
  assert.equal(refs.followingRef.current, true);
  assert.equal(refs.transcriptAnchorRef.current, null);
  assert.deepEqual(control.offsets, [3, 0]);

  control.api.scrollTranscriptRows(4, { smooth: true });
  assert.equal(refs.scrollTargetRef.current, 4);
  assert.equal(control.offsets.length, 2, 'a smooth scroll publishes through the animation, not synchronously');
  await settle(600);
  assert.equal(refs.scrollPositionRef.current, 4);
  assert.equal(control.offsets.at(-1), 4);

  control.api.resetTranscriptScroll();
  assert.equal(refs.scrollTargetRef.current, 0);
  assert.equal(refs.followingRef.current, true);
  assert.equal(control.offsets.at(-1), 0);
});

test('an upward intent blocked by a zero committed max is replayed once the max becomes available', async (context) => {
  const { refs, control, view, element, settle } = mount(context);
  await settle();
  refs.maxScrollRowsRef.current = 0;
  control.api.scrollTranscriptRows(5);
  assert.equal(refs.scrollTargetRef.current, 0);
  assert.equal(refs.followingRef.current, false, 'the blocked intent still cancels follow');
  refs.maxScrollRowsRef.current = TOTAL_ROWS - VIEW_ROWS;
  view.rerender(element());
  await settle();
  assert.equal(refs.scrollTargetRef.current, 5, 'the layout effect applies the preserved readback rows');
  assert.deepEqual(refs.transcriptAnchorRef.current, { id: 'i8', offset: 5 });
});

test('scrolling past either edge pages transcript history after capturing a restore anchor', async (context) => {
  const { refs, store, control, settle } = mount(context);
  await settle();
  store.state = { transcriptHistoryBefore: true };
  refs.scrollTargetRef.current = TOTAL_ROWS - VIEW_ROWS;
  control.api.scrollTranscriptRows(1);
  assert.equal(store.restoredOlder, 1);
  assert.deepEqual(refs.transcriptAnchorRef.current, { id: 'i0', offset: 0 });
  assert.equal(refs.scrollTargetRef.current, TOTAL_ROWS - VIEW_ROWS, 'paging older does not move the target');
  assert.equal(refs.followingRef.current, false);

  store.state = { transcriptHistoryAfter: true };
  refs.scrollTargetRef.current = 0;
  control.api.scrollTranscriptRows(-1);
  assert.equal(store.restoredNewer, 1);
  assert.equal(refs.scrollTargetRef.current, TOTAL_ROWS - VIEW_ROWS, 'paging newer keeps a positive anchored target');
  assert.equal(control.offsets.at(-1), TOTAL_ROWS - VIEW_ROWS);
});

test('selection paints through the themed clip, shifts with the scroll and stitches the scrolled-off rows', async (context) => {
  const { refs, store, control, settle } = mount(context);
  await settle();
  refs.dragRef.current = { active: false, region: 'transcript', rect: null };
  store.selectionText = 'hello world';
  store.selectionRows = [{ y: 2, text: 'hello world', sw: false }];
  const rect = { mode: 'linear', x1: 0, y1: 2, x2: 5, y2: 2 };
  control.api.applySelectionRect(rect);
  assert.deepEqual(store.painted, [clipped(rect)]);
  assert.deepEqual(refs.dragRef.current.rect, clipped(rect));
  assert.equal(control.api.gridSelectionActiveRef.current(), true);
  await settle();
  assert.equal(refs.selectionTextRef.current, 'hello world', 'the deferred capture remembers the rendered text');

  control.api.scrollTranscriptRows(2);
  const shifted = clipped({ ...rect, y1: 4, y2: 4 });
  assert.deepEqual(store.painted.at(-1), shifted, 'a released selection shifts with the applied delta');
  assert.deepEqual(refs.dragRef.current.rect, shifted);
  store.selectionRows = [];
  assert.deepEqual(control.api.getStitchedSelectionText(), { text: 'hello world', complete: true });

  assert.equal(control.api.moveSelectionFocus('right'), true);
  assert.deepEqual(store.painted.at(-1), clipped({ ...rect, y1: 4, x2: 6, y2: 4 }));
  assert.deepEqual(refs.dragRef.current.last, { x: 6, y: 4 });
  assert.equal(control.api.moveSelectionFocus('lineEnd'), true);
  assert.equal(store.painted.at(-1).x2, COLUMNS - 1);
  assert.equal(control.api.moveSelectionFocus('lineEnd'), false, 'a no-op move reports false');

  control.api.applySelectionRect(null);
  assert.equal(store.painted.at(-1), null);
  assert.equal(refs.selectionTextRef.current, '');
  assert.deepEqual(control.api.getStitchedSelectionText(), { text: '', complete: false });
  assert.equal(control.api.gridSelectionActiveRef.current(), false);
});

test('throttled selection paints coalesce into one deferred paint without text capture', async (context) => {
  const { refs, store, control, settle } = mount(context);
  await settle();
  refs.dragRef.current = { active: true, region: 'transcript', rect: null };
  const first = { mode: 'linear', x1: 0, y1: 1, x2: 1, y2: 1 };
  const second = { mode: 'linear', x1: 0, y1: 1, x2: 2, y2: 1 };
  control.api.applySelectionRectThrottled(first);
  control.api.applySelectionRectThrottled(second);
  assert.equal(store.painted.length, 1, 'the leading edge paints immediately, the follow-up waits');
  assert.deepEqual(store.painted[0], clipped(first, { captureText: false }));
  await settle();
  assert.deepEqual(store.painted, [clipped(first, { captureText: false }), clipped(second, { captureText: false })]);
  assert.equal(refs.selectionTextRef.current, '', 'motion paints never capture text');
});

test('word spans extend by whole words and coalesced wheel deltas flush as one scroll per tick', async (context) => {
  const { refs, control, settle } = mount(context);
  await settle();
  const span = { kind: 'word', lo: { x: 2, y: 3 }, hi: { x: 6, y: 3 } };
  assert.deepEqual(control.api.buildSpanRect(span, 10, 3, 'transcript', 0), {
    mode: 'linear',
    x1: 2,
    y1: 3,
    x2: 12,
    y2: 3,
  });
  assert.deepEqual(control.api.buildSpanRect(span, 20, 3, 'transcript', 0), {
    mode: 'linear',
    x1: 2,
    y1: 3,
    x2: 20,
    y2: 3,
  });

  control.api.queueScrollCoalesced(2);
  control.api.queueScrollCoalesced(2);
  assert.equal(refs.scrollTargetRef.current, 2, 'the first delta flushes immediately');
  await settle();
  assert.equal(refs.scrollTargetRef.current, 4, 'the rest flushes on the coalesce tick');
  control.api.armTranscriptFollow();
  assert.equal(refs.followingRef.current, true);
  assert.equal(refs.transcriptAnchorRef.current, null);
});
