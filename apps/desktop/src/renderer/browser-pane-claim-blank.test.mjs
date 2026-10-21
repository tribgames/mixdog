import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'KeyboardEvent', 'Event', 'CustomEvent', 'navigator'],
});
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.MutationObserver ??= window.MutationObserver;
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 Electron/30' });

const { default: BrowserPane } = await import('./BrowserPane.lazy.tsx');

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => act(async () => wait(120));

const frame = (url) => ({
  frameId: 'f1',
  documentId: 'd1',
  webContentsId: 7,
  url,
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  width: 100,
  height: 50,
  viewportWidth: 100,
  viewportHeight: 50,
  tabs: [{ id: 'p1', title: '', url, active: true, loading: false, kind: 'page' }],
});

async function mount(url) {
  const controls = [];
  const current = frame(url);
  window.mixdogDesktop = {
    browserPageFrame: async () => current,
    browserPageMetadata: async () => current,
    browserPageControl: async (_id, action) => {
      controls.push(action);
    },
    browserSetActiveGuest: async () => {},
    browserPresentNative: async () => ({ enabled: false, shown: false }),
    openExternal: async () => {},
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(BrowserPane, {
        sessionId: 'conv',
        active: true,
        foreground: true,
        focusAddressOnActivate: true,
      })
    )
  );
  await flush();
  await flush();
  return {
    host,
    controls,
    selects: () => controls.filter((control) => control.type === 'select-tab'),
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const key = () => new window.KeyboardEvent('keydown', { bubbles: true, key: 'a' });
const press = () => new window.Event('pointerdown', { bubbles: true });

test('the pane focusing the blank address bar by itself does not claim the tab; the person typing or clicking does, once', async () => {
  const view = await mount('about:blank');
  try {
    const input = view.host.querySelector('.browser-pane-address');
    await act(async () => input.focus());
    await flush();
    assert.deepEqual(view.selects(), [], 'a programmatic focus is not the person');

    await act(async () => input.dispatchEvent(key()));
    await flush();
    await act(async () => input.dispatchEvent(press()));
    await flush();
    assert.equal(view.selects().length, 1, 'claimed once, not per keystroke');
    const [claim] = view.selects();
    assert.equal(claim.tabId, 'p1');
    assert.equal(claim.follow, undefined, "a plain select is the person's own pick");
  } finally {
    await view.unmount();
  }
});

test('typing in the address bar of a page that already has an address claims nothing', async () => {
  const view = await mount('https://example.test/');
  try {
    const input = view.host.querySelector('.browser-pane-address');
    await act(async () => input.dispatchEvent(key()));
    await flush();
    assert.deepEqual(view.selects(), []);
  } finally {
    await view.unmount();
  }
});
