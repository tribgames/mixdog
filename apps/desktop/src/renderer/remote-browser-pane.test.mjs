import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'KeyboardEvent', 'CustomEvent', 'navigator'],
});
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
// React's IE input polyfill runs on focus in this jsdom setup and needs these.
window.HTMLElement.prototype.attachEvent = function attachEvent(_name, handler) {
  this.propertyChange = handler;
};
window.HTMLElement.prototype.detachEvent = () => {};

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
    // A dismissed keyboard leaves the field focused: the next tap re-raises it.
    let focused = 0;
    textarea.addEventListener('focus', () => focused++);
    await tap(4);
    assert.equal(focused, 1);

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

const innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const restoreInnerHeight = () => {
  if (innerHeightDescriptor) Object.defineProperty(window, 'innerHeight', innerHeightDescriptor);
  else delete window.innerHeight;
};

test('a browserDrive host gets the content box on start and after a debounced resize; an older host never does', async () => {
  const state = fakeApi();
  let box = { width: 390, height: 700 };
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function boundingRect() {
    if (!this.classList.contains('browser-remote-content')) return original.call(this);
    return { left: 0, top: 0, x: 0, y: 0, right: box.width, bottom: box.height, ...box, toJSON() {} };
  };
  const viewports = () =>
    state.controls.filter(({ input }) => input.type === 'viewport').map(({ sessionId, input }) => [sessionId, input]);
  try {
    const older = await mount();
    await flush();
    const streams = state.streams.length;
    await act(async () => window.dispatchEvent(new window.Event('resize')));
    await act(async () => wait(200));
    assert.deepEqual(viewports(), [], 'an older host never receives the control');
    assert.equal(state.streams.length, streams, 'and keeps renewal-only streaming');
    await older.unmount();

    window.mixdogDesktop.remoteBrowserDrive = true;
    const pane = await mount();
    try {
      await flush();
      assert.deepEqual(viewports(), [['s', { type: 'viewport', width: 390, height: 700, deviceScaleFactor: 1 }]]);
      assert.deepEqual(state.streams.at(-1)[1], { maxWidth: 390, maxHeight: 700 });

      // A rotation lands once, after the burst of resize events settles.
      box = { width: 700, height: 390 };
      await act(async () => {
        window.dispatchEvent(new window.Event('orientationchange'));
        window.dispatchEvent(new window.Event('resize'));
        window.dispatchEvent(new window.Event('resize'));
      });
      await act(async () => wait(50));
      assert.equal(viewports().length, 1, 'debounced');
      await act(async () => wait(200));
      assert.deepEqual(viewports().slice(1), [
        ['s', { type: 'viewport', width: 700, height: 390, deviceScaleFactor: 1 }],
      ]);
      assert.deepEqual(state.streams.at(-1)[1], { maxWidth: 700, maxHeight: 390 });

      // Each renewal restates it, so a host whose lease lapsed is driven again.
      await act(async () => state.renew());
      await flush();
      assert.equal(viewports().length, 3);

      // A desktop window made shorter with a field focused (the address bar,
      // the composer) is a real resize: the page follows it at once.
      const field = document.querySelector('.browser-remote-keyboard textarea');
      const address = document.querySelector('.browser-pane-toolbar input');
      const windowHeight = (height) =>
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
      windowHeight(800);
      await act(async () => state.renew());
      await flush();
      await act(async () => address.focus());
      box = { width: 700, height: 250 };
      windowHeight(660);
      await act(async () => window.dispatchEvent(new window.Event('resize')));
      await act(async () => wait(200));
      assert.deepEqual(viewports().at(-1)[1], { type: 'viewport', width: 700, height: 250, deviceScaleFactor: 1 });
      assert.deepEqual(state.streams.at(-1)[1], { maxWidth: 700, maxHeight: 250 });
      await act(async () => address.blur());
      box = { width: 700, height: 390 };
      windowHeight(800);
      await act(async () => window.dispatchEvent(new window.Event('resize')));
      await act(async () => wait(200));
      assert.deepEqual(viewports().at(-1)[1], { type: 'viewport', width: 700, height: 390, deviceScaleFactor: 1 });
    } finally {
      await pane.unmount();
    }
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = original;
    restoreInnerHeight();
  }
});

test('on a phone the soft keyboard does not resize the driven page; the field letting go does', async () => {
  const state = fakeApi();
  window.mixdogDesktop.remoteBrowserDrive = true;
  let box = { width: 700, height: 390 };
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function boundingRect() {
    if (!this.classList.contains('browser-remote-content')) return original.call(this);
    return { left: 0, top: 0, x: 0, y: 0, right: box.width, bottom: box.height, ...box, toJSON() {} };
  };
  const agent = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  const windowHeight = (height) => Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  windowHeight(800);
  const viewports = () =>
    state.controls.filter(({ input }) => input.type === 'viewport').map(({ input }) => input);
  const pane = await mount();
  try {
    await flush();
    assert.deepEqual(viewports().at(-1), { type: 'viewport', width: 700, height: 390, deviceScaleFactor: 1 });

    // Typing: the soft keyboard only shortens the box; the page keeps its
    // size (no re-layout, no stream restart) until the field lets go.
    const typingFrom = viewports().length;
    const field = document.querySelector('.browser-remote-keyboard textarea');
    await act(async () => field.focus());
    box = { width: 700, height: 200 };
    windowHeight(610);
    await act(async () => window.dispatchEvent(new window.Event('resize')));
    await act(async () => wait(200));
    await act(async () => state.renew());
    await flush();
    assert.ok(viewports().length > typingFrom, 'the renewal restated it');
    assert.ok(
      viewports()
        .slice(typingFrom)
        .every((input) => input.height === 390),
      'never the keyboard-shortened height'
    );
    assert.deepEqual(state.streams.at(-1)[1], { maxWidth: 700, maxHeight: 390 });
    // A real change of width (rotation) still goes through while typing.
    box = { width: 390, height: 200 };
    await act(async () => window.dispatchEvent(new window.Event('resize')));
    await act(async () => wait(200));
    assert.deepEqual(viewports().at(-1), { type: 'viewport', width: 390, height: 200, deviceScaleFactor: 1 });
    // Keyboard down with the field: the box as it is.
    box = { width: 390, height: 700 };
    windowHeight(800);
    await act(async () => field.blur());
    await act(async () => wait(200));
    assert.deepEqual(viewports().at(-1), { type: 'viewport', width: 390, height: 700, deviceScaleFactor: 1 });
  } finally {
    await pane.unmount();
    window.HTMLElement.prototype.getBoundingClientRect = original;
    restoreInnerHeight();
    delete window.mixdogDesktop.remoteBrowserDrive;
    if (agent) Object.defineProperty(window.navigator, 'userAgent', agent);
    else delete window.navigator.userAgent;
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
