import assert from 'node:assert/strict';
import test from 'node:test';
import { watchTouchZoom } from './touch-zoom.ts';

/** A touch event with `points` down ([x, y] each) and `lifted` released. */
function touchEvent(type, points, { lifted = [], at } = {}) {
  const event = new Event(type, { cancelable: true, bubbles: true });
  const list = (pairs) => pairs.map(([clientX, clientY]) => ({ clientX, clientY }));
  Object.defineProperty(event, 'touches', { value: list(points) });
  Object.defineProperty(event, 'changedTouches', { value: list(lifted) });
  if (at !== undefined) Object.defineProperty(event, 'timeStamp', { value: at });
  return event;
}

function watch(handlers) {
  const target = new EventTarget();
  const seen = { pinch: [], pan: [], doubleTap: [] };
  const record = (name) => (...args) => seen[name].push(args);
  const stop = watchTouchZoom(target, {
    pinch: record('pinch'),
    ...(handlers.pan ? { pan: record('pan') } : {}),
    ...(handlers.doubleTap ? { doubleTap: record('doubleTap') } : {}),
  });
  const send = (type, points, options) => {
    const event = touchEvent(type, points, options);
    target.dispatchEvent(event);
    return event;
  };
  return { target, seen, send, stop };
}

const product = (steps) => steps.reduce((total, [ratio]) => total * ratio, 1);

test('a pinch reports its steps about the midpoint and takes the move; one finger is left to the browser', () => {
  const { seen, send } = watch({});
  send('touchstart', [[100, 100]]);
  assert.equal(send('touchmove', [[100, 140]]).defaultPrevented, false, 'one finger still scrolls natively');
  send('touchstart', [
    [100, 100],
    [200, 100],
  ]);
  const move = send('touchmove', [
    [50, 100],
    [250, 100],
  ]);
  assert.equal(move.defaultPrevented, true);
  assert.deepEqual(seen.pinch, [[2, { x: 150, y: 100 }]]);
});

test('steps too small to report add up instead of being dropped', () => {
  const { seen, send } = watch({});
  send('touchstart', [
    [0, 0],
    [100, 0],
  ]);
  // A slow pinch: 0.1 px per event, each 0.1% of the spread.
  for (let step = 1; step <= 50; step += 1) send('touchmove', [
    [0, 0],
    [100 + step / 10, 0],
  ]);
  assert.ok(Math.abs(product(seen.pinch) - 1.05) < 0.003, `reported ${product(seen.pinch)}`);
});

test('with pan, one finger pans past the slop from where it went down, and a pinch pans by its midpoint', () => {
  const { seen, send } = watch({ pan: true });
  send('touchstart', [[100, 100]]);
  assert.equal(send('touchmove', [[103, 104]]).defaultPrevented, true, 'the surface owns the touch');
  assert.deepEqual(seen.pan, [], 'within the slop it may still be a tap');
  send('touchmove', [[120, 100]]);
  send('touchmove', [[130, 90]]);
  assert.deepEqual(seen.pan, [
    [20, 0],
    [10, -10],
  ]);
  seen.pan.length = 0;
  send('touchstart', [
    [130, 90],
    [230, 90],
  ]);
  send('touchmove', [
    [140, 100],
    [240, 100],
  ]);
  assert.deepEqual(seen.pinch, [], 'the spread did not change');
  assert.deepEqual(seen.pan, [[10, 10]]);
  // One finger lifted: the other carries on from where it is.
  seen.pan.length = 0;
  send('touchend', [[240, 100]], { lifted: [[140, 100]] });
  send('touchmove', [[250, 100]]);
  assert.deepEqual(seen.pan, [[10, 0]]);
});

test('with pan, the picture points under the fingers stay there as the spread and the midpoint change together', () => {
  // A picture drawn at window x = offset + scale * u (u: picture px), as a
  // viewer applies the reported steps.
  const view = { scale: 1, offset: 0 };
  const target = new EventTarget();
  watchTouchZoom(target, {
    pinch: (ratio, at) => {
      view.offset = at.x - ratio * (at.x - view.offset);
      view.scale *= ratio;
    },
    pan: (dx) => {
      view.offset += dx;
    },
  });
  const send = (type, points) => target.dispatchEvent(touchEvent(type, points));
  send('touchstart', [
    [100, 0],
    [200, 0],
  ]);
  // Spread 100 → 200 while the midpoint goes 150 → 200, in several moves.
  for (let step = 1; step <= 4; step += 1)
    send('touchmove', [
      [100, 0],
      [200 + 25 * step, 0],
    ]);
  const onPicture = (x) => (x - view.offset) / view.scale;
  assert.ok(Math.abs(view.scale - 2) < 1e-9);
  assert.ok(Math.abs(onPicture(100) - 100) < 1e-9, `finger A is over picture px ${onPicture(100)}`);
  assert.ok(Math.abs(onPicture(300) - 200) < 1e-9, `finger B is over picture px ${onPicture(300)}`);
});

test('two quick taps close together are a double tap whose emulated click is cancelled', () => {
  const { seen, send } = watch({ pan: true, doubleTap: true });
  const tap = (x, y, at) => {
    send('touchstart', [[x, y]], { at });
    return send('touchend', [], { lifted: [[x, y]], at });
  };
  assert.equal(tap(50, 50, 1000).defaultPrevented, false, 'a single tap clicks as usual');
  const second = tap(60, 55, 1200);
  assert.equal(second.defaultPrevented, true);
  assert.deepEqual(seen.doubleTap, [[{ x: 60, y: 55 }]]);

  // Too slow, too far apart, or a drag: no double tap.
  tap(50, 50, 2000);
  tap(50, 50, 2400);
  tap(50, 50, 3000);
  tap(300, 300, 3100);
  send('touchstart', [[50, 50]], { at: 4000 });
  send('touchmove', [[80, 50]]);
  send('touchend', [], { lifted: [[80, 50]], at: 4050 });
  tap(80, 50, 4100);
  assert.equal(seen.doubleTap.length, 1);
});

test('a move an inner surface took is not taken again by an outer one', () => {
  const outer = watch({});
  const inner = new EventTarget();
  const taken = [];
  watchTouchZoom(inner, { pinch: (ratio) => taken.push(ratio) });
  // The inner surface sits under the outer one: each event reaches it first.
  const send = (type, points) => {
    const event = touchEvent(type, points);
    inner.dispatchEvent(event);
    outer.target.dispatchEvent(event);
  };
  send('touchstart', [
    [0, 0],
    [100, 0],
  ]);
  send('touchmove', [
    [0, 0],
    [200, 0],
  ]);
  assert.deepEqual(taken, [2]);
  assert.deepEqual(outer.seen.pinch, []);
});

test('the cleanup stops watching', () => {
  const { seen, send, stop } = watch({});
  stop();
  send('touchstart', [
    [0, 0],
    [100, 0],
  ]);
  send('touchmove', [
    [0, 0],
    [200, 0],
  ]);
  assert.deepEqual(seen.pinch, []);
});
