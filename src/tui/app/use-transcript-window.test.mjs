import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import React, { useState } from 'react';
import { Box, Text, render } from 'ink';
import { useTranscriptWindow } from './use-transcript-window.mjs';
import {
  estimateTranscriptItemRowsCached,
  hasStreamingRowStateToPrune,
  pruneStreamingMeasuredRowsById,
  selectionRectIsDegenerate,
  statusBandRowRange,
  transcriptRowAt,
  transcriptViewportRowRange,
  upperBound,
} from './transcript-window.mjs';
import { estimateTranscriptItemRows } from './transcript-row-estimate.mjs';

const VIEW_ROWS = 6;
const COLUMNS = 40;

// The selection geometry every reader shares: the empty-rect predicate and the
// two row ranges (transcript viewport, bottom status band).
test('shared selection geometry normalizes both row ranges and the empty rect', () => {
  assert.equal(selectionRectIsDegenerate({ x1: 3, y1: 4, x2: 3, y2: 4 }), true);
  assert.equal(selectionRectIsDegenerate({ x1: 3, y1: 4, x2: 4, y2: 4 }), false);
  assert.equal(selectionRectIsDegenerate({ x1: 3, y1: 4, x2: 3, y2: 5 }), false);

  assert.deepEqual(transcriptViewportRowRange({ top: 2, bottom: 9 }), { top: 2, bottom: 9 });
  assert.deepEqual(transcriptViewportRowRange({ top: -4, bottom: 3 }), { top: 0, bottom: 3 });
  assert.deepEqual(transcriptViewportRowRange({ top: 7, bottom: 2 }), { top: 7, bottom: 7 });
  assert.deepEqual(transcriptViewportRowRange(undefined), { top: 0, bottom: 0 });

  assert.deepEqual(statusBandRowRange(24, 2), { top: 22, bottom: 23 });
  assert.deepEqual(statusBandRowRange(0, 2), { top: 22, bottom: 23 }, 'a missing frame height means 24 rows');
  assert.deepEqual(statusBandRowRange(3, 8), { top: 0, bottom: 2 });
  assert.deepEqual(statusBandRowRange(1, 2), { top: 0, bottom: 0 });
});

function makeItems(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `u${index}`, kind: 'user', text: `line ${index}` }));
}

function makeRefs() {
  return {
    transcriptAnchorRef: { current: null },
    transcriptAnchorDirtyRef: { current: false },
    scrollTargetRef: { current: 0 },
    scrollPositionRef: { current: 0 },
    maxScrollRowsRef: { current: 0 },
    transcriptGeomRef: { current: {} },
    followingRef: { current: true },
    dragRef: { current: { active: false, rect: null } },
    transcriptViewportRef: { current: { top: 0 } },
    selectionLayoutRef: { current: null },
  };
}

/** Mirrors the wheel handler in use-transcript-scroll.mjs: move the target and
 *  capture the reading anchor from the last published geometry. */
function scrollUpBy(refs, rows) {
  refs.followingRef.current = false;
  refs.scrollTargetRef.current = rows;
  refs.scrollPositionRef.current = rows;
  const geom = refs.transcriptGeomRef.current;
  const anchorRow = Math.max(0, Math.min(geom.totalRows, geom.totalRows - rows - geom.viewRows));
  let index = upperBound(geom.prefixRows, anchorRow) - 1;
  if (index < 0) index = 0;
  if (index > geom.prefixRows.length - 2) index = geom.prefixRows.length - 2;
  const anchorItem = geom.items[index];
  refs.transcriptAnchorRef.current = {
    id: anchorItem.id,
    offset: Math.max(0, anchorRow - transcriptRowAt(geom.prefixRows, index)),
  };
  refs.transcriptAnchorDirtyRef.current = false;
}

function Harness({ items, revision, refs, control }) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [measuredRowsVersion, setMeasuredRowsVersion] = useState(0);
  control.setScrollOffset = setScrollOffset;
  control.scrollOffset = scrollOffset;
  const view = useTranscriptWindow({
    items,
    structureRevision: revision,
    sessionKey: 'session-1',
    streamingTail: null,
    themeEpoch: 0,
    frameColumns: COLUMNS,
    toolOutputExpanded: false,
    transcriptContentHeight: VIEW_ROWS,
    transcriptBottomSlackRows: 0,
    transcriptGuardRows: 0,
    floatingPanelRows: 0,
    overlayHintRequested: false,
    scrollOffset,
    setScrollOffset,
    ...refs,
    withSelectionClip: (rect) => rect,
    paintSelectionRect: () => {},
    stopSmoothScroll: () => {},
    measuredRowsVersion,
    setMeasuredRowsVersion,
  });
  control.view = view;
  return React.createElement(
    Box,
    { flexDirection: 'column', height: VIEW_ROWS, overflow: 'hidden', justifyContent: 'flex-end' },
    React.createElement(
      Box,
      {
        flexDirection: 'column',
        width: '100%',
        flexShrink: 0,
        marginBottom: -view.transcriptWindow.effectiveScrollOffset,
      },
      ...view.renderedTranscriptItems.map((item) =>
        React.createElement(
          Box,
          { key: item.id, ref: view.transcriptMeasureRef(item) },
          React.createElement(Text, null, item.text)
        )
      ),
      view.transcriptWindow.bottomSpacerRows > 0
        ? React.createElement(Box, { height: view.transcriptWindow.bottomSpacerRows, flexShrink: 0 })
        : null
    )
  );
}

test('transcript window follows the tail, then holds the reading anchor while rows grow', async (context) => {
  const stdout = new PassThrough();
  stdout.columns = COLUMNS;
  stdout.rows = VIEW_ROWS;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let screen = '';
  stdout.on('data', (chunk) => {
    screen = String(chunk);
  });
  const refs = makeRefs();
  const control = {};
  const element = (count, revision) =>
    React.createElement(Harness, { items: makeItems(count), revision, refs, control });
  const view = render(element(200, 1), {
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
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  const visibleLines = () =>
    stripVTControlCharacters(screen)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const expectedLines = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => `line ${from + index}`);

  await settle();
  assert.deepEqual(visibleLines(), expectedLines(194, 199), 'a fresh transcript is pinned to the bottom');
  assert.equal(control.view.transcriptTailPinned, true);

  view.rerender(element(205, 2));
  await settle();
  assert.deepEqual(visibleLines(), expectedLines(199, 204), 'bottom-follow reveals appended rows');
  assert.equal(refs.followingRef.current, true);
  assert.equal(control.scrollOffset, 0);

  scrollUpBy(refs, 3);
  control.setScrollOffset(3);
  await settle();
  assert.deepEqual(visibleLines(), expectedLines(196, 201), 'a manual scroll shows the older rows');
  assert.equal(control.view.transcriptTailPinned, false);

  view.rerender(element(210, 3));
  await settle();
  assert.deepEqual(visibleLines(), expectedLines(196, 201), 'growth below the anchor leaves the top row in place');
  assert.equal(refs.followingRef.current, false);
  assert.equal(refs.transcriptAnchorRef.current?.id, 'u196');

  refs.followingRef.current = true;
  refs.scrollTargetRef.current = 0;
  refs.scrollPositionRef.current = 0;
  refs.transcriptAnchorRef.current = null;
  control.setScrollOffset(0);
  await settle();
  assert.deepEqual(visibleLines(), expectedLines(204, 209), 'returning to the tail re-pins the newest rows');
  assert.equal(control.view.transcriptTailPinned, true);
  assert.ok(refs.maxScrollRowsRef.current >= 210 - VIEW_ROWS, 'the committed max scroll reaches the oldest row');
});

test('streaming estimates trim boundary newlines and retain high-water rows only until pruning or settlement', () => {
  pruneStreamingMeasuredRowsById(new Set());
  const short = { id: 'row-estimate-stream', kind: 'assistant', streaming: true, text: '\nalpha\n' };
  const long = { ...short, text: '\nalpha\nbeta\ngamma\n' };
  assert.equal(estimateTranscriptItemRowsCached(short, 80, false), 2);
  assert.equal(estimateTranscriptItemRowsCached(long, 80, false), 4);
  assert.equal(estimateTranscriptItemRowsCached(short, 80, false), 4);
  pruneStreamingMeasuredRowsById(new Set([short.id]));
  assert.equal(hasStreamingRowStateToPrune(), true);
  pruneStreamingMeasuredRowsById(new Set());
  assert.equal(hasStreamingRowStateToPrune(), false);
  assert.equal(estimateTranscriptItemRowsCached(short, 80, false), 2);
  estimateTranscriptItemRowsCached({ ...short, streaming: false }, 80, false);
  assert.equal(hasStreamingRowStateToPrune(), false);
});

test('expanded aggregate row estimates distinguish pending, raw-body, and summary-only cards', () => {
  const item = {
    id: 'aggregate-rows',
    kind: 'tool',
    name: 'read',
    aggregate: true,
    count: 2,
    completedCount: 2,
    result: 'summary',
    rawResult: 'first\nsecond',
  };
  assert.equal(estimateTranscriptItemRows(item, 80, true), 4, 'margin, header, and two body rows');
  assert.equal(estimateTranscriptItemRows(item, 80, true, true), 3, 'attached cards omit the margin');
  assert.equal(estimateTranscriptItemRows(item, 80, false), 3, 'collapsed cards keep one detail row');
  assert.equal(estimateTranscriptItemRows({ ...item, completedCount: 1 }, 80, true), 3, 'pending cards stay collapsed');
  assert.equal(estimateTranscriptItemRows({ ...item, completedCount: undefined }, 80, true), 4);
  assert.equal(estimateTranscriptItemRows({ ...item, rawResult: null }, 80, true), 3);
  assert.equal(estimateTranscriptItemRows({ ...item, rawResult: ' \n' }, 80, true), 3);
});

test('failed agent cards show a detail row only when a brief is available', () => {
  const item = {
    id: 'agent-rows',
    kind: 'tool',
    name: 'agent',
    count: 1,
    completedCount: 1,
    isError: true,
    args: { task_id: 'task-rows', status: 'failed', error: 'timed out' },
  };
  assert.equal(estimateTranscriptItemRows(item, 80, false), 2, 'margin and failure header only');
  assert.equal(estimateTranscriptItemRows({ ...item, args: { ...item.args, prompt: 'check rows' } }, 80, false), 3);
});

test('transcript environment switches default on and recognize only explicit off values', async (context) => {
  const names = ['MIXDOG_TUI_TRANSCRIPT_MEASURED', 'MIXDOG_TUI_SCROLL_ACCELERATION'];
  const previous = names.map((name) => process.env[name]);
  context.after(() => {
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  });
  const cases = [
    [undefined, true],
    ['', true],
    ['unexpected', true],
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['0', false],
    ['FALSE', false],
    [' off ', false],
    ['no', false],
  ];
  for (const [index, [value, expected]] of cases.entries()) {
    for (const name of names) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const switches = await import(`./transcript-window.mjs?env-switch-case=${index}`);
    assert.equal(switches.TRANSCRIPT_MEASURED_ROWS, expected, `measured rows: ${value}`);
    assert.equal(switches.WHEEL_ACCEL_ENABLED, expected, `wheel acceleration: ${value}`);
  }
});
