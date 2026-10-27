import assert from 'node:assert/strict';
import test from 'node:test';

import { remoteBrowserImagePoint } from '../shared/remote-browser.ts';
import { createCompositionFinisher } from './remote-composition.ts';
import { createRemoteTouchController, TOUCH_SLOP_PX } from './remote-browser-touch.ts';
import { remotePinchMaxZoom, remoteVideoInputFrame, zoomRemoteView } from './remote-view-zoom.ts';

const geometry = {
  generation: 4,
  cssWidth: 640,
  cssHeight: 360,
  deviceScaleFactor: 2,
  pixelWidth: 1280,
  pixelHeight: 720,
};
/** Client point → page CSS pixel through the (transformed) picture box. */
const pagePoint = (bounds, frame, x, y) => {
  const pixel = remoteBrowserImagePoint(bounds, frame, { x, y });
  return (
    pixel && { x: (pixel.x * frame.viewportWidth) / frame.width, y: (pixel.y * frame.viewportHeight) / frame.height }
  );
};

test('video input maps through the acknowledged geometry, and only at its locked pixel size', () => {
  const frame = remoteVideoInputFrame('p1:0', geometry, { width: 1280, height: 720 });
  assert.deepEqual(frame, { documentId: 'p1:0', width: 1280, height: 720, viewportWidth: 640, viewportHeight: 360 });
  const fitted = { left: 0, top: 0, width: 640, height: 360 };
  assert.deepEqual(pagePoint(fitted, frame, 160, 90), { x: 160, y: 90 });
  // A frame of another size (a resize not yet decoded) refuses input.
  const stale = remoteVideoInputFrame('p1:0', geometry, { width: 640, height: 360 });
  assert.equal(pagePoint(fitted, stale, 160, 90), null);
  assert.equal(pagePoint(fitted, remoteVideoInputFrame('p1:0', null, null), 160, 90), null);
});

test('pinch zoom keeps the page point under the fingers, and input maps exactly when zoomed', () => {
  const frame = remoteVideoInputFrame('p1:0', geometry, { width: 1280, height: 720 });
  const view = zoomRemoteView(
    { zoom: 1, pan: { x: 0, y: 0 } },
    {
      scale: 2,
      at: { x: 160, y: 90 },
      shift: { x: 0, y: 0 },
      center: { x: 320, y: 180 },
      size: { width: 640, height: 360 },
      max: 4,
    }
  );
  assert.deepEqual(view, { zoom: 2, pan: { x: 160, y: 90 } });
  // translate(pan) scale(zoom) about the centre: the box the browser reports.
  const width = 640 * view.zoom;
  const height = 360 * view.zoom;
  const zoomed = { left: 320 + view.pan.x - width / 2, top: 180 + view.pan.y - height / 2, width, height };
  assert.deepEqual(pagePoint(zoomed, frame, 160, 90), { x: 160, y: 90 }, 'the pinched point stays put');
  assert.deepEqual(pagePoint(zoomed, frame, 320, 180), { x: 240, y: 135 });

  // The fingers moving pan the picture, never past its edges.
  const panned = zoomRemoteView(view, {
    scale: 1,
    at: { x: 160, y: 90 },
    shift: { x: 1_000, y: -1_000 },
    center: { x: 320, y: 180 },
    size: { width: 640, height: 360 },
    max: 4,
  });
  assert.deepEqual(panned.pan, { x: 320, y: -180 });
  // Zoom stops at the ceiling.
  const capped = zoomRemoteView(view, {
    scale: 10,
    at: { x: 320, y: 180 },
    shift: { x: 0, y: 0 },
    center: { x: 320, y: 180 },
    size: { width: 640, height: 360 },
    max: 4,
  });
  assert.equal(capped.zoom, 4);
});

test('the pinch ceiling reaches one decoded pixel per device pixel, never below the menu maximum', () => {
  // A 2560-pixel page fitted into 390 CSS px at DPR 1: 390 device px shown.
  assert.equal(remotePinchMaxZoom({ width: 390, height: 700 }, { width: 2560, height: 1440 }, 1), 2560 / 390);
  // 1280 pixels into 780 device px (DPR 2) runs out before the menu's 2×.
  assert.equal(remotePinchMaxZoom({ width: 390, height: 700 }, { width: 1280, height: 720 }, 2), 2);
  assert.equal(remotePinchMaxZoom({ width: 390, height: 700 }, { width: 390, height: 219 }, 3), 2);
  assert.equal(remotePinchMaxZoom({ width: 390, height: 700 }, null, 3), 2);
});

function controller(overrides = {}) {
  const sent = [];
  const pinches = [];
  const calls = [];
  let zoom = 1;
  let clock = 0;
  const touch = createRemoteTouchController({
    page: (x, y) => ({ x, y }),
    pageDelta: (dx, dy) => ({ x: dx, y: dy }),
    send: (action) => sent.push(action),
    panning: () => zoom > 1,
    pan: () => calls.push('pan'),
    pinch: (scale, x, y, dx, dy) => pinches.push({ scale, x, y, dx, dy }),
    fitted: () => zoom === 1,
    fit: () => {
      calls.push('fit');
      zoom = 1;
    },
    press: () => calls.push('press'),
    now: () => clock,
    longPressMs: 1_000_000,
    ...overrides,
  });
  return {
    touch,
    sent,
    pinches,
    calls,
    setZoom: (value) => {
      zoom = value;
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('two fingers moving together sideways scroll, decided from both fingers’ new positions', () => {
  for (const pinch of [true, false]) {
    // `pinch: undefined`: a host without local zoom, two fingers always scroll.
    const c = controller(pinch ? {} : { pinch: undefined });
    c.touch.down(1, 100, 100);
    c.touch.down(2, 200, 100);
    touchStart(c, [100, 100], [200, 100]);
    // One finger's report alone (spread +20, centroid +10) decides nothing.
    c.touch.move(1, 120, 100);
    assert.equal(c.pinches.length + c.sent.length, 0, 'undecided');
    frame(c, [2, 220, 100], null, [
      { x: 120, y: 100 },
      { x: 220, y: 100 },
    ]);
    c.touch.up(1, 120, 100);
    c.touch.up(2, 220, 100);
    assert.equal(c.pinches.length, 0, 'no zoom');
    const wheels = c.sent.filter((action) => action.type === 'wheel');
    assert.ok(wheels.length >= 1);
    assert.equal(
      wheels.reduce((sum, wheel) => sum + wheel.deltaX, 0),
      -20
    );
  }
});

test('delayed reports: A reports 120 then 130, B’s report comes late — both moved +30, so a scroll, never a zoom', () => {
  const c = controller();
  c.touch.down(1, 100, 100);
  c.touch.down(2, 200, 100);
  touchStart(c, [100, 100], [200, 100]);
  // Pointer reports alone, however far one finger goes, decide nothing.
  c.touch.move(1, 120, 100);
  c.touch.move(1, 130, 100);
  assert.equal(c.pinches.length + c.sent.length, 0, 'undecided on partial reports');
  // The touch list of the frame carries both fingers where they really are.
  c.touch.contacts([
    { x: 130, y: 100 },
    { x: 230, y: 100 },
  ]);
  c.touch.move(2, 230, 100);
  assert.equal(c.pinches.length, 0, 'no zoom');
  const wheels = c.sent.filter((action) => action.type === 'wheel');
  assert.ok(wheels.length >= 1);
  assert.equal(
    wheels.reduce((sum, wheel) => sum + wheel.deltaX, 0),
    -30
  );
  // Later frames keep scrolling from snapshots.
  frame(c, [1, 140, 100], [2, 240, 100]);
  assert.equal(
    c.sent.filter((action) => action.type === 'wheel').reduce((sum, wheel) => sum + wheel.deltaX, 0),
    -40
  );
  assert.equal(c.pinches.length, 0);
});

test('a pinch with one finger held still is decided from the snapshot that shows it still', () => {
  const c = controller();
  c.touch.down(1, 100, 100);
  c.touch.down(2, 200, 100);
  touchStart(c, [100, 100], [200, 100]);
  // Finger 1 is held: its position comes only with the touch list.
  frame(c, [2, 300, 100], null, [
    { x: 100, y: 100 },
    { x: 300, y: 100 },
  ]);
  assert.equal(c.pinches.length, 1);
  assert.equal(c.pinches[0].scale, 2);
  assert.equal(c.sent.length, 0);
  // Within the slop nothing is decided yet.
  const s = controller();
  s.touch.down(1, 100, 100);
  s.touch.down(2, 200, 100);
  touchStart(s, [100, 100], [200, 100]);
  frame(s, [2, 200 + TOUCH_SLOP_PX, 100], null, [
    { x: 100, y: 100 },
    { x: 200 + TOUCH_SLOP_PX, y: 100 },
  ]);
  assert.equal(s.pinches.length + s.sent.length, 0);
});

test('a touch list of another set of contacts than the pointers down is ignored', () => {
  const c = controller();
  c.touch.down(1, 100, 100);
  c.touch.down(2, 200, 100);
  touchStart(c, [100, 100], [200, 100]);
  c.touch.contacts([{ x: 300, y: 100 }]);
  c.touch.contacts([
    { x: 0, y: 100 },
    { x: 300, y: 100 },
    { x: 400, y: 100 },
  ]);
  assert.equal(c.pinches.length + c.sent.length, 0);
});

test('a moving pinch keeps the page point that was under the fingers under them', () => {
  const size = { width: 640, height: 360 };
  const center = { x: 320, y: 180 };
  let view = { zoom: 1, pan: { x: 0, y: 0 } };
  const c = controller({
    pinch: (scale, x, y, dx, dy) => {
      view = zoomRemoteView(view, { scale, at: { x, y }, shift: { x: dx, y: dy }, center, size, max: 4 });
    },
  });
  // Picture point (150, 100) is under the fingers' centre.
  c.touch.down(1, 100, 100);
  c.touch.down(2, 200, 100);
  touchStart(c, [100, 100], [200, 100]);
  // Spread 100 → 150 (1.5×) while the centre moves 150 → 125.
  frame(c, [1, 50, 100], null, [
    { x: 50, y: 100 },
    { x: 200, y: 100 },
  ]);
  assert.equal(view.zoom, 1.5);
  const left = center.x + view.pan.x - (size.width * view.zoom) / 2;
  const top = center.y + view.pan.y - (size.height * view.zoom) / 2;
  assert.deepEqual({ x: (125 - left) / view.zoom, y: (100 - top) / view.zoom }, { x: 150, y: 100 });
});

/** The touchstart's touch list (every contact, [x, y]): this gesture's touch lists arrive. */
function touchStart(c, ...points) {
  c.touch.contacts(points.map(([x, y]) => ({ x, y })));
}

test('without touch lists, two fingers moving together scroll by pointer reports alone and never zoom', () => {
  for (const pinch of [true, false]) {
    const c = controller(pinch ? {} : { pinch: undefined });
    c.touch.down(1, 100, 100);
    c.touch.down(2, 200, 100);
    for (let step = 1; step <= 6; step += 1) {
      c.touch.move(1, 100 + step * 10, 100);
      c.touch.move(2, 200 + step * 10, 100);
    }
    c.touch.up(1, 160, 100);
    c.touch.up(2, 260, 100);
    assert.equal(c.pinches.length, 0, 'no zoom from partial reports');
    const wheels = c.sent.filter((action) => action.type === 'wheel');
    assert.equal(
      wheels.reduce((sum, wheel) => sum + wheel.deltaX, 0),
      -60
    );
    assert.equal(c.sent.filter((action) => action.type === 'pointer').length, 0);
  }
  // A spread without touch lists is no zoom either.
  const s = controller();
  s.touch.down(1, 100, 100);
  s.touch.down(2, 200, 100);
  s.touch.move(1, 50, 100);
  s.touch.move(2, 250, 100);
  assert.equal(s.pinches.length, 0);
});

test('with both pointer reports and touch lists, each motion is dispatched once', () => {
  const c = controller();
  c.touch.down(1, 100, 100);
  c.touch.down(2, 200, 100);
  touchStart(c, [100, 100], [200, 100]);
  for (let step = 1; step <= 6; step += 1) frame(c, [1, 100 + step * 10, 100], [2, 200 + step * 10, 100]);
  const wheels = c.sent.filter((action) => action.type === 'wheel');
  assert.equal(
    wheels.reduce((sum, wheel) => sum + wheel.deltaX, 0),
    -60
  );
  assert.ok(
    wheels.every((wheel) => wheel.deltaX !== 0),
    'no empty wheel'
  );
  assert.equal(c.pinches.length, 0);

  // A gesture whose touch list came only after pointer reports had scrolled
  // continues from the same centre: nothing twice.
  const late = controller({ pinch: undefined });
  late.touch.down(1, 100, 100);
  late.touch.down(2, 200, 100);
  late.touch.move(1, 120, 100);
  late.touch.move(2, 220, 100);
  late.touch.contacts([
    { x: 120, y: 100 },
    { x: 220, y: 100 },
  ]);
  late.touch.move(1, 140, 100);
  late.touch.move(2, 240, 100);
  late.touch.contacts([
    { x: 140, y: 100 },
    { x: 240, y: 100 },
  ]);
  assert.equal(
    late.sent.filter((action) => action.type === 'wheel').reduce((sum, wheel) => sum + wheel.deltaX, 0),
    -40
  );
});

test('touch lists that stop after touchstart hand the gesture to pointer reports: scroll, no zoom, nothing twice', () => {
  for (const pinch of [true, false]) {
    const c = controller(pinch ? {} : { pinch: undefined });
    c.touch.down(1, 100, 100);
    c.touch.down(2, 200, 100);
    touchStart(c, [100, 100], [200, 100]);
    for (let step = 1; step <= 6; step += 1) {
      c.touch.move(1, 100 + step * 10, 100);
      c.touch.move(2, 200 + step * 10, 100);
    }
    assert.equal(c.pinches.length, 0, 'no zoom on the fallback');
    const total = () =>
      c.sent.filter((action) => action.type === 'wheel').reduce((sum, wheel) => sum + wheel.deltaX, 0);
    assert.equal(total(), -60);
    // A touch list arriving again continues from the same centre: nothing replayed.
    frame(c, [1, 170, 100], [2, 270, 100]);
    assert.equal(total(), -70);
    assert.equal(c.sent.filter((action) => action.type === 'pointer').length, 0);
  }
  // A spread on the fallback never zooms.
  const s = controller();
  s.touch.down(1, 100, 100);
  s.touch.down(2, 200, 100);
  touchStart(s, [100, 100], [200, 100]);
  for (let step = 1; step <= 4; step += 1) {
    s.touch.move(1, 100 - step * 20, 100);
    s.touch.move(2, 200 + step * 20, 100);
  }
  assert.equal(s.pinches.length, 0);
});

/** One input frame: the pointer reports `a` and `b` ([id, x, y]; null: none),
 *  then the touch list with every contact (by default the two reported). */
function frame(c, a, b, snapshot) {
  for (const move of [a, b]) if (move) c.touch.move(...move);
  c.touch.contacts(
    snapshot ??
      [a, b]
        .filter(Boolean)
        .sort((p, q) => p[0] - q[0])
        .map(([, x, y]) => ({ x, y }))
  );
}

test('two fingers spreading pinch-zoom locally; moving together they scroll the page', () => {
  const c = controller();
  c.touch.down(1, 100, 100);
  c.touch.down(2, 200, 100);
  touchStart(c, [100, 100], [200, 100]);
  frame(c, [1, 50, 100], [2, 250, 100]);
  frame(c, [2, 350, 100], null, [
    { x: 50, y: 100 },
    { x: 350, y: 100 },
  ]);
  c.touch.up(1, 50, 100);
  c.touch.up(2, 350, 100);
  assert.equal(c.sent.length, 0, 'a pinch sends nothing to the page');
  assert.ok(c.pinches.length >= 1);
  assert.ok(c.pinches.every((pinch) => pinch.scale >= 1));
  assert.ok(Math.abs(c.pinches.reduce((product, pinch) => product * pinch.scale, 1) - 3) < 1e-9, '100 → 300 px apart');

  const s = controller();
  s.touch.down(1, 50, 50);
  s.touch.down(2, 150, 50);
  touchStart(s, [50, 50], [150, 50]);
  frame(s, [1, 50, 30], [2, 150, 30]);
  s.touch.up(1, 50, 30);
  s.touch.up(2, 150, 30);
  assert.equal(s.pinches.length, 0);
  const wheels = s.sent.filter((action) => action.type === 'wheel');
  assert.equal(
    wheels.reduce((sum, wheel) => sum + wheel.deltaY, 0),
    20,
    'scrolled from where the fingers began'
  );
});

test('a double tap on a zoomed picture fits it without a second click; fitted, both taps click', () => {
  const c = controller();
  c.setZoom(2);
  c.touch.down(1, 10, 10);
  c.touch.up(1, 10, 10);
  c.advance(200);
  c.touch.down(2, 30, 20);
  c.touch.up(2, 30, 20);
  assert.deepEqual(c.calls, ['press', 'fit']);
  assert.equal(c.sent.filter((action) => action.phase === 'mousePressed').length, 1, 'the first tap was not delayed');

  const f = controller();
  f.touch.down(1, 10, 10);
  f.touch.up(1, 10, 10);
  f.advance(100);
  f.touch.down(2, 10, 10);
  f.touch.up(2, 10, 10);
  assert.equal(f.sent.filter((action) => action.phase === 'mousePressed').length, 2);
  assert.ok(!f.calls.includes('fit'));

  // Too slow or too far apart: two taps.
  const slow = controller();
  slow.setZoom(2);
  slow.touch.down(1, 10, 10);
  slow.touch.up(1, 10, 10);
  slow.advance(301);
  slow.touch.down(2, 10, 10);
  slow.touch.up(2, 10, 10);
  assert.ok(!slow.calls.includes('fit'));
});

test('every press that reaches the page is announced before its first event', () => {
  const order = [];
  const c = controller({
    press: () => order.push('press'),
    send: (action) => order.push(action.phase),
    longPressMs: 5,
  });
  c.touch.down(1, 10, 10);
  c.touch.up(1, 10, 10);
  assert.deepEqual(order, ['press', 'mouseMoved', 'mousePressed', 'mouseReleased']);
  order.length = 0;
  c.touch.down(2, 10, 10);
  c.touch.move(2, 60, 10);
  c.touch.up(2, 60, 10);
  assert.deepEqual(order.slice(0, 3), ['press', 'mouseMoved', 'mousePressed']);
});

/** The textarea and the page input hook's composition end, recorded. */
function composition() {
  const field = { value: '', blurred: 0, focused: 0 };
  field.blur = () => {
    field.blurred += 1;
    globalThis.document.activeElement = null;
  };
  field.focus = () => {
    field.focused += 1;
    globalThis.document.activeElement = field;
  };
  globalThis.document = { activeElement: field };
  const fired = [];
  const base = {
    onKeyDown: () => fired.push('key'),
    onInput: (event) => fired.push(`text:${event.currentTarget.value}`),
    onCompositionStart: () => fired.push('start'),
    onCompositionUpdate: (event) => fired.push(`update:${event.data}`),
    onCompositionEnd: (event) => fired.push(`end:${event.data}`),
  };
  const finisher = createCompositionFinisher(() => field);
  const handlers = finisher.wrap(base);
  const event = (data, value = data) => {
    field.value = value;
    return { data, currentTarget: field, nativeEvent: { keyCode: 229 } };
  };
  return { field, fired, handlers, finish: () => finisher.finish(base), event };
}

test('a press mid-composition commits the syllable to its own field first and swallows the IME’s late commit', () => {
  const c = composition();
  c.handlers.onCompositionStart(c.event(''));
  c.handlers.onCompositionUpdate(c.event('ㅎ'));
  c.handlers.onCompositionUpdate(c.event('하'));
  // The tap on another field: before its click goes out.
  c.finish();
  assert.deepEqual(c.fired, ['start', 'update:ㅎ', 'update:하', 'end:하']);
  assert.equal(c.field.blurred, 1, 'the IME composition is ended too');
  assert.equal(c.field.focused, 1, 'and the keyboard kept');
  // The IME's own commit of the same syllable (focus left the textarea).
  c.handlers.onInput(c.event('하'));
  c.handlers.onCompositionEnd(c.event('하'));
  assert.deepEqual(c.fired, ['start', 'update:ㅎ', 'update:하', 'end:하'], 'never sent into the next field');
  assert.equal(c.field.value, '');
  // Typing goes on normally after it.
  c.handlers.onCompositionStart(c.event(''));
  c.handlers.onCompositionUpdate(c.event('ㄱ'));
  c.handlers.onCompositionEnd(c.event('가'));
  assert.deepEqual(c.fired.slice(-3), ['start', 'update:ㄱ', 'end:가']);
});

test('an empty composition is closed with nothing, and no composition means no commit', () => {
  const c = composition();
  c.finish();
  assert.deepEqual(c.fired, []);
  assert.equal(c.field.blurred, 0);
  c.handlers.onCompositionStart(c.event(''));
  c.handlers.onCompositionUpdate(c.event('ㅎ'));
  c.handlers.onCompositionUpdate(c.event(''));
  c.finish();
  assert.deepEqual(c.fired.slice(-1), ['end:'], 'the page composition is cancelled');
});
