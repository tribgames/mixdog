import assert from 'node:assert/strict';
import test from 'node:test';

import { holdKeyOf, isHoldDown, releaseCommandFor, screenInputCommands } from './screen-input-dispatch.ts';

const mapping = {
  generation: 5,
  pixelWidth: 1920,
  pixelHeight: 1080,
  physical: { x: 0, y: 0, width: 1920, height: 1080 },
};

test('pointer and wheel map only at the acknowledged generation', () => {
  assert.deepEqual(screenInputCommands({ type: 'screen-pointer', action: 'move', x: 960, y: 540 }, mapping, 5), [
    { op: 'move', x: 960, y: 540 },
  ]);
  // A stale generation drops the command (phone retries after geometry-ack).
  assert.equal(screenInputCommands({ type: 'screen-pointer', action: 'move', x: 960, y: 540 }, mapping, 4), null);
  // No mapping yet: nothing dispatched.
  assert.equal(screenInputCommands({ type: 'screen-wheel', x: 1, y: 1, deltaX: 0, deltaY: 120 }, null, 5), null);
});

test('wheel passes point and deltas, and drops a zero scroll', () => {
  assert.deepEqual(screenInputCommands({ type: 'screen-wheel', x: 0, y: 0, deltaX: 10, deltaY: -120 }, mapping, 5), [
    { op: 'wheel', x: 0, y: 0, dx: 10, dy: -120 },
  ]);
  assert.equal(screenInputCommands({ type: 'screen-wheel', x: 0, y: 0, deltaX: 0, deltaY: 0 }, mapping, 5), null);
});

test('a button up always maps, releasing in place when its geometry is stale', () => {
  // A press made before a geometry change must still be liftable.
  assert.deepEqual(screenInputCommands({ type: 'screen-pointer', action: 'up', button: 'left', x: 5, y: 5 }, mapping, 4), [
    { op: 'button', button: 'left', down: false },
  ]);
  assert.equal(screenInputCommands({ type: 'screen-pointer', action: 'down', button: 'left', x: 5, y: 5 }, mapping, 4), null);
  assert.deepEqual(screenInputCommands({ type: 'screen-pointer', action: 'down', button: 'left', x: 5, y: 5 }, mapping, 5), [
    { op: 'button', button: 'left', down: true, at: { x: 5, y: 5 } },
  ]);
});

test('keys and text pass through; release is the router’s', () => {
  assert.deepEqual(screenInputCommands({ type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e, extended: false }, null, 0), [
    { op: 'key', vk: 0x41, scan: 0x1e, extended: false, down: true },
  ]);
  assert.deepEqual(screenInputCommands({ type: 'screen-text', text: 'é😀' }, null, 0), [{ op: 'text', text: 'é😀' }]);
  assert.deepEqual(screenInputCommands({ type: 'screen-release' }, null, 0), []);
});

test('hold identity pairs a down with its up and builds the release', () => {
  const down = { op: 'key', vk: 0xa2, scan: 0x1d, extended: false, down: true };
  const up = { ...down, down: false };
  assert.equal(holdKeyOf(down), holdKeyOf(up));
  assert.notEqual(holdKeyOf(down), holdKeyOf({ ...down, extended: true }));
  assert.equal(isHoldDown(down), true);
  assert.equal(isHoldDown(up), false);
  assert.deepEqual(releaseCommandFor(down), up);
  assert.deepEqual(releaseCommandFor({ op: 'button', button: 'right', down: true, at: { x: 1, y: 1 } }), {
    op: 'button',
    button: 'right',
    down: false,
  });
  assert.equal(holdKeyOf({ op: 'move', x: 0, y: 0 }), null);
});
