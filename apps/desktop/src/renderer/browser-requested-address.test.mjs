import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { bindRequestedAddress, requestBrowserPage } from './browser-page-request.ts';
import { isAbortedLoad, reportBrowserLoadFailure } from './browser-load-failure.ts';
import { DESKTOP_TOAST_EVENT } from './desktop-toasts.tsx';

function fakeGuest(ready) {
  const listeners = new Set();
  return {
    ready,
    getWebContentsId() {
      if (!this.ready) throw new Error('not attached');
      return 7;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    domReady() {
      this.ready = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

test('an address requested before the pane exists loads once when the guest appears', () => {
  requestBrowserPage('early', 'http://localhost:1/');
  let guest = null;
  const loaded = [];
  const binding = bindRequestedAddress('early', () => guest, (url) => (loaded.push(url), true));
  assert.deepEqual(loaded, []);
  guest = fakeGuest(true);
  binding.sync();
  binding.sync();
  assert.deepEqual(loaded, ['http://localhost:1/']);
  binding.dispose();
  // Settled: a later pane for the session does not replay it.
  const again = [];
  bindRequestedAddress('early', () => guest, (url) => (again.push(url), true)).dispose();
  assert.deepEqual(again, []);
});

test('an address survives a guest element replacement and loads exactly once', () => {
  const first = fakeGuest(false);
  let current = first;
  const loaded = [];
  const binding = bindRequestedAddress('swap', () => current, (url) => (loaded.push(url), true));
  requestBrowserPage('swap', 'http://localhost:2/');
  assert.deepEqual(loaded, []);
  const second = fakeGuest(false);
  current = second;
  binding.sync();
  assert.equal(first.listenerCount(), 0);
  // The old element's dom-ready is gone; the new one's loads it.
  first.domReady();
  assert.deepEqual(loaded, []);
  second.domReady();
  second.domReady();
  assert.deepEqual(loaded, ['http://localhost:2/']);
  binding.dispose();
  assert.equal(second.listenerCount(), 0);
});

test('a load that could not start keeps the address pending; the latest address wins', () => {
  const guest = fakeGuest(true);
  let accept = false;
  const loaded = [];
  const binding = bindRequestedAddress('late', () => guest, (url) => {
    loaded.push(url);
    return accept;
  });
  requestBrowserPage('late', 'http://localhost:3/a');
  requestBrowserPage('late', 'http://localhost:3/b');
  accept = true;
  binding.sync();
  binding.sync();
  assert.deepEqual(loaded, ['http://localhost:3/a', 'http://localhost:3/b', 'http://localhost:3/b']);
  binding.dispose();
});

test('only non-abort load failures toast', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  const toasts = [];
  dom.window.addEventListener(DESKTOP_TOAST_EVENT, (event) => toasts.push(event.detail));
  try {
    assert.equal(isAbortedLoad(new Error("ERR_ABORTED (-3) loading 'http://x/'")), true);
    reportBrowserLoadFailure(Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' }));
    reportBrowserLoadFailure(new Error("ERR_ABORTED (-3) loading 'http://x/'"));
    assert.equal(toasts.length, 0);
    reportBrowserLoadFailure(new Error("ERR_CONNECTION_REFUSED (-102) loading 'http://x/'"));
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].tone, 'error');
    assert.match(toasts[0].text, /Unable to load page: .*ERR_CONNECTION_REFUSED/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete globalThis.window;
    dom.window.close();
  }
});
