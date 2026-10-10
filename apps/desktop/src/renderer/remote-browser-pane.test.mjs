import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'KeyboardEvent', 'navigator'],
});
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

const { default: RemoteBrowserPane } = await import('./RemoteBrowserPane.tsx');
const { createRemoteTouchController } = await import('./remote-browser-touch.ts');

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => act(async () => wait(10));

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
  return {
    root,
    rerender: (next) => act(async () => root.render(React.createElement(RemoteBrowserPane, next))),
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
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

    // Long-press without movement: right click.
    state.controls.length = 0;
    await act(async () => touch('pointerdown', 2, 60, 30));
    await act(async () => wait(560));
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

    // Two-finger pan scrolls instead of clicking.
    state.controls.length = 0;
    await act(async () => {
      touch('pointerdown', 4, 50, 50);
      touch('pointerdown', 5, 150, 50);
      touch('pointermove', 4, 50, 30);
      touch('pointermove', 5, 150, 30);
      touch('pointerup', 4, 50, 30);
      touch('pointerup', 5, 150, 30);
    });
    await flush();
    assert.equal(pointers(state).length, 0);
    const wheels = state.controls.map(({ input }) => input).filter((input) => input.type === 'wheel');
    assert.ok(wheels.length > 0);
    assert.equal(
      wheels.reduce((sum, wheel) => sum + wheel.deltaY, 0),
      20
    );
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
