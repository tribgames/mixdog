import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRemoteScreenInput } from '../shared/remote-webrtc.ts';
import { createScreenGestureAdapter } from './remote-screen-gesture.ts';
import { createScreenCursorTracker } from './remote-screen-state.ts';
import { createScreenCursorStore, screenGestureFromTouch } from './remote-screen-touch.ts';
import { nextScreenViewport, screenViewportLayout } from './remote-screen-viewport.ts';
import { createTouchGestures, viewportGestureBindings } from './remote-touch-gestures.ts';
import { containScale } from './remote-viewport.ts';

const SIZE = { width: 1920, height: 1080 };
const at = { x: 100, y: 50 };
const pointer = (action, x, y, button) => ({
  type: 'screen-pointer',
  action,
  ...(button ? { button } : {}),
  x,
  y,
});
const messages = (...touchActions) => {
  const adapter = createScreenGestureAdapter({ size: () => SIZE });
  return touchActions.flatMap((touch) => {
    const action = screenGestureFromTouch(touch);
    return action ? adapter.screenInputFromGesture(action) : [];
  });
};

test('every touch action maps to the right screen messages', () => {
  assert.deepEqual(messages({ type: 'click', button: 'left', at, count: 1 }), [
    pointer('move', 100, 50),
    pointer('down', 100, 50, 'left'),
    pointer('up', 100, 50, 'left'),
  ]);
  assert.deepEqual(
    messages({ type: 'click', button: 'right', at, count: 1 }).map((m) => m.button ?? m.action),
    ['move', 'right', 'right']
  );
  assert.deepEqual(
    messages({ type: 'click', button: 'middle', at, count: 1 }).at(-1),
    pointer('up', 100, 50, 'middle')
  );
  // The second click of a double-click is one more press and lift at the point.
  assert.deepEqual(
    messages({ type: 'click', button: 'left', at, count: 1 }, { type: 'click', button: 'left', at, count: 2 }).map(
      (m) => m.action
    ),
    ['move', 'down', 'up', 'move', 'down', 'up']
  );
  // press / drag / release hold the left button across moves.
  assert.deepEqual(
    messages(
      { type: 'press', at },
      { type: 'drag', at: { x: 120, y: 60 } },
      { type: 'release', at: { x: 130, y: 70 } }
    ),
    [
      pointer('move', 100, 50),
      pointer('down', 100, 50, 'left'),
      pointer('move', 120, 60),
      pointer('move', 130, 70),
      pointer('up', 130, 70, 'left'),
    ]
  );
  assert.deepEqual(messages({ type: 'move', at }), [pointer('move', 100, 50)]);
  assert.deepEqual(messages({ type: 'wheel', at, deltaX: -50, deltaY: 100 }), [
    { type: 'screen-wheel', x: 100, y: 50, deltaX: -60, deltaY: 120 },
  ]);
  // A feedback ring is drawn, never sent.
  assert.equal(screenGestureFromTouch({ type: 'feedback', x: 1, y: 2, radius: 25 }), null);
  assert.deepEqual(messages({ type: 'feedback', x: 1, y: 2, radius: 25 }), []);
  for (const input of messages(
    { type: 'click', button: 'left', at, count: 1 },
    { type: 'wheel', at, deltaX: 0, deltaY: 120 }
  )) {
    assert.deepEqual(parseRemoteScreenInput(input), input);
  }
});

test('points off the picture are kept on it', () => {
  assert.deepEqual(messages({ type: 'move', at: { x: -5, y: 99999 } }), [pointer('move', 0, 1080)]);
});

test('the trackpad cursor takes the PC report in at a touch start, not mid-drag', () => {
  let pc = { x: 400, y: 300 };
  const store = createScreenCursorStore(() => pc);
  assert.deepEqual(store.get(), { x: 400, y: 300 });
  store.set({ x: 10, y: 20 });
  // The report lags what was sent: the phone's own cursor stays until a touch starts.
  pc = { x: 5, y: 5 };
  assert.deepEqual(store.get(), { x: 10, y: 20 });
  store.sync();
  assert.deepEqual(store.get(), { x: 5, y: 5 });
  pc = null;
  store.sync();
  assert.deepEqual(store.get(), { x: 5, y: 5 });
});

test('the own trackpad cursor is dropped with the PC cursor on a new geometry or a secure desktop', () => {
  let generation = 1;
  const tracker = createScreenCursorTracker(() => generation);
  const store = createScreenCursorStore(tracker.read, tracker.stamp);
  tracker.set({ x: 100, y: 100 });
  store.set({ x: 800, y: 400 });
  assert.deepEqual(store.get(), { x: 800, y: 400 }, 'kept within the same geometry');
  generation = 2;
  assert.equal(store.get(), null, 'a new geometry: old video pixels are meaningless');
  tracker.set({ x: 5, y: 6 });
  store.set({ x: 800, y: 400 });
  tracker.status({ state: 'secure-desktop', reason: 'uac', helper: 'running', control: false });
  assert.equal(store.get(), null, 'secure desktop');
  tracker.status({ state: 'live', helper: 'running', control: true });
  tracker.set({ x: 7, y: 8 });
  store.set({ x: 800, y: 400 });
  tracker.status({ state: 'stopped', reason: 'display-removed', helper: 'running', control: false });
  assert.equal(store.get(), null, 'stopped');
  store.set({ x: 1, y: 2 });
  tracker.clear();
  assert.equal(store.get(), null, 'a new session');
  // A touch start after the reset takes the PC report in again.
  tracker.set({ x: 9, y: 9 });
  store.sync();
  assert.deepEqual(store.get(), { x: 9, y: 9 });
});

test('the first view is the whole screen, centred on the short axis', () => {
  const phone = { width: 390, height: 700 };
  const state = nextScreenViewport(null, phone, false, SIZE);
  const layout = screenViewportLayout(state);
  assert.equal(state.view.scale, containScale(layout));
  assert.equal(state.view.scale, 390 / 1920);
  assert.equal(state.view.x, 0);
  assert.equal(state.view.y, (700 - 1080 * state.view.scale) / 2);
  // Nothing is shown until both sizes are known.
  assert.equal(nextScreenViewport(null, { width: 0, height: 0 }, false, SIZE).view, null);
});

test('the soft keyboard is an inset: the view does not move or rescale', () => {
  const phone = { width: 390, height: 700 };
  const first = nextScreenViewport(null, phone, false, SIZE);
  const open = nextScreenViewport(first, { width: 390, height: 400 }, true, SIZE);
  assert.deepEqual(open.view, first.view);
  assert.equal(open.track.height, 700);
  assert.equal(open.track.bottom, 300);
  assert.deepEqual(screenViewportLayout(open).insets, { bottom: 300 });
  const closed = nextScreenViewport(open, phone, false, SIZE);
  assert.deepEqual(closed.view, first.view);
  assert.equal(closed.track.bottom, 0);
});

test('a picture of another size keeps its spot at the same shape and starts again at another', () => {
  const phone = { width: 390, height: 700 };
  const first = nextScreenViewport(null, phone, false, SIZE);
  const half = nextScreenViewport(first, phone, false, { width: 960, height: 540 });
  assert.ok(Math.abs(half.view.scale - first.view.scale * 2) < 1e-9);
  const portrait = nextScreenViewport(first, phone, false, { width: 1080, height: 1920 });
  assert.equal(portrait.view.scale, containScale(screenViewportLayout(portrait)));
});

// The real gestures over a real viewport store, ending in screen messages.
function rig(strategy) {
  const sent = [];
  const adapter = createScreenGestureAdapter({ size: () => SIZE });
  let state = nextScreenViewport(null, { width: 390, height: 700 }, false, SIZE);
  const store = {
    layout: () => screenViewportLayout(state),
    view: () => state.view,
    setView: (view) => {
      state = { ...state, view };
    },
    origin: () => ({ x: 0, y: 0 }),
  };
  const cursor = createScreenCursorStore(() => null);
  const gestures = createTouchGestures({
    ...viewportGestureBindings(store, strategy === 'trackpad' ? cursor : undefined),
    strategy,
    emit(action) {
      const next = screenGestureFromTouch(action);
      if (next) sent.push(...adapter.screenInputFromGesture(next));
    },
    now: () => 0,
    requestFrame: () => 1,
    cancelFrame() {},
  });
  return { gestures, sent, store };
}

test('direct: a tap lands under the finger at the zoom the view has', () => {
  const { gestures, sent, store } = rig('direct');
  gestures.down(1, 200, 300);
  gestures.up(1, 200, 300);
  const scale = store.view().scale;
  const x = (200 - store.view().x) / scale;
  const y = (300 - store.view().y) / scale;
  assert.deepEqual(sent, [pointer('move', x, y), pointer('down', x, y, 'left'), pointer('up', x, y, 'left')]);
});

test('trackpad: a tap clicks at the cursor, wherever the finger is', () => {
  const { gestures, sent } = rig('trackpad');
  gestures.down(1, 50, 400);
  gestures.up(1, 50, 400);
  // No cursor reported yet: the centre of what is visible.
  const click = sent.filter((input) => input.action === 'down');
  assert.equal(click.length, 1);
  assert.notDeepEqual({ x: click[0].x, y: click[0].y }, { x: 50, y: 400 });
});
