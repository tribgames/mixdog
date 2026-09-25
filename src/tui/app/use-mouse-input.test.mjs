import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import React from 'react';
import { Text, render } from 'ink';
import { useMouseInput } from './use-mouse-input.mjs';

// The button-gesture half of the SGR mouse channel, mounted through the real
// hook: what each press / motion / release does to the selection in the
// transcript, status band and prompt box. Ctrl stands in for the extend
// modifier because Windows Terminal drops shift-modified events.

const LEFT = 0;
const RIGHT = 2;
const MOTION = 32;
const CTRL = 16;

function Harness({ control, deps }) {
  control.api = useMouseInput(deps);
  return React.createElement(Text, null, 'mouse');
}

function mount(context, { promptBoxRect = null } = {}) {
  const calls = {
    rects: [],
    throttled: [],
    spans: [],
    scrolls: [],
    promptClears: 0,
    prompt: [],
    words: [],
    lines: [],
  };
  const inkInput = new EventEmitter();
  const dragRef = {
    current: { anchor: null, anchorScroll: 0, last: null, active: false, rect: null, region: null, anchorSpan: null },
  };
  const lastClickRef = { current: { x: -1, y: -1, t: 0 } };
  const promptCtl = {
    clear: () => {
      calls.promptClears += 1;
    },
    hasSelection: () => false,
    offsetAtCell: (row, col) => row * 100 + col,
    anchorAt: (offset) => calls.prompt.push(['anchorAt', offset]),
    extendTo: (offset, final) => calls.prompt.push(['extendTo', offset, Boolean(final)]),
    selectWordAt: (offset) => calls.prompt.push(['selectWordAt', offset]),
    selectLineAt: (offset) => calls.prompt.push(['selectLineAt', offset]),
  };
  const applySelectionRect = (rect) => {
    calls.rects.push(rect);
    dragRef.current.rect = rect;
  };
  const deps = {
    inkInput,
    isRawModeSupported: true,
    store: {
      getWordRectAt: (x, y) => {
        calls.words.push([x, y]);
        return { x1: x - 1, y1: y, x2: x + 1, y2: y };
      },
      getLineRectAt: (y) => {
        calls.lines.push(y);
        return { x1: 0, y1: y, x2: 39, y2: y };
      },
    },
    stdout: { columns: 40, write: () => true },
    frameColumns: 40,
    statuslineBandRows: 2,
    dragRef,
    lastClickRef,
    slashPaletteRef: { current: null },
    scrollFocusRef: { current: null },
    promptMouseSelectionRef: { current: promptCtl },
    frameRowsRef: { current: 24 },
    promptBoxRectRef: { current: promptBoxRect },
    transcriptViewportRef: { current: { top: 0, bottom: 9 } },
    scrollTargetRef: { current: 5 },
    stopSmoothScroll: () => {},
    applySelectionRect,
    applySelectionRectThrottled: (rect) => calls.throttled.push(rect),
    selectionPointAtCurrentScroll: (point) => point,
    buildSpanRect: (span, x, y, region, anchorScroll) => {
      calls.spans.push({ kind: span.kind, x, y, region, anchorScroll });
      return { mode: 'span', x, y };
    },
    queueScrollCoalesced: (delta) => calls.scrolls.push(delta),
    setSlashIndex: () => {},
    setMeasuredRowsVersion: () => {},
    clearStitchBuffer: () => {},
  };
  const control = {};
  const stdout = new PassThrough();
  stdout.columns = 40;
  stdout.rows = 10;
  stdout.on('data', () => {});
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const view = render(React.createElement(Harness, { control, deps }), {
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
  // Grid cells are 0-based; SGR col/row are 1-based.
  const emit = (button, x, y, action = 'press') =>
    inkInput.emit('mouse', { kind: 'mouse', button, action, col: x + 1, row: y + 1 });
  const settle = () => delay(30);
  return { control, calls, dragRef, lastClickRef, emit, settle, promptCtl };
}

const linear = (x1, y1, x2, y2) => ({ mode: 'linear', x1, y1, x2, y2 });

test('press, drag and release in the transcript build a linear selection', async (context) => {
  const { calls, dragRef, emit, settle } = mount(context);
  await settle();
  emit(LEFT, 2, 1);
  assert.equal(dragRef.current.active, true);
  assert.equal(dragRef.current.region, 'transcript');
  assert.equal(dragRef.current.anchorScroll, 5);
  assert.deepEqual(calls.rects, []);
  emit(LEFT | MOTION, 7, 3);
  assert.deepEqual(calls.throttled, [linear(2, 1, 7, 3)]);
  emit(LEFT, 7, 3, 'release');
  assert.deepEqual(calls.rects, [linear(2, 1, 7, 3)]);
  assert.equal(dragRef.current.active, false);
});

test('a release on the press cell clears instead of painting an empty rect', async (context) => {
  const { calls, dragRef, emit, settle } = mount(context);
  await settle();
  emit(LEFT, 4, 2);
  emit(LEFT, 4, 2, 'release');
  assert.deepEqual(calls.rects, [null]);
  assert.equal(dragRef.current.active, false);
});

test('dragging past the viewport edge snaps the point and scrolls toward the edge', async (context) => {
  const { calls, emit, settle } = mount(context);
  await settle();
  emit(LEFT, 2, 5);
  emit(LEFT | MOTION, 7, 12);
  assert.deepEqual(calls.throttled, [linear(2, 5, 39, 9)]);
  assert.deepEqual(calls.scrolls, [-3]);
  emit(LEFT | MOTION, 7, 4);
  assert.deepEqual(calls.throttled.at(-1), linear(2, 5, 7, 4));
  emit(LEFT, 7, 4, 'release');
});

test('right press extends an existing char selection one-shot; ctrl+press keeps the drag armed', async (context) => {
  const { calls, dragRef, lastClickRef, emit, settle } = mount(context);
  await settle();
  emit(LEFT, 2, 1);
  emit(LEFT | MOTION, 5, 2);
  emit(LEFT, 5, 2, 'release');
  const clearsBefore = calls.promptClears;
  emit(RIGHT, 11, 5);
  assert.deepEqual(calls.rects.at(-1), linear(2, 1, 11, 5));
  assert.equal(dragRef.current.active, false);
  assert.deepEqual(dragRef.current.last, { x: 11, y: 5 });
  assert.equal(calls.promptClears, clearsBefore + 1);
  assert.equal(lastClickRef.current.count, 1);
  emit(LEFT | CTRL, 20, 8);
  assert.deepEqual(calls.rects.at(-1), linear(2, 1, 20, 8));
  assert.equal(dragRef.current.active, true);
  assert.equal(dragRef.current.region, 'transcript');
});

test('right press with nothing extendable is ignored', async (context) => {
  const { calls, dragRef, emit, settle } = mount(context);
  await settle();
  emit(RIGHT, 3, 3);
  emit(LEFT, 4, 2);
  emit(LEFT, 4, 2, 'release');
  const rectsBefore = calls.rects.length;
  emit(RIGHT, 8, 3);
  assert.equal(calls.rects.length, rectsBefore);
  assert.equal(dragRef.current.active, false);
});

test('double and triple clicks select word and line spans that later extend by span', async (context) => {
  const { calls, dragRef, emit, settle } = mount(context);
  await settle();
  emit(LEFT, 6, 2);
  emit(LEFT, 6, 2, 'release');
  emit(LEFT, 7, 2);
  assert.deepEqual(calls.words, [[7, 2]]);
  assert.deepEqual(calls.rects.at(-1), linear(6, 2, 8, 2));
  assert.equal(dragRef.current.anchorSpan.kind, 'word');
  emit(LEFT, 7, 2, 'release');
  assert.deepEqual(calls.spans.at(-1), { kind: 'word', x: 7, y: 2, region: 'transcript', anchorScroll: 5 });
  emit(LEFT, 7, 2);
  assert.deepEqual(calls.lines, [2]);
  assert.equal(dragRef.current.anchorSpan.kind, 'line');
  emit(LEFT, 7, 2, 'release');
  emit(RIGHT, 3, 8);
  assert.deepEqual(calls.spans.at(-1), { kind: 'line', x: 3, y: 8, region: 'transcript', anchorScroll: 5 });
  assert.deepEqual(calls.rects.at(-1), { mode: 'span', x: 3, y: 8 });
  assert.equal(dragRef.current.active, false);
});

test('status-band selections anchor without scroll and extend within the band', async (context) => {
  const { calls, dragRef, emit, settle } = mount(context);
  await settle();
  emit(LEFT, 1, 22);
  assert.equal(dragRef.current.region, 'status');
  assert.equal(dragRef.current.anchorScroll, 0);
  emit(LEFT | MOTION, 9, 23);
  emit(LEFT, 9, 23, 'release');
  assert.deepEqual(calls.rects.at(-1), linear(1, 22, 9, 23));
  emit(RIGHT, 12, 22);
  assert.deepEqual(calls.rects.at(-1), linear(1, 22, 12, 22));
});

test('a press outside every region clears all selections', async (context) => {
  const { calls, dragRef, emit, settle } = mount(context);
  await settle();
  emit(LEFT, 2, 1);
  emit(LEFT, 2, 15);
  assert.deepEqual(calls.rects, [null]);
  assert.equal(dragRef.current.active, false);
  assert.equal(dragRef.current.region, null);
});

test('prompt-box presses anchor, drag, extend and multi-click through the prompt engine', async (context) => {
  const { calls, promptCtl, emit, settle } = mount(context, {
    promptBoxRect: { top: 12, left: 2, height: 3, contentWidth: 30 },
  });
  await settle();
  emit(LEFT, 5, 13);
  assert.deepEqual(calls.prompt, [['anchorAt', 103]]);
  emit(LEFT | MOTION, 8, 14);
  emit(LEFT, 8, 14, 'release');
  assert.deepEqual(calls.prompt.slice(1), [
    ['extendTo', 206, false],
    ['extendTo', 206, true],
  ]);
  emit(LEFT, 5, 13);
  assert.deepEqual(calls.prompt.at(-1), ['selectWordAt', 103]);
  emit(LEFT, 5, 13, 'release');
  assert.deepEqual(calls.prompt.at(-1), ['selectWordAt', 103]);
  promptCtl.hasSelection = () => true;
  emit(RIGHT, 10, 12);
  assert.deepEqual(calls.prompt.at(-1), ['extendTo', 8, true]);
});

test('settleStuckDrag finalizes a drag whose release never arrived', async (context) => {
  const { control, calls, dragRef, emit, settle } = mount(context);
  await settle();
  assert.equal(control.api.settleStuckDrag(), false);
  emit(LEFT, 2, 1);
  emit(LEFT | MOTION, 6, 4);
  assert.equal(control.api.settleStuckDrag(), true);
  assert.deepEqual(calls.rects, [linear(2, 1, 6, 4)]);
  assert.equal(dragRef.current.active, false);
});
