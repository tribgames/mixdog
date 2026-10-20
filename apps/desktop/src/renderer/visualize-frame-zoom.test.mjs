import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  FRAME_ZOOM_REQUEST,
  frameZoomBridgeScript,
  serveFrameZoom,
  withFrameZoomBridge,
} from './visualize-frame-zoom.ts';
import { registerZoomTarget } from './zoom-target.ts';

// A real parent document with a real iframe window: the bridge script runs in
// the frame, its gestures are real DOM events dispatched on the frame's
// window, and what it posts is delivered to the parent as a message from it.
function remotePage(beforeBridge) {
  const dom = new JSDOM('<!doctype html><body><div id="panel"><iframe tabindex="0"></iframe></div></body>', {
    runScripts: 'outside-only',
  });
  const frame = dom.window.document.querySelector('iframe');
  const inner = frame.contentWindow;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const posted = [];
  dom.window.postMessage = (message) => posted.push(JSON.parse(JSON.stringify(message)));
  beforeBridge?.(inner);
  inner.eval(frameZoomBridgeScript());
  // The frame is drawn at twice its layout size (the panel's zoom).
  Object.defineProperty(frame, 'clientWidth', { value: 400 });
  Object.defineProperty(frame, 'clientHeight', { value: 300 });
  frame.getBoundingClientRect = () => ({ left: 100, top: 40, width: 800, height: 600 });
  const received = [];
  const unregister = registerZoomTarget({
    element: dom.window.document.getElementById('panel'),
    enabled: () => true,
    hovered: () => true,
    command: (...args) => received.push(args),
  });
  dom.window.document.elementFromPoint = () => frame;
  const stop = serveFrameZoom(frame);
  const deliver = (data, source = inner) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source }));
  const flush = () => {
    for (const message of posted.splice(0)) deliver(message);
  };
  const done = () => {
    stop();
    unregister();
    dom.window.close();
  };
  return { dom, inner, frame, posted, received, deliver, flush, done };
}

test('Ctrl+wheel and zoom keys inside a remote frame zoom the panel that holds the frame', () => {
  // A page that handles Ctrl+wheel itself (a chart) registered before the bridge ran.
  const { inner, posted, received, flush, done } = remotePage((page) =>
    page.eval(
      "window.addEventListener('wheel', function (event) { if (event.deltaY === 41) event.preventDefault(); }, { passive: false })"
    )
  );
  try {
    const wheel = new inner.WheelEvent('wheel', {
      ctrlKey: true,
      deltaY: -40,
      clientX: 10,
      clientY: 20,
      cancelable: true,
      bubbles: true,
    });
    inner.dispatchEvent(wheel);
    // The page's own wheel never zooms the frame itself.
    assert.equal(wheel.defaultPrevented, true);
    assert.equal(posted[0].type, FRAME_ZOOM_REQUEST);
    flush();
    // (10, 20) in the frame is (20, 40) drawn at 2x, from the frame's corner.
    assert.deepEqual(received, [['in', { x: 120, y: 80 }, { deltaY: -40, deltaMode: 0 }]]);

    // A key carries no place: it goes to the focused/hovered panel.
    received.length = 0;
    for (const [key, extra, input] of [
      ['=', {}, 'in'],
      ['+', {}, 'in'],
      ['-', { ctrlKey: false, metaKey: true }, 'out'],
      ['0', {}, 'reset'],
    ]) {
      const event = new inner.KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        cancelable: true,
        bubbles: true,
        ...extra,
      });
      inner.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true, key);
      flush();
      assert.deepEqual(received.pop(), [input], key);
    }

    // Plain wheel, other keys, Alt chords and gestures the page took stay the page's.
    inner.dispatchEvent(new inner.WheelEvent('wheel', { deltaY: 40, cancelable: true }));
    inner.dispatchEvent(new inner.KeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
    inner.dispatchEvent(new inner.KeyboardEvent('keydown', { key: '=', ctrlKey: true, altKey: true }));
    inner.dispatchEvent(new inner.WheelEvent('wheel', { ctrlKey: true, deltaY: 41, cancelable: true }));
    assert.deepEqual(posted, []);
  } finally {
    done();
  }
});

test('a two-finger pinch inside a remote frame zooms the panel; one finger stays the page’s', () => {
  const { inner, frame, posted, received, flush, done } = remotePage();
  try {
    const touch = (type, points) => {
      const event = new inner.Event(type, { cancelable: true, bubbles: true });
      Object.defineProperty(event, 'touches', { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
      inner.dispatchEvent(event);
      return event;
    };
    // One finger: a scroll, never taken.
    touch('touchstart', [[10, 10]]);
    assert.equal(touch('touchmove', [[10, 60]]).defaultPrevented, false);
    assert.deepEqual(posted, []);
    // Two fingers down 100px apart around (60, 20), then spreading to 150px.
    touch('touchstart', [
      [10, 20],
      [110, 20],
    ]);
    const move = touch('touchmove', [
      [-15, 20],
      [135, 20],
    ]);
    assert.equal(move.defaultPrevented, true, 'the pinch does not also pan the page');
    flush();
    // (60, 20) in the frame is (220, 80) in the window (2x, from the corner); ×1.5.
    assert.deepEqual(received, [['in', { x: 220, y: 80 }, undefined, 1.5]]);
    // The parent measures in its own px: once the panel draws the frame 1.5x
    // larger (the zoom it just applied), fingers that stay put on screen read
    // 1.5x closer in the frame's px, and that is no pinch (no zoom back).
    received.length = 0;
    frame.getBoundingClientRect = () => ({ left: 100, top: 40, width: 1200, height: 900 });
    touch('touchmove', [
      [10, 20],
      [110, 20],
    ]);
    flush();
    assert.deepEqual(received, [], 'fingers at rest on screen');
    touch('touchend', [[135, 20]]);
    assert.equal(touch('touchmove', [[135, 90]]).defaultPrevented, false, 'one finger again scrolls');
  } finally {
    done();
  }
});

test('a pinch on an element that turned pinch-zoom off (a 3D canvas) stays the page’s', () => {
  const { inner, posted, done } = remotePage();
  try {
    const canvas = inner.document.createElement('canvas');
    inner.document.body.appendChild(canvas);
    // jsdom has no touch-action: the page's computed style, as a browser gives it.
    inner.getComputedStyle = (node) => ({ getPropertyValue: () => (node === canvas ? 'none' : 'auto') });
    const touch = (type, points) => {
      const event = new inner.Event(type, { cancelable: true, bubbles: true });
      Object.defineProperty(event, 'touches', {
        value: points.map(([clientX, clientY]) => ({ clientX, clientY, target: canvas })),
      });
      canvas.dispatchEvent(event);
      return event;
    };
    touch('touchstart', [
      [10, 20],
      [110, 20],
    ]);
    const move = touch('touchmove', [
      [-15, 20],
      [135, 20],
    ]);
    assert.equal(move.defaultPrevented, false);
    assert.deepEqual(posted, []);
  } finally {
    done();
  }
});

test('only the frame itself can zoom the panel, and only with a well-formed message', () => {
  const { dom, received, deliver, done } = remotePage();
  try {
    deliver({ type: FRAME_ZOOM_REQUEST, zoom: 'in', x: 1, y: 1 }, dom.window);
    deliver({ type: 'other', zoom: 'in' });
    deliver({ type: FRAME_ZOOM_REQUEST, zoom: 'sideways' });
    deliver({ type: FRAME_ZOOM_REQUEST, zoom: 'in', x: Number.NaN, y: 1 });
    deliver(null);
    // Only the NaN place gets through, and as a placeless key.
    assert.deepEqual(received, [['in']]);
  } finally {
    done();
  }
});

test('the bridge is injected first in the page head', () => {
  const html = withFrameZoomBridge('<!doctype html><html><head><title>x</title></head><body></body></html>');
  assert.ok(html.indexOf(FRAME_ZOOM_REQUEST) < html.indexOf('<title>'));
});
