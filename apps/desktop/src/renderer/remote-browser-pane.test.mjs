import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'KeyboardEvent', 'CustomEvent', 'navigator'],
});
// React's IE input polyfill runs on focus in this jsdom setup and needs these.
window.HTMLElement.prototype.attachEvent = function attachEvent(_name, handler) {
  this.propertyChange = handler;
};
window.HTMLElement.prototype.detachEvent = () => {};

/**
 * One controlled clock for the pane: window and global timeouts and
 * intervals, animation frames and Date.now. Time moves only through
 * `advance` (the tests' `wait`), which runs every timer due on the way in
 * time order and lets promise work settle after each, so no timing boundary
 * (touch indicator, long-press, double tap, resize debounce) depends on how
 * fast the machine runs the test.
 */
const FRAME_MS = 16;

function createTestClock() {
  const drainOnce = () => new Promise((resolve) => setImmediate(resolve));
  const drain = async () => {
    await drainOnce();
    await drainOnce();
  };
  const startedAt = Date.now();
  const timers = new Map();
  let now = 0;
  let nextId = 1;
  const schedule = (callback, ms, args, every) => {
    const id = nextId++;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { id, at: now + delay, callback, args, every: every ? Math.max(1, delay) : 0 });
    return id;
  };
  const cancel = (id) => {
    timers.delete(id);
  };
  const clock = {
    get now() {
      return now;
    },
    /** Drop every pending callback and put back what was replaced. */
    restore() {
      timers.clear();
      for (const [target, name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete target[name];
      }
    },
    setTimeout: (callback, ms, ...args) => schedule(callback, ms, args, false),
    clearTimeout: cancel,
    setInterval: (callback, ms, ...args) => schedule(callback, ms, args, true),
    clearInterval: cancel,
    // A frame per FRAME_MS, as test-support/test-dom.mjs paces them.
    requestAnimationFrame: (callback) => schedule(() => callback(now), FRAME_MS, [], false),
    cancelAnimationFrame: cancel,
    async advance(ms) {
      const end = now + ms;
      await drain();
      for (;;) {
        let due = null;
        for (const timer of timers.values()) {
          if (timer.at <= end && (!due || timer.at < due.at || (timer.at === due.at && timer.id < due.id))) due = timer;
        }
        if (!due) break;
        now = Math.max(now, due.at);
        if (due.every) due.at += due.every;
        else timers.delete(due.id);
        due.callback(...due.args);
        await drain();
      }
      now = end;
    },
  };
  const timerNames = [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ];
  // Everything a test replaces: the timers here, and the bridge and interval
  // hooks `fakeApi` installs on the window.
  const saved = [
    ...[window, globalThis].flatMap((target) => timerNames.map((name) => [target, name])),
    [window, 'mixdogDesktop'],
    [Date, 'now'],
  ].map(([target, name]) => [target, name, Object.getOwnPropertyDescriptor(target, name)]);
  for (const target of [window, globalThis]) {
    for (const name of timerNames) target[name] = clock[name];
  }
  Date.now = () => startedAt + now;
  return clock;
}

const { default: RemoteBrowserPane, TOUCH_INDICATOR_MS } = await import('./RemoteBrowserPane.tsx');
const { createRemoteTouchController, DOUBLE_TAP_TIMEOUT_MS, TOUCH_LONG_PRESS_MS } = await import(
  './remote-browser-touch.ts'
);
const { STREAM_RENEW_MS } = await import('./use-remote-browser-stream.ts');
/** A fresh clock per test; panes a test left mounted are unmounted (on that
 *  clock) before everything it replaced is restored. */
let clock = null;
const mounted = new Set();
beforeEach(() => {
  clock = createTestClock();
});
afterEach(async () => {
  for (const pane of [...mounted]) await pane.unmount();
  clock.restore();
  clock = null;
});

/** Time passing, on the test clock. */
const wait = (ms = FRAME_MS) => clock.advance(ms);
/** One animation frame: coalesced input goes out, pending promises settle. */
const flush = () => act(async () => wait(FRAME_MS));

const streamFrame = (overrides = {}) => ({
  sessionId: 's',
  seq: 1,
  frameId: 'f',
  documentId: 'd1',
  url: 'https://example.test/',
  title: 'Page',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  width: 100,
  height: 50,
  viewportWidth: 200,
  viewportHeight: 100,
  image: { mimeType: 'image/jpeg', data: 'AA==' },
  ...overrides,
});

function fakeApi() {
  const state = { streams: [], acks: [], controls: [], listener: null, renew: null };
  window.setInterval = (callback) => {
    state.renew = callback;
    return 1;
  };
  window.clearInterval = () => {
    state.renew = null;
  };
  window.mixdogDesktop = {
    remoteBrowserStream: async (sessionId, options) => {
      state.streams.push([sessionId, options]);
    },
    remoteBrowserStreamAck: (sessionId, seq) => state.acks.push([sessionId, seq]),
    onRemoteBrowserFrame: (listener) => {
      state.listener = listener;
      return () => {
        state.listener = null;
      };
    },
    remoteBrowserControl: async (sessionId, input) => {
      state.controls.push({ sessionId, input });
      // The host answers a close with the tabs it has left.
      if (input.type === 'close-tab') return state.closeReply?.(input);
    },
    openExternal: async () => {},
  };
  return state;
}

async function mount(props = { sessionId: 's', active: true }) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(RemoteBrowserPane, props)));
  const pane = {
    root,
    rerender: (next) => act(async () => root.render(React.createElement(RemoteBrowserPane, next))),
    unmount: async () => {
      mounted.delete(pane);
      await act(async () => root.unmount());
      host.remove();
    },
  };
  mounted.add(pane);
  return pane;
}

/** 200x100 box for a 100x50 picture of a 200x100 viewport: client px == page px. */
async function showFrame(state) {
  await act(async () => state.listener(streamFrame()));
  await flush();
  const image = document.querySelector('.browser-remote-content img');
  image.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    x: 0,
    y: 0,
    toJSON() {},
  });
  const content = document.querySelector('.browser-remote-content');
  content.setPointerCapture = () => {};
  return content;
}

const pointerEvent = (type, init) => {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' });
  return event;
};
const pointers = (state) => state.controls.map(({ input }) => input).filter((input) => input.type === 'pointer');

test('stream starts on activation, renews, stops when hidden/inactive, and acks displayed frames', async () => {
  const state = fakeApi();
  const pane = await mount();
  try {
    assert.equal(state.streams.length, 1);
    assert.equal(state.streams[0][0], 's');
    assert.ok(state.streams[0][1].maxWidth > 0 && state.streams[0][1].maxHeight > 0);

    await act(async () => state.listener(streamFrame({ sessionId: 'other', seq: 9 })));
    await flush();
    assert.equal(document.querySelector('.browser-remote-content img'), null);
    assert.deepEqual(state.acks, []);

    await act(async () => state.listener(streamFrame({ seq: 1 })));
    await flush();
    const src = document.querySelector('.browser-remote-content img').getAttribute('src');
    assert.match(src, /^data:image\/jpeg;base64,AA==/);
    assert.deepEqual(state.acks, [['s', 1]]);

    // A metadata-only frame keeps the last image and is acknowledged too.
    await act(async () => state.listener(streamFrame({ seq: 2, image: undefined, title: 'Next' })));
    await flush();
    assert.equal(document.querySelector('.browser-remote-content img').getAttribute('src'), src);
    assert.deepEqual(state.acks.at(-1), ['s', 2]);

    await act(async () => state.renew());
    assert.equal(state.streams.length, 2);
    assert.ok(state.streams[1][1]);

    const hidden = (value) => {
      Object.defineProperty(document, 'visibilityState', { value, configurable: true });
      document.dispatchEvent(new window.Event('visibilitychange'));
    };
    await act(async () => hidden('hidden'));
    assert.deepEqual(state.streams.at(-1), ['s', null]);
    await act(async () => hidden('visible'));
    assert.ok(state.streams.at(-1)[1]);

    await pane.rerender({ sessionId: 's', active: false });
    assert.deepEqual(state.streams.at(-1), ['s', null]);
    const count = state.streams.length;
    await pane.rerender({ sessionId: 's', active: true });
    assert.equal(state.streams.length, count + 1);
    await pane.unmount();
    assert.deepEqual(state.streams.at(-1), ['s', null]);
  } finally {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await pane.unmount().catch(() => {});
  }
});

test('mouse maps to hover, press/release, wheel, and keyboard/IME through the shared input hook', async () => {
  const state = fakeApi();
  const pane = await mount();
  try {
    const content = await showFrame(state);
    await act(async () => {
      content.dispatchEvent(pointerEvent('pointermove', { clientX: 50, clientY: 25, buttons: 0 }));
      content.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 25, button: 0, buttons: 1 }));
      content.dispatchEvent(pointerEvent('pointerup', { clientX: 50, clientY: 25, button: 0, buttons: 0 }));
    });
    await flush();
    const mouse = pointers(state);
    assert.deepEqual(
      mouse.map((input) => [input.phase, input.button]),
      [
        ['mouseMoved', 'none'],
        ['mousePressed', 'left'],
        ['mouseReleased', 'left'],
      ]
    );
    assert.equal(mouse[1].x, 50);
    assert.equal(mouse[1].y, 25);
    assert.ok(state.controls.every(({ input }) => input.documentId === 'd1'));

    await act(async () => {
      const wheel = new window.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 25,
        deltaY: 40,
      });
      content.dispatchEvent(wheel);
    });
    await flush();
    assert.equal(state.controls.at(-1).input.type, 'wheel');
    assert.equal(state.controls.at(-1).input.deltaY, 40);

    const textarea = document.querySelector('.browser-remote-keyboard textarea');
    textarea.value = 'A';
    await act(async () => textarea.dispatchEvent(new window.Event('input', { bubbles: true })));
    await flush();
    assert.deepEqual(state.controls.at(-1).input, { type: 'text', text: 'A', documentId: 'd1' });
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
      );
    });
    await flush();
    assert.deepEqual(state.controls.at(-1).input, { type: 'key', key: 'Backspace', documentId: 'd1' });
  } finally {
    await pane.unmount();
  }
});

test('touch maps tap, long-press, drag, and two-finger pan to mouse input', async () => {
  const state = fakeApi();
  const pane = await mount();
  try {
    const content = await showFrame(state);
    const touch = (type, id, x, y) =>
      content.dispatchEvent(pointerEvent(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y }));

    // Tap: move + press + release, left button, with an immediate local dot.
    const downAt = clock.now;
    await act(async () => {
      touch('pointerdown', 1, 50, 25);
    });
    assert.ok(document.querySelector('.browser-remote-touch-dot'));
    await act(async () => touch('pointerup', 1, 50, 25));
    await flush();
    assert.deepEqual(
      pointers(state).map((input) => [input.phase, input.button]),
      [
        ['mouseMoved', 'none'],
        ['mousePressed', 'left'],
        ['mouseReleased', 'left'],
      ]
    );
    // The dot lasts its indicator time, then goes.
    await act(async () => wait(downAt + TOUCH_INDICATOR_MS - 1 - clock.now));
    assert.ok(document.querySelector('.browser-remote-touch-dot'));
    await act(async () => wait(1));
    assert.equal(document.querySelector('.browser-remote-touch-dot'), null);

    // Long-press without movement: right click, once held for the long-press time.
    state.controls.length = 0;
    await act(async () => wait(DOUBLE_TAP_TIMEOUT_MS));
    await act(async () => touch('pointerdown', 2, 60, 30));
    await act(async () => wait(TOUCH_LONG_PRESS_MS - 1));
    assert.equal(pointers(state).length, 0, 'not yet a long-press');
    await act(async () => wait(1));
    await act(async () => touch('pointerup', 2, 60, 30));
    await flush();
    assert.deepEqual(
      pointers(state).map((input) => [input.phase, input.button]),
      [
        ['mouseMoved', 'none'],
        ['mousePressed', 'right'],
        ['mouseReleased', 'right'],
      ]
    );

    // One-finger drag: press at the start, streamed left-button moves, release last.
    state.controls.length = 0;
    await act(async () => touch('pointerdown', 3, 10, 40));
    await act(async () => touch('pointermove', 3, 40, 40));
    await act(async () => wait(10));
    await act(async () => touch('pointermove', 3, 90, 40));
    await act(async () => touch('pointerup', 3, 90, 40));
    await flush();
    const drag = pointers(state);
    const phases = drag.map((input) => input.phase);
    assert.deepEqual(phases.slice(0, 2), ['mouseMoved', 'mousePressed']);
    assert.equal(phases.at(-1), 'mouseReleased');
    assert.equal(phases.indexOf('mouseReleased'), phases.length - 1);
    assert.equal(drag[1].x, 10);
    assert.equal(drag.at(-1).x, 90);
    assert.ok(
      drag.slice(2, -1).every((input) => input.phase === 'mouseMoved' && input.button === 'left' && input.buttons === 1)
    );

    // Two-finger pan scrolls instead of clicking: with touch lists (touchstart
    // and touchmove alongside the pointer reports) each motion goes out once.
    const touchList = (type, points) => {
      const list = new window.TouchEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(list, 'touches', {
        value: points.map(([clientX, clientY]) => ({ clientX, clientY, target: content })),
      });
      content.dispatchEvent(list);
    };
    const wheelsSent = () => state.controls.map(({ input }) => input).filter((input) => input.type === 'wheel');
    state.controls.length = 0;
    await act(async () => {
      touch('pointerdown', 4, 50, 50);
      touchList('touchstart', [[50, 50]]);
      touch('pointerdown', 5, 150, 50);
      touchList('touchstart', [
        [50, 50],
        [150, 50],
      ]);
      touch('pointermove', 4, 50, 30);
      touch('pointermove', 5, 150, 30);
      touchList('touchmove', [
        [50, 30],
        [150, 30],
      ]);
      touch('pointerup', 4, 50, 30);
      touch('pointerup', 5, 150, 30);
    });
    await flush();
    assert.equal(pointers(state).length, 0);
    assert.ok(wheelsSent().length > 0);
    assert.equal(
      wheelsSent().reduce((sum, wheel) => sum + wheel.deltaY, 0),
      20,
      'not dispatched twice'
    );

    // Pointer reports only (no touch events): the scroll still works, and
    // nothing zooms.
    state.controls.length = 0;
    await act(async () => wait(DOUBLE_TAP_TIMEOUT_MS));
    await act(async () => {
      touch('pointerdown', 6, 50, 50);
      touch('pointerdown', 7, 150, 50);
      for (let step = 1; step <= 3; step += 1) {
        touch('pointermove', 6, 50, 50 - step * 10);
        touch('pointermove', 7, 150, 50 - step * 10);
      }
      touch('pointerup', 6, 50, 20);
      touch('pointerup', 7, 150, 20);
    });
    await flush();
    assert.equal(pointers(state).length, 0);
    assert.equal(
      wheelsSent().reduce((sum, wheel) => sum + wheel.deltaY, 0),
      30
    );
    assert.equal(document.querySelector('.browser-remote-content img').style.transform, '', 'no local zoom');
  } finally {
    await pane.unmount();
  }
});

/**
 * A 390×700 picture stage and a visual viewport the test drives; with
 * `phone`, an iPhone's agent (the phone layout). Installed before mounting.
 */
function surface({ phone = true } = {}) {
  const agent = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  if (phone) {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
    });
  }
  const stage = { width: 390, height: 700 };
  const proto = window.HTMLElement.prototype;
  for (const [name, key] of [
    ['clientWidth', 'width'],
    ['clientHeight', 'height'],
  ]) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get() {
        return this.classList?.contains('browser-remote-content') ? stage[key] : 0;
      },
    });
  }
  const visual = new window.EventTarget();
  visual.width = 390;
  visual.height = 800;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
  // The VirtualKeyboard API (Chromium): its rectangle over the page.
  const keyboard = new window.EventTarget();
  keyboard.boundingRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  Object.defineProperty(window.navigator, 'virtualKeyboard', { configurable: true, value: keyboard });
  return {
    stage,
    visual,
    keyboard,
    resize: () => act(async () => visual.dispatchEvent(new window.Event('resize'))),
    restore() {
      delete proto.clientWidth;
      delete proto.clientHeight;
      delete window.visualViewport;
      delete window.navigator.virtualKeyboard;
      if (agent) Object.defineProperty(window.navigator, 'userAgent', agent);
      else delete window.navigator.userAgent;
    },
  };
}

const pictureOf = () => document.querySelector('.browser-remote-content img');

test('desktop pane: the picture stays contained in its box, as before', async () => {
  const screen = surface({ phone: false });
  const state = fakeApi();
  const pane = await mount();
  try {
    await showFrame(state);
    await act(async () => window.dispatchEvent(new window.Event('resize')));
    await flush();
    assert.equal(pictureOf().style.transform, '', 'no view transform');
    assert.equal(pictureOf().style.width, '', 'the CSS fit (100%, object-fit: contain)');
    assert.equal(
      document.querySelector('.browser-remote-keyboard').dataset.open,
      'false',
      'the typing bar is a toggle'
    );
  } finally {
    await pane.unmount();
    screen.restore();
  }
});

test('phone: the view fills one axis, keeps its scale under the keyboard, and refits on a real resize', async () => {
  const screen = surface();
  const state = fakeApi();
  const pane = await mount();
  try {
    await showFrame(state);
    // A 200×100 page on a 390×700 stage fills the height (7×) from the left edge.
    assert.equal(pictureOf().style.width, '200px');
    assert.match(pictureOf().style.transform, /translate\(0px, 0px\) scale\(7\)/);
    const bar = document.querySelector('.browser-remote-keyboard');
    assert.equal(bar.dataset.open, 'true', 'always shown');
    assert.equal(bar, document.querySelector('.browser-remote-pane').lastElementChild, 'docked under the page');
    // The composer look: one send button, no separate X.
    assert.ok(bar.classList.contains('is-composer'));
    assert.equal(bar.querySelectorAll('button').length, 1);
    assert.equal(bar.querySelector('svg.lucide-x'), null, 'no X button');
    const send = bar.querySelector('button.send-button');
    await act(async () => send.click());
    await flush();
    assert.deepEqual(
      state.controls.at(-1).input,
      { type: 'key', key: 'Enter', documentId: 'd1' },
      'send presses Enter'
    );

    // The bar takes focus and the keyboard comes up: the same view, inset.
    await act(async () => bar.querySelector('textarea').focus());
    screen.visual.height = 450;
    screen.stage.height = 380;
    await screen.resize();
    assert.match(pictureOf().style.transform, /scale\(7\)/, 'no refit for the keyboard');
    // Blurred, the keyboard slides away: the inset holds while the visual
    // viewport grows back, and goes on the resize that reaches its height
    // without a keyboard. A stage still that short is then a new layout.
    await act(async () => bar.querySelector('textarea').blur());
    assert.match(pictureOf().style.transform, /scale\(7\)/, 'not at the blur');
    screen.visual.height = 600;
    await screen.resize();
    assert.match(pictureOf().style.transform, /scale\(7\)/, 'not while it slides away');
    screen.visual.height = 800;
    await screen.resize();
    assert.match(pictureOf().style.transform, /scale\(3\.8\)/, 'refit: 380 / 100');

    // A split-screen resize with nothing focused refits, never an inset.
    screen.visual.height = 600;
    screen.stage.height = 500;
    await screen.resize();
    assert.match(pictureOf().style.transform, /scale\(5\)/);
  } finally {
    await pane.unmount();
    screen.restore();
  }
});

test('phone: send mid-composition commits the composed text once, then one Enter, keeping focus', async () => {
  const screen = surface();
  const state = fakeApi();
  const pane = await mount();
  try {
    await showFrame(state);
    const textarea = document.querySelector('.browser-remote-keyboard textarea');
    const send = document.querySelector('.browser-remote-keyboard button.send-button');
    // The DOM test env does not route composition events through React: call the field's handlers.
    const props = textarea[Object.keys(textarea).find((name) => name.startsWith('__reactProps$'))];
    const fire = (handler, data) => act(async () => props[handler]({ data, currentTarget: textarea, nativeEvent: {} }));
    await act(async () => textarea.focus());
    await fire('onCompositionStart', '');
    await fire('onCompositionUpdate', '한');
    await flush();
    const before = state.controls.length;
    await act(async () => send.click());
    await flush();
    const sent = state.controls.slice(before).map(({ input }) => input);
    assert.deepEqual(
      sent.map((input) => [input.type, input.text ?? input.key]),
      [
        ['composition-end', '한'],
        ['key', 'Enter'],
      ]
    );
    assert.equal(document.activeElement, textarea, 'focus is kept');
    // The IME's late end of the same composition sends nothing more.
    await fire('onCompositionEnd', '한');
    await flush();
    assert.equal(state.controls.length, before + 2);
    // No composition: exactly one Enter.
    await act(async () => send.click());
    await flush();
    assert.equal(state.controls.length, before + 3);
    assert.equal(state.controls.at(-1).input.key, 'Enter');
  } finally {
    await pane.unmount();
    screen.restore();
  }
});

test('phone: a keyboard the VirtualKeyboard API reports over the page insets the view without a resize', async () => {
  const screen = surface();
  const state = fakeApi();
  const pane = await mount();
  try {
    const content = await showFrame(state);
    content.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 390,
      bottom: 700,
      width: 390,
      height: 700,
      x: 0,
      y: 0,
    });
    const touch = (type, id, x, y) =>
      content.dispatchEvent(pointerEvent(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y }));
    const dragUp = async (id) => {
      await act(async () => touch('pointerdown', id, 100, 500));
      await act(async () => touch('pointermove', id, 100, 450));
      await act(async () => touch('pointermove', id, 100, 400));
      await act(async () => touch('pointerup', id, 100, 400));
    };
    // The page fills the stage's height: no vertical room.
    await dragUp(1);
    assert.match(pictureOf().style.transform, /translate\(0px, 0px\) scale\(7\)/);
    // The keyboard covers the stage's bottom 300 px; nothing was resized.
    screen.keyboard.boundingRect = { top: 400, bottom: 800, left: 0, right: 390, width: 390, height: 400 };
    await act(async () => screen.keyboard.dispatchEvent(new window.Event('geometrychange')));
    assert.match(pictureOf().style.transform, /translate\(0px, 0px\) scale\(7\)/, 'the view stays');
    await dragUp(2);
    assert.match(pictureOf().style.transform, /translate\(0px, -100px\) scale\(7\)/, 'brought up over it');
  } finally {
    await pane.unmount();
    screen.restore();
  }
});

test('phone touch: sized rings, long-press drag, one-finger view pan, two-finger right click, edge taps and swipes', async () => {
  const screen = surface();
  const state = fakeApi();
  const pane = await mount();
  try {
    const content = await showFrame(state);
    const touch = (type, id, x, y) =>
      content.dispatchEvent(pointerEvent(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y }));
    const dot = () => document.querySelector('.browser-remote-touch-dot');
    const phases = () => pointers(state).map((input) => [input.phase, input.button, input.x]);

    // A tap: left click; the ring only once it was sent, sized for a tap.
    await act(async () => touch('pointerdown', 1, 50, 25));
    assert.equal(dot(), null);
    await act(async () => touch('pointerup', 1, 50, 25));
    await flush();
    assert.deepEqual(phases(), [
      ['mouseMoved', 'none', 50],
      ['mousePressed', 'left', 50],
      ['mouseReleased', 'left', 50],
    ]);
    assert.equal(dot().style.width, '50px');

    // A long-press holds the left button; a move drags it; lifting releases.
    state.controls.length = 0;
    await act(async () => wait(DOUBLE_TAP_TIMEOUT_MS));
    await act(async () => touch('pointerdown', 2, 60, 30));
    await act(async () => wait(TOUCH_LONG_PRESS_MS));
    assert.equal(dot().style.width, '110px', 'a press’s ring');
    await act(async () => touch('pointermove', 2, 90, 40));
    await act(async () => touch('pointerup', 2, 90, 40));
    await flush();
    assert.deepEqual(phases(), [
      ['mouseMoved', 'none', 60],
      ['mousePressed', 'left', 60],
      ['mouseMoved', 'left', 90],
      ['mouseReleased', 'left', 90],
    ]);

    // One finger moves the view, never the page.
    state.controls.length = 0;
    await act(async () => touch('pointerdown', 3, 100, 300));
    await act(async () => touch('pointermove', 3, 80, 300));
    await act(async () => touch('pointermove', 3, 50, 300));
    await act(async () => touch('pointerup', 3, 50, 300));
    await flush();
    assert.equal(pointers(state).length, 0);
    assert.match(pictureOf().style.transform, /translate\(-50px, 0px\) scale\(7\)/);

    // Two fingers tapped: a right click where the first went down.
    await act(async () => {
      touch('pointerdown', 4, 70, 30);
      touch('pointerdown', 5, 120, 30);
      touch('pointerup', 4, 70, 30);
      touch('pointerup', 5, 120, 30);
    });
    await flush();
    assert.deepEqual(phases(), [
      ['mouseMoved', 'none', 70],
      ['mousePressed', 'right', 70],
      ['mouseReleased', 'right', 70],
    ]);

    // At the screen's edge a tap is delivered; a swipe inward is the system's.
    state.controls.length = 0;
    await act(async () => wait(DOUBLE_TAP_TIMEOUT_MS));
    await act(async () => {
      touch('pointerdown', 6, 5, 40);
      touch('pointerup', 6, 5, 40);
    });
    await flush();
    assert.deepEqual(phases(), [
      ['mouseMoved', 'none', 5],
      ['mousePressed', 'left', 5],
      ['mouseReleased', 'left', 5],
    ]);
    state.controls.length = 0;
    await act(async () => {
      touch('pointerdown', 7, 5, 40);
      touch('pointermove', 7, 30, 40);
      touch('pointermove', 7, 60, 40);
      touch('pointerup', 7, 60, 40);
    });
    await flush();
    assert.equal(pointers(state).length, 0);
    assert.match(pictureOf().style.transform, /translate\(-50px, 0px\)/, 'the view did not move');
  } finally {
    await pane.unmount();
    screen.restore();
  }
});

test('phone: a long-press drag whose touch stream is lost releases the PC’s button', async () => {
  const screen = surface();
  const state = fakeApi();
  const pane = await mount();
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  try {
    const content = await showFrame(state);
    const touch = (type, id, x, y) =>
      content.dispatchEvent(pointerEvent(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y }));
    const held = async (id) => {
      state.controls.length = 0;
      await act(async () => wait(DOUBLE_TAP_TIMEOUT_MS));
      await act(async () => touch('pointerdown', id, 60, 30));
      await act(async () => wait(TOUCH_LONG_PRESS_MS));
      await act(async () => touch('pointermove', id, 90, 40));
      await flush();
      assert.deepEqual(
        pointers(state).map((input) => [input.phase, input.buttons]),
        [
          ['mouseMoved', 0],
          ['mousePressed', 1],
          ['mouseMoved', 1],
        ],
        'held and dragging'
      );
    };
    const released = () => pointers(state).filter((input) => input.phase === 'mouseReleased');
    const lose = [
      ['the window loses focus', () => window.dispatchEvent(new window.Event('blur'))],
      ['the pointer capture is lost', (id) => touch('lostpointercapture', id, 90, 40)],
      [
        'the page is hidden',
        () => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new window.Event('visibilitychange'));
        },
      ],
    ];
    let id = 10;
    for (const [what, loseStream] of lose) {
      id += 1;
      await held(id);
      await act(async () => loseStream(id));
      assert.deepEqual(
        released().map((input) => [input.button, input.buttons, input.x]),
        [['left', 0, 90]],
        `${what}: released where it was dragged`
      );
      // The finger's late events change nothing.
      await act(async () => touch('pointermove', id, 120, 40));
      await act(async () => touch('pointerup', id, 120, 40));
      await flush();
      assert.equal(released().length, 1, `${what}: released once`);
      assert.equal(pointers(state).at(-1).phase, 'mouseReleased');
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      else delete document.visibilityState;
    }
  } finally {
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else delete document.visibilityState;
    await pane.unmount();
    screen.restore();
  }
});

test('during a takeover a tap on the page raises the soft keyboard and typing reaches the page', async () => {
  const { holdBrowserTakeover } = await import('./browser-takeover-input.ts');
  const state = fakeApi();
  const pane = await mount();
  try {
    const content = await showFrame(state);
    // The streamed page is tab p3 of the session (metadata-only frame: the picture stays).
    await act(async () => state.listener(streamFrame({ seq: 2, documentId: 'p3:0', image: undefined })));
    await flush();
    const textarea = document.querySelector('.browser-remote-keyboard textarea');
    const tap = async (id) => {
      const touch = (type) =>
        content.dispatchEvent(pointerEvent(type, { pointerType: 'touch', pointerId: id, clientX: 50, clientY: 25 }));
      await act(async () => touch('pointerdown'));
      await act(async () => touch('pointerup'));
    };

    // No takeover: a tap only clicks; the keyboard stays an explicit choice.
    await tap(1);
    assert.notEqual(document.activeElement, textarea);

    // A takeover of another session changes nothing here.
    const other = holdBrowserTakeover('other', 'p3');
    await tap(2);
    assert.notEqual(document.activeElement, textarea);
    other();

    // Another tab of this session is the takeover's page, not the one shown.
    const elsewhere = holdBrowserTakeover('s', 'p9');
    await tap(6);
    assert.notEqual(document.activeElement, textarea);
    elsewhere();

    // This page's takeover: the tap clicks the page, then focuses the keyboard field.
    // The same approval mounted twice holds twice; each ends on its own.
    const release = holdBrowserTakeover('s', 'p3');
    const copy = holdBrowserTakeover('s', 'p3');
    copy();
    await flush();
    state.controls.length = 0;
    await tap(3);
    await flush();
    assert.deepEqual(
      pointers(state).map((input) => input.phase),
      ['mouseMoved', 'mousePressed', 'mouseReleased']
    );
    assert.equal(document.activeElement, textarea);
    // A dismissed keyboard leaves the field focused: the next tap re-raises it,
    // even inside the double-tap window (a fitted picture's taps both click).
    let focused = 0;
    textarea.addEventListener('focus', () => focused++);
    state.controls.length = 0;
    await act(async () => wait(DOUBLE_TAP_TIMEOUT_MS - FRAME_MS));
    await tap(4);
    assert.equal(focused, 1);
    assert.equal(pointers(state).filter((input) => input.phase === 'mousePressed').length, 1);

    // What is typed (a password included) goes to the page and nowhere else.
    textarea.value = 'hunter2';
    await act(async () => textarea.dispatchEvent(new window.Event('input', { bubbles: true })));
    await flush();
    assert.deepEqual(state.controls.at(-1), {
      sessionId: 's',
      input: { type: 'text', text: 'hunter2', documentId: 'p3:0' },
    });
    assert.equal(textarea.value, '');

    // The takeover over, taps leave the keyboard alone again.
    release();
    await flush();
    textarea.blur();
    await tap(5);
    assert.notEqual(document.activeElement, textarea);

    // A handoff that named no tab covers the page as streamed.
    const unnamed = holdBrowserTakeover('s', '');
    await tap(7);
    assert.equal(document.activeElement, textarea);
    unnamed();
  } finally {
    await pane.unmount();
  }
});

test('touches on the frame are cancelled so the platform cannot claim them; controls over it keep theirs', async () => {
  const state = fakeApi();
  const pane = await mount();
  try {
    const content = await showFrame(state);
    // React registers touchstart/touchmove passive at its root, so only the
    // pane's own listener can stop iOS WebKit from taking the touch for a
    // scroll, zoom, selection or callout (pointercancel ends the gesture).
    const touch = (target, type) => {
      const event = new window.TouchEvent(type, { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(touch(content, 'touchstart'), true);
    assert.equal(touch(content, 'touchmove'), true);
    const zoomButton = content.querySelector('.browser-zoom-pill button');
    assert.ok(zoomButton);
    assert.equal(touch(zoomButton, 'touchstart'), false, 'the zoom pill keeps its tap');
  } finally {
    await pane.unmount();
  }
});

test('touch controller maps gestures with injected timing', async () => {
  const sent = [];
  const controller = createRemoteTouchController({
    page: (x, y) => ({ x, y }),
    pageDelta: (dx, dy) => ({ x: dx, y: dy }),
    send: (action) => sent.push(action),
    panning: () => false,
    pan() {},
    longPressMs: 15,
  });
  controller.down(1, 5, 5);
  await wait(40);
  controller.up(1, 5, 5);
  assert.deepEqual(
    sent.map((action) => `${action.phase}:${action.button}`),
    ['mouseMoved:none', 'mousePressed:right', 'mouseReleased:right']
  );
  sent.length = 0;
  controller.down(2, 5, 5);
  controller.move(2, 5, 6);
  controller.up(2, 5, 6);
  assert.deepEqual(
    sent.map((action) => action.phase),
    ['mouseMoved', 'mousePressed', 'mouseReleased'],
    'movement inside the slop is still a tap'
  );
  // A cancelled drag releases the held button.
  sent.length = 0;
  controller.down(3, 0, 0);
  controller.move(3, 30, 0);
  controller.cancel(3);
  assert.equal(sent.at(-1).phase, 'mouseReleased');
});

test('a document change applies metadata at once and drops input for the old document', async () => {
  const state = fakeApi();
  const pane = await mount();
  try {
    const content = await showFrame(state);
    await act(async () => {
      content.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 25, button: 0, buttons: 1 }));
    });
    await flush();
    state.controls.length = 0;
    await act(async () => {
      // Coalesced motion is still waiting for its animation frame when the
      // desktop reports a different document.
      content.dispatchEvent(pointerEvent('pointermove', { clientX: 80, clientY: 25, buttons: 1 }));
      state.listener(
        streamFrame({
          seq: 2,
          documentId: 'd2',
          url: 'https://next.test/',
          title: 'Next',
          canGoBack: true,
          image: undefined,
        })
      );
    });
    assert.equal(document.querySelector('.browser-pane-address').value, 'https://next.test/');
    assert.equal(document.querySelector('button[aria-label="Back"]').disabled, false);
    await flush();
    const sent = pointers(state);
    assert.deepEqual(
      sent.map((input) => input.phase),
      ['mouseReleased'],
      'pending move dropped, press released'
    );
    assert.equal(sent[0].documentId, 'd1');
    state.controls.length = 0;
    await act(async () => content.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: 20, buttons: 0 })));
    await flush();
    assert.equal(pointers(state)[0].documentId, 'd2');
  } finally {
    await pane.unmount();
  }
});

test('after a resize input is refused, not mis-mapped, until pixels at the new size arrive; the old image stays', async () => {
  const state = fakeApi();
  const pane = await mount();
  try {
    const content = await showFrame(state);
    const src = document.querySelector('.browser-remote-content img').getAttribute('src');
    const click = () =>
      act(async () => {
        content.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 25, button: 0, buttons: 1 }));
        content.dispatchEvent(pointerEvent('pointerup', { clientX: 50, clientY: 25, button: 0, buttons: 0 }));
        content.dispatchEvent(
          new window.WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 50, clientY: 25, deltaY: 40 })
        );
      });
    const pageInput = () =>
      state.controls.map(({ input }) => input).filter((input) => input.type === 'pointer' || input.type === 'wheel');

    // The host resized the page: its facts describe no picture yet (0×0).
    await act(async () =>
      state.listener(
        streamFrame({ seq: 2, image: undefined, width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 })
      )
    );
    await flush();
    assert.equal(document.querySelector('.browser-remote-content img').getAttribute('src'), src, 'the old image stays');
    state.controls.length = 0;
    await click();
    await flush();
    assert.deepEqual(pageInput(), [], 'no click or scroll is mapped through the old geometry');

    // Facts that describe a picture of another size than the one shown refuse input too.
    await act(async () => state.listener(streamFrame({ seq: 3, image: undefined, width: 120, height: 60 })));
    await flush();
    await click();
    await flush();
    assert.deepEqual(pageInput(), []);

    // Pixels at the new size: 120×60 of a 240×120 viewport in the 200×100 box.
    await act(async () =>
      state.listener(streamFrame({ seq: 4, width: 120, height: 60, viewportWidth: 240, viewportHeight: 120 }))
    );
    await flush();
    await click();
    await flush();
    const sent = pageInput();
    assert.deepEqual(
      sent.map((input) => (input.type === 'wheel' ? 'wheel' : input.phase)),
      ['mousePressed', 'mouseReleased', 'wheel']
    );
    assert.deepEqual([sent[0].x, sent[0].y], [60, 30], 'mapped through the new picture');
  } finally {
    await pane.unmount();
  }
});

test('a page-changed control error is not shown, and a reconnect restarts the stream', async () => {
  const state = fakeApi();
  window.mixdogDesktop.remoteBrowserControl = async () => {
    throw new Error('Browser page changed; input was not sent.');
  };
  const pane = await mount();
  try {
    await showFrame(state);
    await act(async () => document.querySelector('button[aria-label="Reload"]').click());
    await flush();
    assert.equal(document.querySelector('.error-notice'), null);
    const count = state.streams.length;
    await act(async () => window.dispatchEvent(new window.Event('mixdog:remote-connection-ready')));
    assert.equal(state.streams.length, count + 1);
    assert.ok(state.streams.at(-1)[1]);
  } finally {
    await pane.unmount();
  }
});

test('a browserParity host adds a tab strip whose selection moves the stream and whose + opens a tab', async () => {
  const state = fakeApi();
  const tabsSeen = { watch: [], opened: [], closed: [], push: null };
  const list = [
    { id: 'main-browser-a', title: 'Alpha', url: 'https://a.test/', loading: false },
    { id: 'main-browser-b', title: 'Beta', url: 'https://b.test/', loading: false },
  ];
  Object.assign(window.mixdogDesktop, {
    remoteBrowserTabs: async (watch) => {
      tabsSeen.watch.push(watch);
      return list;
    },
    onRemoteBrowserTabs: (listener) => {
      tabsSeen.push = listener;
      return () => {
        tabsSeen.push = null;
      };
    },
    remoteBrowserOpenTab: async (url) => {
      tabsSeen.opened.push(url);
      return { id: 'main-browser-c', title: '', url, loading: true };
    },
    remoteBrowserCloseTab: async (id) => {
      tabsSeen.closed.push(id);
    },
  });
  const pane = await mount({ sessionId: 'main-browser-a', active: true });
  try {
    await flush();
    assert.deepEqual(tabsSeen.watch, [true]);
    const selectors = [...document.querySelectorAll('[role="tab"]')];
    assert.deepEqual(
      selectors.map((tab) => tab.getAttribute('data-page-id')),
      ['main-browser-a', 'main-browser-b']
    );
    assert.equal(state.streams.at(-1)[0], 'main-browser-a');

    // Picking the sibling retargets this client's stream, and the old one stops.
    await act(async () => selectors[1].click());
    await flush();
    assert.equal(state.streams.at(-1)[0], 'main-browser-b');
    assert.ok(state.streams.some(([id, options]) => id === 'main-browser-a' && options === null));

    // A pushed list replaces the strip.
    await act(async () => tabsSeen.push([list[1]]));
    assert.equal(document.querySelectorAll('[role="tab"]').length, 1);
    await act(async () => tabsSeen.push(list));

    // "+" waits for an address, then opens and follows the new tab.
    await act(async () => document.querySelector('button[aria-label="New tab"]').click());
    const address = document.querySelector('input[aria-label="Address bar"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(address, 'example.com');
      address.dispatchEvent(new window.Event('input', { bubbles: true }));
      // Without a native input event here, React's polyfill reads value changes off propertychange.
      address.propertyChange({ propertyName: 'value', target: address });
    });
    await act(async () => address.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    assert.equal(tabsSeen.opened.length, 1);
    assert.match(tabsSeen.opened[0], /example\.com/);
    assert.equal(state.streams.at(-1)[0], 'main-browser-c');

    // Closing the streamed tab leaves it first, then releases it.
    await act(async () => document.querySelector('button[aria-label^="Close tab: "]:last-of-type').click());
    await flush();
    assert.equal(tabsSeen.closed.length, 1);
  } finally {
    await pane.unmount();
  }
  assert.deepEqual(tabsSeen.watch, [true, false]);
});

test('phone: a conversation browser offers no new tab and keeps its page across hide/reopen; the main browser still creates tabs', async () => {
  const state = fakeApi();
  const opened = [];
  const seen = tabHost([
    { id: 'main-browser-a', title: 'A', url: 'https://a.test/', loading: false },
    { id: 'main-browser-b', title: 'B', url: 'https://b.test/', loading: false },
  ]);
  Object.assign(window.mixdogDesktop, {
    remoteBrowserOpenTab: async (url) => {
      opened.push(url);
      return { id: 'main-browser-new', title: 'New', url, loading: true };
    },
  });
  const agent = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  const pane = await mount({ sessionId: 's', active: true });
  try {
    await showFrame(state);
    await flush();
    const ids = () => [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('data-page-id'));
    const selectedId = () =>
      [...document.querySelectorAll('[role="tab"]')]
        .find((tab) => tab.getAttribute('aria-selected') === 'true')
        ?.getAttribute('data-page-id');
    assert.deepEqual(ids(), ['s']);
    assert.equal(document.querySelector('button[aria-label="New tab"]'), null);
    assert.equal(selectedId(), 's');

    await pane.rerender({ sessionId: 's', active: false });
    await pane.rerender({ sessionId: 's', active: true });
    await flush();
    assert.deepEqual(ids(), ['s']);
    assert.equal(selectedId(), 's');
    assert.equal(state.streams.at(-1)[0], 's');
    assert.equal(opened.length, 0);
    assert.deepEqual(seen.watch, []);

    // The main-workspace browser on the phone keeps its "+".
    await pane.rerender({ sessionId: 'main-browser-a', active: true });
    await flush();
    await act(async () => document.querySelector('button[aria-label="New tab"]').click());
    const address = document.querySelector('input[aria-label="Address bar"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(address, 'example.com');
      address.dispatchEvent(new window.Event('input', { bubbles: true }));
      address.propertyChange({ propertyName: 'value', target: address });
    });
    await act(async () => address.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    assert.equal(opened.length, 1);
    assert.equal(selectedId(), 'main-browser-new');
  } finally {
    if (agent) Object.defineProperty(window.navigator, 'userAgent', agent);
    else delete window.navigator.userAgent;
    await pane.unmount();
  }
});

test('phone: a host with session tabs mirrors the conversation strip and sends new/select/close', async () => {
  const state = fakeApi();
  const { PANE_DOCK_CLOSE_EVENT } = await import('./pane-dock-chrome.tsx');
  window.mixdogDesktop.remoteBrowserSessionTabs = true;
  const closes = [];
  const onClose = (event) => closes.push(event.detail.surface);
  window.addEventListener(PANE_DOCK_CLOSE_EVENT, onClose);
  const strip = (...ids) =>
    ids.map(([id, active]) => ({
      id,
      title: `T ${id}`,
      url: `https://${id}.test/`,
      active,
      loading: false,
      kind: 'page',
    }));
  const agent = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  const pane = await mount({ sessionId: 's', active: true });
  const ids = () => [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('data-page-id'));
  const selected = () =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.getAttribute('aria-selected') === 'true')
      ?.getAttribute('data-page-id');
  const sent = () => state.controls.map(({ sessionId, input }) => [sessionId, input.type, input.tabId]);
  try {
    await act(async () => state.listener(streamFrame({ tabs: strip(['p1', true]) })));
    await flush();
    assert.deepEqual(ids(), ['p1']);

    // "+" asks the host for a tab in this conversation's own browser.
    await act(async () => document.querySelector('button[aria-label="New tab"]').click());
    assert.deepEqual(sent(), [['s', 'new-tab', undefined]]);
    await act(async () =>
      state.listener(streamFrame({ seq: 2, documentId: 'd2', tabs: strip(['p1', false], ['p2', true]) }))
    );
    await flush();
    assert.deepEqual(ids(), ['p1', 'p2']);
    assert.equal(selected(), 'p2');

    // Tapping a tab selects it on the host; the strip follows the host's frame.
    await act(async () => document.querySelector('[role="tab"][data-page-id="p1"]').click());
    assert.deepEqual(sent().at(-1), ['s', 'select-tab', 'p1']);
    await act(async () =>
      state.listener(streamFrame({ seq: 3, documentId: 'd3', tabs: strip(['p1', true], ['p2', false]) }))
    );
    await flush();
    assert.equal(selected(), 'p1');

    // Hide and reopen: the strip comes back from the stream, the page stays reachable.
    await pane.rerender({ sessionId: 's', active: false });
    await pane.rerender({ sessionId: 's', active: true });
    await act(async () =>
      state.listener(streamFrame({ seq: 4, documentId: 'd3', tabs: strip(['p1', true], ['p2', false]) }))
    );
    await flush();
    assert.deepEqual(ids(), ['p1', 'p2']);
    assert.equal(selected(), 'p1');

    // × closes on the host; closing the last tab also closes the panel.
    state.closeReply = ({ tabId }) => ({ remainingTabs: tabId === 'p2' ? 1 : 0 });
    await act(async () => document.querySelector('button[aria-label="Close tab: T p2"]').click());
    assert.deepEqual(sent().at(-1), ['s', 'close-tab', 'p2']);
    assert.deepEqual(closes, []);
    await act(async () => state.listener(streamFrame({ seq: 5, documentId: 'd3', tabs: strip(['p1', true]) })));
    await flush();
    assert.deepEqual(ids(), ['p1']);
    await act(async () => document.querySelector('button[aria-label="Close tab: T p1"]').click());
    assert.deepEqual(sent().at(-1), ['s', 'close-tab', 'p1']);
    assert.deepEqual(closes, ['browser']);
  } finally {
    window.removeEventListener(PANE_DOCK_CLOSE_EVENT, onClose);
    delete window.mixdogDesktop.remoteBrowserSessionTabs;
    if (agent) Object.defineProperty(window.navigator, 'userAgent', agent);
    else delete window.navigator.userAgent;
    await pane.unmount();
  }
});

for (const race of [
  {
    name: 'the PC adds a tab while the close is pending: the panel stays',
    strip: [['p1', true]],
    remaining: 1,
    closes: [],
  },
  {
    name: 'the PC removed the other tab before the next frame: the real last tab closes the panel',
    strip: [
      ['p1', true],
      ['p2', false],
    ],
    remaining: 0,
    closes: ['browser'],
  },
]) {
  test(`phone: closing a conversation tab is decided by the host's remaining count (${race.name})`, async () => {
    const state = fakeApi();
    const { PANE_DOCK_CLOSE_EVENT } = await import('./pane-dock-chrome.tsx');
    window.mixdogDesktop.remoteBrowserSessionTabs = true;
    const closes = [];
    const onClose = (event) => closes.push(event.detail.surface);
    window.addEventListener(PANE_DOCK_CLOSE_EVENT, onClose);
    const agent = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
    });
    const pane = await mount({ sessionId: 's', active: true });
    try {
      const tabs = race.strip.map(([id, active]) => ({
        id,
        title: `T ${id}`,
        url: `https://${id}.test/`,
        active,
        loading: false,
        kind: 'page',
      }));
      await act(async () => state.listener(streamFrame({ tabs })));
      await flush();
      // The strip still shows what it showed when the user tapped ×.
      state.closeReply = () => ({ remainingTabs: race.remaining });
      await act(async () => document.querySelector('button[aria-label="Close tab: T p1"]').click());
      await flush();
      assert.deepEqual(closes, race.closes);
    } finally {
      window.removeEventListener(PANE_DOCK_CLOSE_EVENT, onClose);
      delete window.mixdogDesktop.remoteBrowserSessionTabs;
      if (agent) Object.defineProperty(window.navigator, 'userAgent', agent);
      else delete window.navigator.userAgent;
      await pane.unmount();
    }
  });
}

function tabHost(list) {
  const seen = { watch: [], closed: [], log: [] };
  const stream = window.mixdogDesktop.remoteBrowserStream;
  Object.assign(window.mixdogDesktop, {
    remoteBrowserStream: (sessionId, options) => {
      seen.log.push(`stream:${sessionId}:${options ? 'on' : 'off'}`);
      return stream(sessionId, options);
    },
    remoteBrowserTabs: async (watch) => {
      seen.watch.push(watch);
      return list;
    },
    onRemoteBrowserTabs: () => () => {},
    remoteBrowserCloseTab: async (id) => {
      seen.log.push(`close:${id}`);
      seen.closed.push(id);
    },
  });
  return seen;
}

test('closing the streamed tab leaves it for a neighbour and is not restarted after the release', async () => {
  const state = fakeApi();
  const seen = tabHost([
    { id: 'main-browser-a', title: 'Alpha', url: 'https://a.test/', loading: false },
    { id: 'main-browser-b', title: 'Beta', url: 'https://b.test/', loading: false },
    { id: 'main-browser-c', title: 'Gamma', url: 'https://c.test/', loading: false },
  ]);
  const pane = await mount({ sessionId: 'main-browser-a', active: true });
  try {
    await flush();
    // A sibling that is not streamed closes without moving the stream.
    const streamed = state.streams.length;
    await act(async () => document.querySelector('button[aria-label="Close tab: Gamma"]').click());
    await flush();
    assert.deepEqual(seen.closed, ['main-browser-c']);
    assert.equal(state.streams.length, streamed);
    assert.equal(document.querySelectorAll('[role="tab"]').length, 2);

    seen.log.length = 0;
    await act(async () => document.querySelector('button[aria-label="Close tab: Alpha"]').click());
    await flush();
    assert.deepEqual(seen.closed, ['main-browser-c', 'main-browser-a']);
    const release = seen.log.indexOf('close:main-browser-a');
    assert.ok(release >= 0);
    assert.ok(seen.log.includes('stream:main-browser-a:off'));
    assert.ok(!seen.log.slice(release).includes('stream:main-browser-a:on'), 'the released page is not restarted');
    assert.equal(state.streams.at(-1)[0], 'main-browser-b');
    assert.ok(state.streams.at(-1)[1]);
    assert.deepEqual(
      [...document.querySelectorAll('[role="tab"]')].map((tab) => [
        tab.getAttribute('data-page-id'),
        tab.getAttribute('aria-selected'),
      ]),
      [['main-browser-b', 'true']]
    );
    // A frame for the released page no longer reaches this client.
    await act(async () => state.listener(streamFrame({ sessionId: 'main-browser-a', seq: 7 })));
    await flush();
    assert.ok(!state.acks.some(([id]) => id === 'main-browser-a'));
  } finally {
    await pane.unmount();
  }
});

test('closing the only tab asks the side panel to close and keeps the host page; a non-last close does not', async () => {
  fakeApi();
  const seen = tabHost([
    { id: 'main-browser-a', title: 'Alpha', url: 'https://a.test/', loading: false },
    { id: 'main-browser-b', title: 'Beta', url: 'https://b.test/', loading: false },
  ]);
  const requests = [];
  const onClose = (event) => requests.push(event.detail.surface);
  window.addEventListener('mixdog:pane-dock-close', onClose);
  const pane = await mount({ sessionId: 'main-browser-a', active: true });
  try {
    await flush();
    await act(async () => document.querySelector('button[aria-label="Close tab: Beta"]').click());
    await flush();
    assert.deepEqual(seen.closed, ['main-browser-b']);
    assert.deepEqual(requests, []);
    await act(async () => document.querySelector('button[aria-label="Close tab: Alpha"]').click());
    await flush();
    assert.deepEqual(requests, ['browser']);
    assert.deepEqual(seen.closed, ['main-browser-b']);
  } finally {
    window.removeEventListener('mixdog:pane-dock-close', onClose);
    await pane.unmount();
  }
});

test('panes share one host-side tab watch that stops with the last pane', async () => {
  fakeApi();
  const seen = tabHost([{ id: 'main-browser-a', title: 'Alpha', url: 'https://a.test/', loading: false }]);
  const first = await mount({ sessionId: 'main-browser-a', active: true });
  const second = await mount({ sessionId: 'main-browser-b', active: true });
  try {
    await flush();
    assert.deepEqual(seen.watch, [true, true]);
    await first.unmount();
    assert.deepEqual(seen.watch, [true, true]);
    await second.rerender({ sessionId: 'main-browser-b', active: false });
    assert.deepEqual(seen.watch, [true, true, false]);
    await second.rerender({ sessionId: 'main-browser-b', active: true });
    await flush();
    assert.deepEqual(seen.watch, [true, true, false, true]);
  } finally {
    await first.unmount().catch(() => {});
    await second.unmount();
  }
  assert.deepEqual(seen.watch, [true, true, false, true, false]);
});

test('off the phone the remote pane keeps its own layout: no header row, keyboard + ⋯ in the toolbar', async () => {
  fakeApi();
  const pane = await mount({ sessionId: 'main-browser-a', active: true });
  try {
    await flush();
    // The phone sheet's PC-style header row and its ⋯-folded controls are phone-only.
    assert.equal(document.querySelector('.dock-header-row'), null);
    assert.equal(document.querySelector('.browser-pane-popup-tabs'), null);
    const toolbar = document.querySelector('.browser-pane-toolbar');
    assert.ok(toolbar.querySelector('.browser-remote-keyboard-button'), 'keyboard button stays in the toolbar');
    assert.equal(toolbar.querySelector('.browser-pane-import-button'), null);
  } finally {
    await pane.unmount();
  }
});
test('a chat link opened before and while the pane is mounted navigates the host page', async () => {
  const state = fakeApi();
  const { requestBrowserPage } = await import('./browser-page-request.ts');
  const url = 'https://github.com/tribgames/mixdog/issues/new?title=x';
  // The tap reveals the pane in the same press: the address arrives first.
  requestBrowserPage('link-session', url);
  const pane = await mount({ sessionId: 'link-session', active: true });
  try {
    await flush();
    const navigations = () =>
      state.controls
        .filter(({ input }) => input.type === 'navigate')
        .map(({ sessionId, input }) => [sessionId, input.url]);
    assert.deepEqual(navigations(), [['link-session', url]]);
    assert.equal(document.querySelector('.browser-pane-address').value, url);

    // A second link while the pane is open, and a remount, never replay the first.
    await act(async () => requestBrowserPage('link-session', 'https://example.test/next'));
    await flush();
    assert.deepEqual(navigations().at(-1), ['link-session', 'https://example.test/next']);
    await pane.rerender({ sessionId: 'link-session', active: false });
    await pane.rerender({ sessionId: 'link-session', active: true });
    await flush();
    assert.equal(navigations().length, 2);
  } finally {
    await pane.unmount();
  }
});

test('the default layout never sends a viewport control: renewals carry only the frame bound', async () => {
  const state = fakeApi();
  let box = { width: 390, height: 700 };
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function boundingRect() {
    if (!this.classList.contains('browser-remote-content')) return original.call(this);
    return { left: 0, top: 0, x: 0, y: 0, right: box.width, bottom: box.height, ...box, toJSON() {} };
  };
  const viewports = () => state.controls.filter(({ input }) => input.type === 'viewport');
  try {
    for (const drive of [false, true]) {
      if (drive) window.mixdogDesktop.remoteBrowserDrive = true;
      const pane = await mount();
      await flush();
      box = { width: 700, height: 390 };
      await act(async () => {
        window.dispatchEvent(new window.Event('orientationchange'));
        window.dispatchEvent(new window.Event('resize'));
      });
      await act(async () => wait(STREAM_RENEW_MS));
      await act(async () => state.renew());
      await flush();
      assert.deepEqual(viewports(), [], drive ? 'a browserDrive host is not driven' : 'an older host neither');
      assert.ok(
        state.streams.every(([, options]) => !options || !('fit' in options)),
        'and nothing is fitted'
      );
      assert.deepEqual(state.streams.at(-1)[1], { maxWidth: 700, maxHeight: 390 });
      await pane.unmount();
      box = { width: 390, height: 700 };
    }
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = original;
  }
});

test('a leave confirmation on the page is shown over it and answered for its document', async () => {
  const state = fakeApi();
  const pane = await mount();
  try {
    const content = await showFrame(state);
    const leaving = { id: 'leave_1', type: 'beforeunload', message: '' };
    await act(async () => state.listener(streamFrame({ seq: 2, image: undefined, dialog: leaving })));
    await flush();
    const card = document.querySelector('.browser-page-prompt');
    assert.ok(card, 'the card is shown');
    assert.match(card.textContent, /Leave site\?/);
    assert.equal(content.contains(card), false, 'never inside the input surface, so a tap on it is not page input');

    const buttons = () => [...document.querySelectorAll('.browser-page-prompt button')];
    await act(async () =>
      buttons()
        .find((button) => button.textContent === 'Leave')
        .click()
    );
    await flush();
    const answers = () => state.controls.filter(({ input }) => input.type === 'answer-dialog');
    assert.deepEqual(answers().at(-1), {
      sessionId: 's',
      input: { type: 'answer-dialog', requestId: 'leave_1', accept: true, promptText: '', documentId: 'd1' },
    });
    assert.equal(
      state.controls.filter(({ input }) => input.type === 'pointer').length,
      0,
      'answering sent nothing to the page'
    );

    // A new question is a new card; staying answers it so.
    await act(async () =>
      state.listener(streamFrame({ seq: 3, image: undefined, dialog: { ...leaving, id: 'leave_2' } }))
    );
    await flush();
    await act(async () =>
      buttons()
        .find((button) => button.textContent === 'Cancel')
        .click()
    );
    await flush();
    assert.deepEqual(answers().at(-1).input, {
      type: 'answer-dialog',
      requestId: 'leave_2',
      accept: false,
      documentId: 'd1',
    });

    // Once the host stops offering it, the card goes.
    await act(async () => state.listener(streamFrame({ seq: 4, image: undefined })));
    await flush();
    assert.equal(document.querySelector('.browser-page-prompt'), null);
  } finally {
    await pane.unmount();
  }
});

test('on a narrow screen the More menu always exists and carries Open in system browser', async () => {
  const state = fakeApi();
  const opened = [];
  window.mixdogDesktop.openExternal = async (url) => opened.push(url);
  window.matchMedia = (query) => ({
    matches: query.includes('max-width: 640px'),
    addEventListener() {},
    removeEventListener() {},
  });
  const pane = await mount({ sessionId: 's', active: true });
  try {
    await showFrame(state);
    await flush();
    assert.equal(document.querySelector('button[aria-label="Open in system browser"]'), null);
    const menu = document.querySelector('[aria-label="More actions"]');
    assert.ok(menu, 'the overflow menu exists without credentials or import');
    await act(async () => menu.click());
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
      /Open in system browser/.test(node.textContent)
    );
    assert.ok(item);
    await act(async () => item.click());
    assert.deepEqual(opened, ['https://example.test/']);
  } finally {
    delete window.matchMedia;
    await pane.unmount();
  }
});

test('stored-login suggestions come from the host and filling names only the credential id', async () => {
  const state = fakeApi();
  const filled = [];
  Object.assign(window.mixdogDesktop, {
    browserCredentialSuggestions: async () => [{ id: 'c'.repeat(24), label: 'alice@example.com' }],
    browserCredentialFill: async (sessionId, credentialId) => {
      filled.push([sessionId, credentialId]);
      return { usernameFilled: true, passwordFilled: true };
    },
  });
  const pane = await mount({ sessionId: 's', active: true });
  try {
    await showFrame(state);
    await flush();
    const menu = document.querySelector('[aria-label="More actions"]');
    assert.ok(menu, 'the overflow menu appears once a suggestion exists');
    await act(async () => menu.click());
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
      /stored credentials/.test(node.textContent)
    );
    await act(async () => item.click());
    await flush();
    assert.deepEqual(filled, [['s', 'c'.repeat(24)]]);
  } finally {
    await pane.unmount();
  }
});
