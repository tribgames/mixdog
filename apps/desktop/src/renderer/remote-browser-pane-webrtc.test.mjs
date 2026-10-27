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
window.HTMLElement.prototype.attachEvent = function attachEvent(_name, handler) {
  this.propertyChange = handler;
};
window.HTMLElement.prototype.detachEvent = () => {};

const { default: RemoteBrowserPane } = await import('./RemoteBrowserPane.tsx');
const { holdBrowserTakeover } = await import('./browser-takeover-input.ts');
const { FIT_WAIT_MS } = await import('./use-remote-browser-stream.ts');

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => act(async () => wait(10));

/** A host serving `browserWebrtc` (on a device without RTCPeerConnection, as
 *  jsdom is: the JPEG view with the host's locked geometry and ordered input). */
function webrtcHostApi({ fit = false } = {}) {
  const state = { streams: [], ordered: [], plain: [], signals: [], acks: [], listener: null, renew: null };
  window.setInterval = (callback) => {
    state.renew = callback;
    return 1;
  };
  window.clearInterval = () => {};
  window.mixdogDesktop = {
    remoteBrowserDrive: true,
    remoteBrowserWebrtc: 1,
    remoteBrowserFit: fit,
    remoteBrowserStream: async (sessionId, options) => {
      state.streams.push([sessionId, options]);
      if (state.fail?.(options)) throw new Error('relay call failed');
    },
    remoteBrowserStreamAck: (sessionId, seq) => state.acks.push(seq),
    onRemoteBrowserFrame: (listener) => {
      state.listener = listener;
      return () => {};
    },
    remoteBrowserControl: async (sessionId, input) => {
      state.plain.push(input);
    },
    remoteBrowserControlOrdered: (sessionId, input, order) => {
      state.ordered.push({ input, order });
      // Replies are slow: nothing may wait for them.
      return new Promise(() => {});
    },
    remoteBrowserWebrtcSignal: async (signal) => {
      state.signals.push(signal);
    },
    onRemoteBrowserWebrtc: () => () => {},
    openExternal: async () => {},
  };
  return state;
}

test('a browserWebrtc host keeps its geometry: no viewport on start or resize, and taps stream without waits', async () => {
  const state = webrtcHostApi();
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function boundingRect() {
    if (this.tagName === 'IMG' || this.classList.contains('browser-remote-content')) {
      return { left: 0, top: 0, x: 0, y: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON() {} };
    }
    return original.call(this);
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(RemoteBrowserPane, { sessionId: 's', active: true })));
    await act(async () =>
      state.listener({
        sessionId: 's',
        seq: 1,
        frameId: 'f',
        documentId: 'p1:0',
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
      })
    );
    await flush();
    await act(async () => window.dispatchEvent(new window.Event('resize')));
    await act(async () => wait(200));
    const viewports = [...state.plain, ...state.ordered.map(({ input }) => input)].filter(
      (input) => input.type === 'viewport'
    );
    assert.deepEqual(viewports, [], 'the page is not re-laid out to the phone');

    const content = document.querySelector('.browser-remote-content');
    content.setPointerCapture = () => {};
    const touch = (type) => {
      const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY: 25 });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      Object.defineProperty(event, 'pointerType', { value: 'touch' });
      content.dispatchEvent(event);
    };
    await act(async () => touch('pointerdown'));
    await act(async () => touch('pointerup'));
    await flush();
    const tap = state.ordered.filter(({ input }) => input.type === 'pointer');
    assert.deepEqual(
      tap.map(({ input, order }) => [input.phase, order.seq]),
      [
        ['mouseMoved', 1],
        ['mousePressed', 2],
        ['mouseReleased', 3],
      ],
      'all three sent though no reply came'
    );
    assert.ok(tap.every(({ order }) => order.run === 1 && order.stream === tap[0].order.stream));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.HTMLElement.prototype.getBoundingClientRect = original;
  }
});

/** A pane on a browserWebrtc host whose content box is `box.current` CSS px at DPR 2. */
async function fitPane({ fit = true } = {}) {
  const state = webrtcHostApi({ fit });
  const box = { current: { width: 390, height: 700 } };
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function boundingRect() {
    if (this.tagName === 'IMG' || this.classList.contains('browser-remote-content')) {
      const { width, height } = box.current;
      return { left: 0, top: 0, x: 0, y: 0, right: width, bottom: height, width, height, toJSON() {} };
    }
    return original.call(this);
  };
  const ratio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
  // The cover's bound is held here, fired by the test (`expireFit`).
  const realTimeout = window.setTimeout;
  const fitTimers = [];
  window.setTimeout = (callback, ms, ...rest) => {
    if (ms !== FIT_WAIT_MS) return realTimeout(callback, ms, ...rest);
    fitTimers.push(callback);
    return 1_000_000 + fitTimers.length;
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const mount = () =>
    act(async () => root.render(React.createElement(RemoteBrowserPane, { sessionId: 's', active: true })));
  const frame = (seq, viewportWidth, viewportHeight, fitSettled = false, extra = {}) =>
    act(async () =>
      state.listener({
        sessionId: 's',
        seq,
        frameId: `f${seq}`,
        documentId: 'p1:0',
        url: 'https://login.example.test/',
        title: 'Sign in',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        width: viewportWidth * 2,
        height: viewportHeight * 2,
        viewportWidth,
        viewportHeight,
        image: { mimeType: 'image/jpeg', data: 'AA==' },
        ...(fitSettled ? { fitSettled: true } : {}),
        ...extra,
      })
    );
  const covered = () => Boolean(document.querySelector('.browser-remote-empty'));
  const shown = () => Boolean(document.querySelector('.browser-remote-content img'));
  const viewports = () =>
    [...state.plain, ...state.ordered.map(({ input }) => input)].filter((input) => input.type === 'viewport');
  return {
    state,
    box,
    mount,
    frame,
    covered,
    shown,
    viewports,
    fitTimers,
    expireFit: () => act(async () => fitTimers.at(-1)()),
    async close() {
      await act(async () => root.unmount());
      host.remove();
      window.setTimeout = realTimeout;
      window.HTMLElement.prototype.getBoundingClientRect = original;
      if (ratio) Object.defineProperty(window, 'devicePixelRatio', ratio);
      else delete window.devicePixelRatio;
    },
  };
}

const opening = { width: 390, height: 700, deviceScaleFactor: 2 };

test('a take-over asks for its fit from the opening box on every renewal; the pane stays covered until a fitted frame', async () => {
  const release = holdBrowserTakeover('s', '');
  const p = await fitPane();
  try {
    await p.mount();
    await flush();
    assert.deepEqual(p.state.streams[0], ['s', { maxWidth: 780, maxHeight: 1400, fit: opening }]);
    assert.ok(p.covered());

    // Another viewer's unfitted stream (the PC pane's geometry) is acknowledged, never shown.
    await p.frame(1, 1280, 720);
    await flush();
    assert.ok(p.covered(), 'still covered');
    assert.equal(p.shown(), false, 'no unfitted frame first');
    assert.deepEqual(p.state.acks, [1], 'acknowledged, so the stream goes on');

    // The keyboard shortens the box: renewals keep the opening box.
    p.box.current = { width: 390, height: 380 };
    await act(async () => p.state.renew());
    await flush();
    assert.deepEqual(p.state.streams.at(-1), ['s', { maxWidth: 780, maxHeight: 1400, fit: opening }]);

    // A phone-sized picture the host did not mark settled is not the fit either.
    await p.frame(2, 375, 700);
    await flush();
    assert.ok(p.covered(), 'only fitSettled uncovers');
    // The settled layout's picture uncovers it.
    await p.frame(3, 375, 700, true);
    await flush();
    assert.equal(p.covered(), false);
    assert.ok(p.shown());
    await act(async () => p.state.renew());
    assert.deepEqual(p.state.streams.at(-1), ['s', { maxWidth: 780, maxHeight: 1400, fit: opening }]);
    assert.deepEqual(p.viewports(), [], 'no viewport control');
  } finally {
    release();
    await p.close();
  }
});

test('watching never asks for a fit and shows the page as it is', async () => {
  const p = await fitPane();
  try {
    await p.mount();
    await flush();
    await p.frame(1, 1280, 720);
    await flush();
    assert.ok(p.shown());
    assert.equal(p.covered(), false);
    await act(async () => p.state.renew());
    assert.ok(p.state.streams.length >= 2);
    assert.ok(p.state.streams.every(([, options]) => !('fit' in options)));
    assert.deepEqual(p.viewports(), []);
  } finally {
    await p.close();
  }
});

test('a takeover that begins while watching fits at once and covers until the fitted page arrives', async () => {
  const p = await fitPane();
  let release = () => {};
  try {
    await p.mount();
    await flush();
    await p.frame(1, 1280, 720);
    await flush();
    assert.ok(p.shown());
    const before = p.state.streams.length;
    await act(async () => {
      release = holdBrowserTakeover('s', 'p1');
    });
    await flush();
    assert.deepEqual(p.state.streams.at(-1), ['s', { maxWidth: 780, maxHeight: 1400, fit: opening }]);
    assert.equal(p.state.streams.length, before + 1, 'without waiting for the renewal');
    assert.ok(p.covered());
    assert.equal(p.shown(), false, 'the unfitted picture is gone');
    await p.frame(2, 1280, 720);
    await flush();
    assert.ok(p.covered(), 'a frame still in flight unfitted is not shown');
    await p.frame(3, 390, 700, true);
    await flush();
    assert.equal(p.covered(), false);
    assert.ok(p.shown());
    assert.deepEqual(p.viewports(), []);
  } finally {
    release();
    await p.close();
  }
});

test('a host without browserFit is watched during a takeover: no fit, no cover', async () => {
  const release = holdBrowserTakeover('s', '');
  const p = await fitPane({ fit: false });
  try {
    await p.mount();
    await flush();
    assert.equal(p.covered(), true, 'only the usual wait for a first frame');
    await p.frame(1, 1280, 720);
    await flush();
    assert.equal(p.covered(), false);
    assert.ok(p.shown(), 'shown without any fitSettled marker');
    await act(async () => p.state.renew());
    assert.ok(p.state.streams.every(([, options]) => !('fit' in options)));
    assert.deepEqual(p.viewports(), []);
  } finally {
    release();
    await p.close();
  }
});

test('fitFailed ends the wait: the page shows as when watching, and stays shown', async () => {
  const release = holdBrowserTakeover('s', '');
  const p = await fitPane();
  try {
    await p.mount();
    await flush();
    assert.ok(p.covered());
    await p.frame(1, 1280, 720, false, { fitFailed: true });
    await flush();
    assert.equal(p.covered(), false);
    assert.ok(p.shown(), 'the page as it is');
    await p.frame(2, 1280, 720, false, { fitFailed: true });
    await flush();
    assert.ok(p.shown());
    // Renewals go on as they were (the host ignores a repeated fit); no re-cover.
    await act(async () => p.state.renew());
    await flush();
    assert.equal(p.covered(), false);
  } finally {
    release();
    await p.close();
  }
});

test('the take-over ending returns the view to watching: one fit:null renewal, then no fit, unfitted frames shown', async () => {
  let release = holdBrowserTakeover('s', '');
  const p = await fitPane();
  try {
    await p.mount();
    await flush();
    await p.frame(1, 390, 700, true);
    await flush();
    assert.ok(p.shown());
    const before = p.state.streams.length;
    await act(async () => {
      release();
      release = () => {};
    });
    await flush();
    assert.equal(p.state.streams.length, before + 1, 'at once');
    // Omitting `fit` keeps a take-over: the ending renewal says so explicitly.
    assert.equal(p.state.streams.at(-1)[1].fit, null);
    assert.ok('fit' in p.state.streams.at(-1)[1]);
    // Later renewals leave it out.
    await act(async () => p.state.renew());
    await act(async () => p.state.renew());
    assert.equal(p.state.streams.length, before + 3);
    assert.ok(p.state.streams.slice(before + 1).every(([, options]) => !('fit' in options)));
    // The host restores the page: its next (unmarked) frames are shown.
    await p.frame(2, 1280, 720);
    await flush();
    assert.equal(p.covered(), false);
    assert.ok(p.shown());
  } finally {
    release();
    await p.close();
  }
});

const releases = (streams) => streams.filter(([, options]) => 'fit' in options && options.fit === null).length;

test('a release whose call fails is sent again on the next renewal, until one succeeds', async () => {
  let release = holdBrowserTakeover('s', '');
  const p = await fitPane();
  try {
    await p.mount();
    await flush();
    await p.frame(1, 390, 700, true);
    await flush();
    let failures = 1;
    p.state.fail = (options) => options.fit === null && failures-- > 0;
    const before = p.state.streams.length;
    await act(async () => {
      release();
      release = () => {};
    });
    await flush();
    assert.equal(releases(p.state.streams.slice(before)), 1, 'sent at once, and it failed');
    await act(async () => p.state.renew());
    await flush();
    assert.equal(p.state.streams.at(-1)[1].fit, null, 'resent: the take-over may still hold');
    assert.equal(releases(p.state.streams.slice(before)), 2);
    // That one succeeded: later renewals leave fit out.
    await act(async () => p.state.renew());
    await act(async () => p.state.renew());
    assert.ok(p.state.streams.slice(-2).every(([, options]) => !('fit' in options)));
  } finally {
    release();
    await p.close();
  }
});

test('a pending release survives a disconnect: resent after reconnect; dropped only for a host without browserFit', async () => {
  const { REMOTE_CONNECTION_READY_EVENT } = await import('./use-remote-browser-stream.ts');
  for (const reconnectFit of [true, false]) {
    let release = holdBrowserTakeover('s', '');
    const p = await fitPane();
    try {
      await p.mount();
      await flush();
      await p.frame(1, 390, 700, true);
      await flush();
      // The release is rejected…
      p.state.fail = () => true;
      await act(async () => {
        release();
        release = () => {};
      });
      await flush();
      assert.equal(p.state.streams.at(-1)[1].fit, null);
      // …a renewal runs while disconnected (no host: capability unknown)…
      window.mixdogDesktop.remoteBrowserFit = null;
      await act(async () => p.state.renew());
      await flush();
      assert.equal(p.state.streams.at(-1)[1].fit, null, 'still pending while unknown');
      // …then the socket reconnects.
      p.state.fail = null;
      window.mixdogDesktop.remoteBrowserFit = reconnectFit;
      const before = p.state.streams.length;
      await act(async () => window.dispatchEvent(new window.Event(REMOTE_CONNECTION_READY_EVENT)));
      await flush();
      assert.equal(p.state.streams.length, before + 1, 'renewed on reconnect');
      if (reconnectFit) {
        assert.equal(p.state.streams.at(-1)[1].fit, null, 'resent to the host that may still be fitted');
        await act(async () => p.state.renew());
        assert.ok(!('fit' in p.state.streams.at(-1)[1]), 'confirmed: no more releases');
      } else {
        assert.ok(!('fit' in p.state.streams.at(-1)[1]), 'a host without browserFit has nothing to release');
      }
    } finally {
      release();
      await p.close();
    }
  }
});

test('a fit that neither settles nor fails within FIT_WAIT_MS is given up: uncovered, released, never asked again', async () => {
  const release = holdBrowserTakeover('s', '');
  const p = await fitPane();
  try {
    await p.mount();
    await flush();
    assert.ok(p.covered());
    await p.frame(1, 1280, 720);
    await flush();
    assert.ok(p.covered(), 'still within the bound');
    assert.equal(p.fitTimers.length, 1, 'one bound armed');
    const before = p.state.streams.length;
    await p.expireFit();
    await flush();
    assert.equal(p.state.streams.length, before + 1, 'the host is told at once');
    assert.equal(p.state.streams.at(-1)[1].fit, null);
    // Watching: the next unmarked frame is shown (the one before was dropped
    // unseen); the takeover still waits, but no new fit or cover.
    await p.frame(2, 1280, 720);
    await flush();
    assert.equal(p.covered(), false);
    assert.ok(p.shown());
    await act(async () => p.state.renew());
    await flush();
    assert.ok(!('fit' in p.state.streams.at(-1)[1]));
    assert.equal(p.covered(), false);
  } finally {
    release();
    await p.close();
  }
});

test('a take-over cancelled while hidden resumes watching: frames shown, the fit released', async () => {
  let release = holdBrowserTakeover('s', '');
  const p = await fitPane();
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const setVisibility = (state) =>
    act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new window.Event('visibilitychange'));
    });
  try {
    await p.mount();
    await flush();
    assert.ok(p.covered(), 'waiting for the fit');
    await setVisibility('hidden');
    assert.deepEqual(p.state.streams.at(-1), ['s', null], 'the stream ends while hidden');
    await act(async () => {
      release();
      release = () => {};
    });
    const before = p.state.streams.length;
    await setVisibility('visible');
    await flush();
    assert.equal(p.state.streams.at(before)[1].fit, null, 'the resumed stream releases the fit');
    assert.equal(p.covered(), true, 'only the usual wait for a first frame');
    await p.frame(1, 1280, 720);
    await flush();
    assert.equal(p.covered(), false);
    assert.ok(p.shown(), 'an unmarked frame is shown: no fit is awaited');
  } finally {
    release();
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else delete document.visibilityState;
    await p.close();
  }
});

test('regression: after a relay drop the stream renewal and the unmount never throw', async () => {
  for (const drop of [
    // The member is gone with the host.
    (api) => {
      api.remoteBrowserStream = undefined;
    },
    // Or the call itself throws.
    (api) => {
      api.remoteBrowserStream = () => {
        throw new TypeError('no relay');
      };
    },
  ]) {
    const state = webrtcHostApi();
    const host = document.createElement('main');
    document.body.append(host);
    const uncaught = [];
    const root = createRoot(host, { onUncaughtError: (error) => uncaught.push(error) });
    try {
      await act(async () => root.render(React.createElement(RemoteBrowserPane, { sessionId: 's', active: true })));
      await flush();
      assert.equal(state.streams.length, 1, 'streaming');
      drop(window.mixdogDesktop);
      await act(async () => state.renew());
      await flush();
      await act(async () => root.unmount());
      await flush();
      assert.deepEqual(uncaught, [], 'nothing escaped the cleanup');
    } finally {
      host.remove();
    }
  }
});
