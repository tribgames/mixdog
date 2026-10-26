import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLING_PAN_TIME_CONSTANT_MS,
  FLING_STOP_SPEED,
  flingTravel,
  flingVelocity,
  startFling,
} from './remote-fling.ts';
import {
  createTouchGestures,
  DOUBLE_TAP_SLOP_PX,
  EDGE_SLOP_PX,
  FEEDBACK_RADIUS_PX,
  TOUCH_LONG_PRESS_MS,
  viewportGestureBindings,
} from './remote-touch-gestures.ts';
import { initialView, pictureToStage, viewBounds } from './remote-viewport.ts';

/**
 * A stage at client (10, 20) showing a picture through the shared viewport,
 * on a test clock with hand-run animation frames.
 */
function rig({ strategy = 'direct', picture = { width: 1920, height: 1080 }, stage = { width: 390, height: 700 } } = {}) {
  const layout = { picture, stage };
  let view = initialView(layout);
  let cursor = null;
  let clock = 1_000;
  const frames = new Map();
  let nextFrame = 1;
  const actions = [];
  const views = [];
  const store = {
    layout: () => layout,
    view: () => view,
    setView: (next) => {
      view = next;
      views.push(next);
    },
    origin: () => ({ x: 10, y: 20 }),
  };
  const gestures = createTouchGestures({
    strategy,
    ...viewportGestureBindings(store, {
      get: () => cursor,
      set: (point) => {
        cursor = point;
      },
    }),
    emit: (action) => actions.push(action),
    screen: () => ({ width: 400, height: 800 }),
    now: () => clock,
    longPressMs: 1_000_000,
    requestFrame: (callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
  });
  return {
    gestures,
    actions,
    views,
    layout,
    get view() {
      return view;
    },
    set view(next) {
      view = next;
    },
    get cursor() {
      return cursor;
    },
    set cursor(next) {
      cursor = next;
    },
    advance(ms) {
      clock += ms;
    },
    /** Run animation frames, 16 ms apart, until none is pending (or `limit`). */
    runFrames(limit = 1_000) {
      let ran = 0;
      while (frames.size && ran < limit) {
        clock += 16;
        const [id, callback] = frames.entries().next().value;
        frames.delete(id);
        callback();
        ran += 1;
      }
      return ran;
    },
    pending: () => frames.size,
    of: (type) => actions.filter((action) => action.type === type),
  };
}

/** A finger drawn from (x0, y0) by (dx, dy) per 16 ms step, `steps` times. */
function swipe(r, id, x0, y0, dx, dy, steps) {
  r.gestures.down(id, x0, y0);
  for (let step = 1; step <= steps; step += 1) {
    r.advance(16);
    r.gestures.move(id, x0 + dx * step, y0 + dy * step);
  }
  r.gestures.up(id, x0 + dx * steps, y0 + dy * steps);
}

test('the gesture map: one, two and three finger taps click left, right and middle where the first finger landed', () => {
  const r = rig();
  const target = (x, y) => ({ x: (x - 10) / r.view.scale, y: (y - 20) / r.view.scale });
  r.gestures.down(1, 100, 200);
  r.gestures.up(1, 100, 200);
  r.advance(1_000);
  r.gestures.down(1, 150, 300);
  r.gestures.down(2, 250, 300);
  r.gestures.up(2, 250, 300);
  r.gestures.up(1, 150, 300);
  r.advance(1_000);
  r.gestures.down(1, 120, 400);
  r.gestures.down(2, 200, 400);
  r.gestures.down(3, 280, 400);
  r.gestures.up(1, 120, 400);
  r.gestures.up(2, 200, 400);
  r.gestures.up(3, 280, 400);
  assert.deepEqual(r.of('click'), [
    { type: 'click', button: 'left', at: target(100, 200), count: 1 },
    { type: 'click', button: 'right', at: target(150, 300), count: 1 },
    { type: 'click', button: 'middle', at: target(120, 400), count: 1 },
  ]);
  assert.deepEqual(r.views, [], 'a tap never moves the view');
});

test('a tap held past the long-press time is no click; a long-press holds the left button, drags, releases', async () => {
  const r = rig();
  const g = createTouchGestures({
    toTarget: (x, y) => ({ x, y }),
    toTargetDelta: (dx, dy) => ({ x: dx, y: dy }),
    pan: () => r.actions.push({ type: 'pan' }),
    emit: (action) => r.actions.push(action),
    longPressMs: 5,
  });
  g.down(1, 50, 60);
  await new Promise((resolve) => setTimeout(resolve, 20));
  g.move(1, 52, 61);
  g.move(1, 90, 61);
  g.up(1, 95, 70);
  assert.deepEqual(r.actions, [
    { type: 'press', at: { x: 50, y: 60 } },
    { type: 'feedback', x: 50, y: 60, radius: FEEDBACK_RADIUS_PX.direct.press },
    { type: 'drag', at: { x: 52, y: 61 } },
    { type: 'drag', at: { x: 90, y: 61 } },
    { type: 'drag', at: { x: 95, y: 70 } },
    { type: 'release', at: { x: 95, y: 70 } },
  ]);
  // Two fingers held as long: no right click.
  r.actions.length = 0;
  g.down(1, 50, 60);
  g.down(2, 150, 60);
  await new Promise((resolve) => setTimeout(resolve, 20));
  g.up(1, 50, 60);
  g.up(2, 150, 60);
  assert.deepEqual(r.actions, []);
  assert.equal(TOUCH_LONG_PRESS_MS, 500);
});

test('one finger pans the view within the picture; a fast lift-off flings on with decaying steps', () => {
  const r = rig();
  const start = r.view.x;
  swipe(r, 1, 300, 300, -12, 0, 6);
  assert.equal(r.actions.length, 0, 'nothing reaches the PC');
  assert.equal(r.view.x, start - 72, 'the picture followed the finger');
  const released = r.view.x;
  // 12 px per 16 ms: 0.75 px/ms, so it coasts about T·v0 further.
  const ran = r.runFrames();
  assert.ok(ran > 5, 'animated over frames');
  const steps = r.views.slice(-ran).map((view, i, all) => (i ? all[i - 1].x - view.x : released - view.x));
  for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i] <= steps[i - 1] + 1e-9, 'each step no larger than the last');
  const coast = released - r.view.x;
  const expected = FLING_PAN_TIME_CONSTANT_MS * (0.75 - FLING_STOP_SPEED);
  assert.ok(Math.abs(coast - expected) < 2, `coasted ${coast}, the decay predicts ${expected}`);
  // The picture's edge stops it.
  swipe(r, 1, 300, 300, -60, 0, 6);
  r.runFrames();
  assert.equal(r.view.x, viewBounds(r.layout, r.view.scale).x[0]);
  // A finger that stopped before lifting does not drift.
  const still = rig();
  still.gestures.down(1, 300, 300);
  still.advance(16);
  still.gestures.move(1, 250, 300);
  still.advance(200);
  still.gestures.up(1, 250, 300);
  assert.equal(still.pending(), 0);
  // A new touch stops a running fling.
  const caught = rig();
  swipe(caught, 1, 300, 300, -12, 0, 6);
  assert.equal(caught.pending(), 1);
  caught.gestures.down(2, 200, 200);
  assert.equal(caught.pending(), 0);
  caught.gestures.cancel(2);
});

test('two fingers swiping wheel in picture units with the fraction carried, then fling the wheel', () => {
  const r = rig();
  // Zoomed to 2 stage px per picture pixel: 3 px of finger is 1.5 picture px.
  r.view = { scale: 2, x: -1_000, y: -500 };
  const both = (y) =>
    r.gestures.contacts([
      { x: 100, y },
      { x: 200, y },
    ]);
  r.gestures.down(1, 100, 400);
  r.gestures.down(2, 200, 400);
  both(400);
  r.advance(16);
  // 12 px together: past the slop, a swipe of 6 picture px.
  both(388);
  for (let step = 1; step <= 4; step += 1) {
    r.advance(16);
    both(388 - 3 * step);
  }
  const wheels = r.of('wheel');
  assert.deepEqual(
    wheels.map((wheel) => wheel.deltaY),
    [6, 1, 2, 1, 2],
    '1.5 per step, in whole units, nothing lost'
  );
  assert.ok(wheels.every((wheel) => wheel.deltaX === 0));
  assert.deepEqual(wheels[0].at, { x: (140 + 1_000) / 2, y: (368 + 500) / 2 }, 'under the fingers');
  assert.equal(r.of('click').length, 0);
  r.gestures.up(1, 100, 376);
  r.gestures.up(2, 200, 376);
  const before = r.of('wheel').length;
  r.runFrames();
  const coasting = r.of('wheel').slice(before);
  assert.ok(coasting.length > 0, 'the scroll coasts');
  assert.ok(coasting.every((wheel) => wheel.deltaY > 0), 'on in the same direction');
});

test('a pinch zooms about the fingers and sends nothing; it never goes below the whole picture', () => {
  const r = rig();
  r.gestures.down(1, 150, 300);
  r.gestures.down(2, 250, 300);
  r.gestures.contacts([
    { x: 150, y: 300 },
    { x: 250, y: 300 },
  ]);
  const under = { x: (200 - 10 - r.view.x) / r.view.scale, y: (300 - 20 - r.view.y) / r.view.scale };
  r.gestures.move(1, 100, 300);
  r.gestures.move(2, 300, 300);
  r.gestures.contacts([
    { x: 100, y: 300 },
    { x: 300, y: 300 },
  ]);
  assert.equal(r.actions.length, 0);
  const at = pictureToStage(r.view, under);
  assert.ok(Math.abs(at.x - 190) < 1e-6 && Math.abs(at.y - 280) < 1e-6, 'the point under the fingers stayed');
  // Closing far past the minimum stops at contain.
  r.gestures.move(1, 199, 300);
  r.gestures.move(2, 201, 300);
  r.gestures.contacts([
    { x: 199, y: 300 },
    { x: 201, y: 300 },
  ]);
  assert.equal(r.view.scale, 390 / 1920);
  r.gestures.up(1, 199, 300);
  r.gestures.up(2, 201, 300);
  assert.equal(r.pending(), 0, 'no fling after a pinch');
});

test('a second tap soon and close reuses the first tap’s point; a far one does not', () => {
  const r = rig();
  r.gestures.down(1, 100, 200);
  r.gestures.up(1, 100, 200);
  r.advance(150);
  r.gestures.down(1, 100 + DOUBLE_TAP_SLOP_PX - 1, 200);
  r.gestures.up(1, 100 + DOUBLE_TAP_SLOP_PX - 1, 200);
  const [one, two] = r.of('click');
  assert.deepEqual(two.at, one.at);
  assert.equal(two.count, 2);
  r.advance(1_000);
  r.gestures.down(1, 100, 200);
  r.gestures.up(1, 100, 200);
  r.advance(150);
  r.gestures.down(1, 100 + DOUBLE_TAP_SLOP_PX + 1, 200);
  r.gestures.up(1, 100 + DOUBLE_TAP_SLOP_PX + 1, 200);
  const [, , three, four] = r.of('click');
  assert.notDeepEqual(four.at, three.at);
  assert.equal(four.count, 1);
});

test('a touch from the edge band taps as anywhere; moving inward it is the system’s swipe, ignored', async () => {
  const r = rig();
  const edge = EDGE_SLOP_PX - 7;
  // The stage starts at client x 10, so the right edge's band is on the picture.
  const right = 400 - edge;
  // Held still: a tap, delivered.
  r.gestures.down(1, right, 300);
  r.gestures.up(1, right, 300);
  assert.deepEqual(
    r.of('click').map((click) => click.button),
    ['left']
  );
  // Inside the slop it is still a tap.
  r.advance(1_000);
  r.gestures.down(1, right, 300);
  r.gestures.move(1, right - 5, 302);
  r.gestures.up(1, right - 5, 302);
  assert.equal(r.of('click').length, 2);
  // Swipes from the left, right and bottom edges: nothing sent, the view still, no fling.
  r.actions.length = 0;
  swipe(r, 2, edge, 300, 20, 0, 6);
  swipe(r, 3, 400 - edge, 300, -20, 0, 6);
  swipe(r, 4, 200, 800 - edge, 0, -20, 6);
  r.gestures.down(5, edge, 300);
  r.gestures.down(6, edge + 100, 300);
  for (let step = 1; step <= 4; step += 1) {
    r.advance(16);
    r.gestures.move(5, edge + step * 15, 300);
    r.gestures.move(6, edge + 100 + step * 15, 300);
  }
  r.gestures.up(5, edge + 60, 300);
  r.gestures.up(6, edge + 160, 300);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.views, []);
  assert.equal(r.pending(), 0);
  // A long-press there still holds the button.
  const actions = [];
  const g = createTouchGestures({
    toTarget: (x, y) => ({ x, y }),
    toTargetDelta: (dx, dy) => ({ x: dx, y: dy }),
    pan: () => actions.push('pan'),
    emit: (action) => actions.push(action.type),
    screen: () => ({ width: 400, height: 800 }),
    longPressMs: 5,
  });
  g.down(1, edge, 300);
  await new Promise((resolve) => setTimeout(resolve, 20));
  g.move(1, edge + 40, 300);
  g.up(1, edge + 40, 300);
  assert.deepEqual(actions, ['press', 'feedback', 'drag', 'release']);
});

test('the feedback ring shows only for input that was sent, sized per action and strategy', () => {
  const r = rig({ picture: { width: 100, height: 100 }, stage: { width: 390, height: 700 } });
  // The fitted square leaves bands above and below it on the stage.
  r.view = { scale: 3.9, x: 0, y: 155 };
  r.gestures.down(1, 200, 100);
  r.gestures.up(1, 200, 100);
  assert.deepEqual(r.actions, [], 'off the picture: nothing sent, no ring');
  r.gestures.down(1, 200, 400);
  r.gestures.up(1, 200, 400);
  assert.deepEqual(r.of('feedback'), [{ type: 'feedback', x: 200, y: 400, radius: FEEDBACK_RADIUS_PX.direct.tap }]);
  const pad = rig({ strategy: 'trackpad' });
  pad.gestures.down(1, 200, 400);
  pad.gestures.up(1, 200, 400);
  assert.equal(pad.of('click').length, 1);
  assert.deepEqual(pad.of('feedback'), [], 'a trackpad tap has no ring');
});

test('trackpad: the cursor moves by the finger’s travel, the view follows it, clicks and pinches go to it', () => {
  const r = rig({ strategy: 'trackpad' });
  // The PC's cursor, as the caller learned it.
  r.cursor = { x: 960, y: 540 };
  const scale = r.view.scale;
  swipe(r, 1, 100, 300, 13, 0, 4);
  const moves = r.of('move');
  assert.ok(moves.length >= 4);
  const at = moves.at(-1).at;
  assert.ok(Math.abs(at.x - (960 + 52 / scale)) < 1e-6, 'moved by the travel in picture units');
  assert.equal(at.y, 540);
  const onStage = pictureToStage(r.view, at);
  assert.ok(Math.abs(onStage.x - 195) < 1e-6, 'the view keeps the cursor centred');
  // A tap clicks at the cursor, not under the finger.
  r.runFrames();
  r.actions.length = 0;
  r.gestures.down(2, 50, 50);
  r.gestures.up(2, 50, 50);
  assert.deepEqual(r.of('click').map((click) => click.at), [r.cursor]);
  // A pinch pivots on the cursor: it stays put on the stage.
  const before = pictureToStage(r.view, r.cursor);
  r.gestures.down(1, 100, 300);
  r.gestures.down(2, 200, 300);
  r.gestures.contacts([
    { x: 100, y: 300 },
    { x: 200, y: 300 },
  ]);
  r.gestures.contacts([
    { x: 50, y: 300 },
    { x: 250, y: 300 },
  ]);
  assert.ok(r.view.scale > scale * 1.5, 'zoomed in');
  const after = pictureToStage(r.view, r.cursor);
  assert.ok(Math.abs(after.x - before.x) < 1e-6 && Math.abs(after.y - before.y) < 1e-6);
  // The cursor stays on the picture.
  r.gestures.up(1, 50, 300);
  r.gestures.up(2, 250, 300);
  r.runFrames();
  swipe(r, 3, 100, 300, -300, 0, 20);
  r.runFrames();
  assert.equal(r.cursor.x, 0);
});

test('no fling after a long-press drag', async () => {
  const actions = [];
  const frames = [];
  let clock = 0;
  const g = createTouchGestures({
    toTarget: (x, y) => ({ x, y }),
    toTargetDelta: (dx, dy) => ({ x: dx, y: dy }),
    pan: () => actions.push('pan'),
    emit: (action) => actions.push(action.type),
    longPressMs: 5,
    now: () => clock,
    requestFrame: (callback) => frames.push(callback),
  });
  g.down(1, 100, 100);
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let step = 1; step <= 6; step += 1) {
    clock += 16;
    g.move(1, 100 + step * 20, 100);
  }
  g.up(1, 220, 100);
  assert.equal(frames.length, 0);
  assert.equal(actions.at(-1), 'release');
  assert.ok(!actions.includes('pan'));
});

test('fling math: exponential decay from the lift-off velocity, none when too slow', () => {
  const samples = [
    { t: 0, x: 0, y: 0 },
    { t: 40, x: 20, y: 0 },
    { t: 80, x: 40, y: 0 },
  ];
  assert.deepEqual(flingVelocity(samples, 80), { x: 0.5, y: 0 });
  assert.deepEqual(flingVelocity(samples, 300), { x: 0, y: 0 }, 'the finger had stopped');
  const fling = startFling({ x: 0.5, y: 0 }, 100);
  assert.ok(Math.abs(fling.duration - 100 * Math.log(0.5 / FLING_STOP_SPEED)) < 1e-9);
  assert.ok(Math.abs(flingTravel(fling, 100).x - 50 * (1 - Math.exp(-1))) < 1e-9);
  assert.ok(Math.abs(flingTravel(fling, 1e9).x - 100 * (0.5 - FLING_STOP_SPEED)) < 1e-9, 'capped at its end');
  assert.equal(startFling({ x: 0.1, y: 0 }, 100), null, 'would travel under the minimum');
  assert.equal(startFling({ x: 0, y: 0 }, 100), null);
});
