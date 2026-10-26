import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRemoteScreenInput } from '../shared/remote-webrtc.ts';
import { createScreenGestureAdapter } from './remote-screen-gesture.ts';

const SIZE = { width: 1920, height: 1080 };
// The touch layer is not built yet: a local fake stands in for it, reporting
// the abstract actions the adapter is specified against.
const fakeTouch = (adapter) => (...actions) => actions.flatMap((action) => adapter.screenInputFromGesture(action));
const adapterOf = (options = {}) => createScreenGestureAdapter({ size: () => SIZE, ...options });
const pointer = (action, x, y, button) => ({
  type: 'screen-pointer',
  action,
  ...(button ? { button } : {}),
  x,
  y,
});

test('direct mode: a tap moves there, presses and lifts', () => {
  const touch = fakeTouch(adapterOf());
  assert.deepEqual(touch({ type: 'tap', at: { x: 100, y: 50 } }), [
    pointer('move', 100, 50),
    pointer('down', 100, 50, 'left'),
    pointer('up', 100, 50, 'left'),
  ]);
  const double = touch({ type: 'tap', at: { x: 1, y: 2 }, button: 'right', count: 2 });
  assert.deepEqual(
    double.map((input) => `${input.action}:${input.button ?? ''}`),
    ['move:', 'down:right', 'up:right', 'down:right', 'up:right']
  );
});

test('direct mode keeps points inside the picture and every message parses', () => {
  const touch = fakeTouch(adapterOf());
  const inputs = touch(
    { type: 'pointer-move', at: { x: -20, y: 5000 } },
    { type: 'scroll', at: { x: 10, y: 10 }, dx: 0, dy: 100 }
  );
  assert.deepEqual(inputs[0], pointer('move', 0, 1080));
  for (const input of inputs) assert.deepEqual(parseRemoteScreenInput(input), input);
});

test('a long-press drag holds the button across moves and lifts at its end', () => {
  const adapter = adapterOf();
  const touch = fakeTouch(adapter);
  assert.deepEqual(touch({ type: 'drag-start', at: { x: 10, y: 10 } }), [
    pointer('move', 10, 10),
    pointer('down', 10, 10, 'left'),
  ]);
  assert.equal(adapter.dragging, true);
  assert.deepEqual(touch({ type: 'drag-move', at: { x: 30, y: 40 } }), [pointer('move', 30, 40)]);
  assert.deepEqual(touch({ type: 'drag-end', at: { x: 50, y: 60 } }), [
    pointer('move', 50, 60),
    pointer('up', 50, 60, 'left'),
  ]);
  assert.equal(adapter.dragging, false);
  // Nothing held: moves and ends are ignored.
  assert.deepEqual(touch({ type: 'drag-move', at: { x: 1, y: 1 } }, { type: 'drag-end', at: { x: 1, y: 1 } }), []);
});

test('an interrupted drag lifts the button where it was pressed and releases everything', () => {
  const adapter = adapterOf();
  const touch = fakeTouch(adapter);
  touch({ type: 'drag-start', at: { x: 10, y: 10 }, button: 'right' }, { type: 'drag-move', at: { x: 90, y: 90 } });
  assert.deepEqual(touch({ type: 'drag-cancel' }), [pointer('up', 90, 90, 'right'), { type: 'screen-release' }]);
  assert.equal(adapter.dragging, false);
  assert.deepEqual(touch({ type: 'drag-cancel' }), []);
});

test('scroll sends WheelEvent-signed deltas in Windows wheel units, bounded', () => {
  const touch = fakeTouch(adapterOf());
  assert.deepEqual(touch({ type: 'scroll', at: { x: 5, y: 6 }, dx: -50, dy: 100 }), [
    { type: 'screen-wheel', x: 5, y: 6, deltaX: -60, deltaY: 120 },
  ]);
  assert.equal(touch({ type: 'scroll', at: { x: 5, y: 6 }, dx: 0, dy: 100000 })[0].deltaY, 4800);
  assert.deepEqual(touch({ type: 'scroll', at: { x: 5, y: 6 }, dx: 0, dy: 0 }), []);
});

test('trackpad mode moves a cursor by deltas and acts at it, ignoring the touch point', () => {
  const adapter = adapterOf({ mode: 'trackpad' });
  const touch = fakeTouch(adapter);
  // No PC cursor yet: it starts at the picture's centre.
  assert.deepEqual(touch({ type: 'pointer-delta', dx: 10, dy: -5 }), [pointer('move', 970, 535)]);
  assert.deepEqual(touch({ type: 'pointer-move', at: { x: 1, y: 1 } }), []);
  assert.deepEqual(touch({ type: 'tap', at: { x: 1, y: 1 } }), [
    pointer('move', 970, 535),
    pointer('down', 970, 535, 'left'),
    pointer('up', 970, 535, 'left'),
  ]);
  assert.deepEqual(touch({ type: 'pointer-delta', dx: 5000, dy: 5000 }), [pointer('move', 1920, 1080)]);
  assert.deepEqual(touch({ type: 'drag-start', at: { x: 0, y: 0 } }).at(-1), pointer('down', 1920, 1080, 'left'));
});

test('trackpad mode reads the PC cursor when a source reports one', () => {
  let cursor = { x: 400, y: 300 };
  const touch = fakeTouch(adapterOf({ mode: 'trackpad', cursor: () => cursor }));
  assert.deepEqual(touch({ type: 'pointer-delta', dx: 20, dy: 20 }), [pointer('move', 420, 320)]);
  cursor = { x: 10, y: 10 };
  assert.equal(touch({ type: 'tap', at: { x: 0, y: 0 } })[0].x, 10);
});

test('direct mode ignores relative moves, and switching mode never leaves a button held', () => {
  const adapter = adapterOf();
  const touch = fakeTouch(adapter);
  assert.deepEqual(touch({ type: 'pointer-delta', dx: 5, dy: 5 }), []);
  touch({ type: 'drag-start', at: { x: 7, y: 8 } });
  assert.deepEqual(adapter.setMode('trackpad'), [pointer('up', 7, 8, 'left'), { type: 'screen-release' }]);
  assert.equal(adapter.mode, 'trackpad');
  assert.deepEqual(adapter.setMode('trackpad'), []);
});
