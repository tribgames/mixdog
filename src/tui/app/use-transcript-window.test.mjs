import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import React, { useState } from 'react';
import { Box, Text, render } from 'ink';
import { useTranscriptWindow } from './use-transcript-window.mjs';
import { transcriptRowAt, upperBound } from './transcript-window.mjs';

const VIEW_ROWS = 6;
const COLUMNS = 40;

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
