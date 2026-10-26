import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRemoteScreenInput } from '../shared/remote-webrtc.ts';
import { createScreenGestureAdapter } from './remote-screen-gesture.ts';

const SIZE = { width: 1920, height: 1080 };
// The adapter is specified against the abstract actions the touch layer
// reports (remote-screen-touch.test.mjs drives it with the real one).
const fakeTouch =
  (adapter) =>
  (...actions) =>
    actions.flatMap((action) => adapter.screenInputFromGesture(action));
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
  assert.deepEqual(touch({ type: 'drag-move', at: { x: 30, y: 40 } }), [pointer('move', 30, 40)]);
  assert.deepEqual(touch({ type: 'drag-end', at: { x: 50, y: 60 } }), [
    pointer('move', 50, 60),
    pointer('up', 50, 60, 'left'),
  ]);
  // Nothing held: moves and ends are ignored.
  assert.deepEqual(touch({ type: 'drag-move', at: { x: 1, y: 1 } }, { type: 'drag-end', at: { x: 1, y: 1 } }), []);
});

test('an interrupted drag lifts the button where it was pressed and releases everything', () => {
  const adapter = adapterOf();
  const touch = fakeTouch(adapter);
  touch({ type: 'drag-start', at: { x: 10, y: 10 }, button: 'right' }, { type: 'drag-move', at: { x: 90, y: 90 } });
  assert.deepEqual(adapter.cancel(), [pointer('up', 90, 90, 'right'), { type: 'screen-release' }]);
  assert.deepEqual(adapter.cancel(), []);
});

test('scroll sends WheelEvent-signed deltas in Windows wheel units, bounded', () => {
  const touch = fakeTouch(adapterOf());
  assert.deepEqual(touch({ type: 'scroll', at: { x: 5, y: 6 }, dx: -50, dy: 100 }), [
    { type: 'screen-wheel', x: 5, y: 6, deltaX: -60, deltaY: 120 },
  ]);
  assert.equal(touch({ type: 'scroll', at: { x: 5, y: 6 }, dx: 0, dy: 100000 })[0].deltaY, 4800);
  assert.deepEqual(touch({ type: 'scroll', at: { x: 5, y: 6 }, dx: 0, dy: 0 }), []);
});

test('a slow swipe adds up: the remainder of a wheel is carried to the next', () => {
  const touch = fakeTouch(adapterOf());
  const scroll = (dy) => touch({ type: 'scroll', at: { x: 5, y: 6 }, dx: 0, dy });
  // 0.5 px is 0.6 of a unit: nothing yet, then the carried 0.6 + 0.6 sends 1.
  assert.deepEqual(scroll(0.5), []);
  assert.deepEqual(scroll(0.5), [{ type: 'screen-wheel', x: 5, y: 6, deltaX: 0, deltaY: 1 }]);
  // 0.2 of a unit stays; 0.5 px more is 0.8 in all: still nothing.
  assert.deepEqual(scroll(0.5), []);
  // Negative travel counts toward zero, not away from it.
  const up = fakeTouch(adapterOf());
  assert.deepEqual(up({ type: 'scroll', at: { x: 0, y: 0 }, dx: 0, dy: -1.5 }), [
    { type: 'screen-wheel', x: 0, y: 0, deltaX: 0, deltaY: -1 },
  ]);
});

test('the adapter has no strategy of its own: points are absolute, the pointer moves without a button', () => {
  const touch = fakeTouch(adapterOf());
  assert.deepEqual(touch({ type: 'pointer-move', at: { x: 7, y: 8 } }), [pointer('move', 7, 8)]);
});
