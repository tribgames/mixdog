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
const { borrowedBrowserTab, clearBorrowedBrowserTab, showBorrowedBrowserTab } = await import(
  './browser-pane-borrowed-tab.ts'
);
const { PANE_DOCK_CLOSE_EVENT } = await import('./pane-dock-chrome.tsx');

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => act(async () => wait(120));

const OWNER_TAB = {
  id: 'p4',
  title: 'OpenDART',
  url: 'https://opendart.example/',
  active: true,
  loading: false,
  kind: 'page',
};

/** The bot conversation `conv` showing task session `task`'s tab p4. */
async function mountBorrowed() {
  const owner = { tabs: [OWNER_TAB] };
  const framed = [];
  let openListener = null;
  window.mixdogDesktop = {
    browserPageFrame: async (sessionId) => {
      framed.push(sessionId);
      return {
        frameId: `f-${owner.tabs.length}`,
        documentId: 'p4:1',
        webContentsId: 7,
        url: OWNER_TAB.url,
        title: OWNER_TAB.title,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        width: 100,
        height: 50,
        viewportWidth: 100,
        viewportHeight: 50,
        tabs: owner.tabs,
      };
    },
    browserPageControl: async () => {},
    browserSetActiveGuest: async () => {},
    browserPresentNative: async () => ({ enabled: false, shown: false }),
    onBrowserOpenRequested: (listener) => {
      openListener = listener;
      return () => {
        openListener = null;
      };
    },
    openExternal: async () => {},
  };
  showBorrowedBrowserTab('conv', { ownerSessionId: 'task', ownerName: '예측', tabId: 'p4' });
  const closes = [];
  const onClose = (event) => closes.push(event.detail);
  window.addEventListener(PANE_DOCK_CLOSE_EVENT, onClose);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(React.createElement(BrowserPane, { sessionId: 'conv', active: true, foreground: true }))
  );
  await flush();
  await flush();
  return {
    host,
    owner,
    framed,
    closes,
    open: (request) => act(async () => openListener?.(request)),
    tabTitle: () => host.querySelector('[role="tab"]')?.textContent ?? null,
    unmount: async () => {
      window.removeEventListener(PANE_DOCK_CLOSE_EVENT, onClose);
      clearBorrowedBrowserTab('conv');
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("closing the owner's last tab closes the borrowed panel", async () => {
  const view = await mountBorrowed();
  try {
    assert.equal(view.tabTitle(), '예측 · OpenDART');
    assert.deepEqual(view.closes, []);
    assert.ok(view.framed.length > 0);
    assert.ok(
      view.framed.every((sessionId) => sessionId === 'task'),
      'the viewer never reads (or makes) a page of its own'
    );
    // The owner closes p4, its last tab: the host now sends an empty list.
    view.owner.tabs = [];
    await flush();
    await flush();
    assert.deepEqual(view.closes, [{ surface: 'browser', sessionId: 'conv' }]);
  } finally {
    await view.unmount();
  }
});

test("a paired client streams the borrowed owner's page, not the viewer's own", async () => {
  const streams = [];
  window.mixdogDesktop = {
    remoteBrowserStream: async (sessionId, options) => {
      streams.push([sessionId, options]);
    },
    remoteBrowserStreamAck() {},
    onRemoteBrowserFrame: () => () => {},
    remoteBrowserControl: async () => {},
    onBrowserOpenRequested: () => () => {},
    openExternal: async () => {},
  };
  showBorrowedBrowserTab('conv', { ownerSessionId: 'task', ownerName: '예측', tabId: 'p4' });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(React.createElement(BrowserPane, { sessionId: 'conv', active: true, foreground: true }))
    );
    await flush();
    const started = streams.filter(([, options]) => options).map(([sessionId]) => sessionId);
    assert.ok(started.length > 0);
    assert.ok(
      started.every((sessionId) => sessionId === 'task'),
      `streamed ${started.join(',')}`
    );
  } finally {
    await act(async () => root.unmount());
    clearBorrowedBrowserTab('conv');
    host.remove();
  }
});

test("a paired client's borrowed tab ✕ only dismisses the view: the child's real tab stays (session tabs on)", async () => {
  const controls = [];
  window.mixdogDesktop = {
    remoteBrowserStream: async () => {},
    remoteBrowserStreamAck() {},
    onRemoteBrowserFrame: () => () => {},
    remoteBrowserSessionTabs: true,
    remoteBrowserControl: async (sessionId, input) => {
      controls.push([sessionId, input.type]);
      return input.type === 'close-tab' ? { remainingTabs: 0 } : undefined;
    },
    onBrowserOpenRequested: () => () => {},
    openExternal: async () => {},
  };
  const agent = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  showBorrowedBrowserTab('conv', { ownerSessionId: 'task', ownerName: '예측', tabId: 'p4' });
  const closes = [];
  const onClose = (event) => closes.push(event.detail);
  window.addEventListener(PANE_DOCK_CLOSE_EVENT, onClose);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(React.createElement(BrowserPane, { sessionId: 'conv', active: true, foreground: true }))
    );
    await flush();
    await act(async () => host.querySelector('.browser-tab-close').click());
    await flush();
    assert.deepEqual(
      controls.filter(([, type]) => type === 'close-tab'),
      [],
      "the child's tab is not closed"
    );
    assert.deepEqual(closes, [{ surface: 'browser', sessionId: 'conv' }]);
  } finally {
    window.removeEventListener(PANE_DOCK_CLOSE_EVENT, onClose);
    if (agent) Object.defineProperty(window.navigator, 'userAgent', agent);
    else delete window.navigator.userAgent;
    await act(async () => root.unmount());
    clearBorrowedBrowserTab('conv');
    host.remove();
  }
});

test("a paired client's borrowed dock closes through the viewer's own dock", async () => {
  const streams = [];
  window.mixdogDesktop = {
    remoteBrowserStream: async (sessionId, options) => {
      streams.push([sessionId, options]);
    },
    remoteBrowserStreamAck() {},
    onRemoteBrowserFrame: () => () => {},
    remoteBrowserControl: async () => {},
    onBrowserOpenRequested: () => () => {},
    openExternal: async () => {},
  };
  const agent = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  showBorrowedBrowserTab('conv', { ownerSessionId: 'task', ownerName: '예측', tabId: 'p4' });
  const closes = [];
  const onClose = (event) => closes.push(event.detail);
  window.addEventListener(PANE_DOCK_CLOSE_EVENT, onClose);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(async () =>
      root.render(React.createElement(BrowserPane, { sessionId: 'conv', active: true, foreground: true }))
    );
  const live = () => streams.filter(([, options]) => options).map(([sessionId]) => sessionId);
  try {
    await render();
    await flush();
    assert.equal(live().at(-1), 'task');
    await act(async () => host.querySelector('.dock-header-close').click());
    // The close is addressed to the viewer's own dock, whose dismissal then
    // drops the borrow (agent-browser-surface-requests.test.mjs).
    assert.deepEqual(closes, [{ surface: 'browser', sessionId: 'conv' }]);
  } finally {
    window.removeEventListener(PANE_DOCK_CLOSE_EVENT, onClose);
    if (agent) Object.defineProperty(window.navigator, 'userAgent', agent);
    else delete window.navigator.userAgent;
    await act(async () => root.unmount());
    clearBorrowedBrowserTab('conv');
    host.remove();
  }
});

test("a failed open keeps the owner's tab on display; a real open takes the panel back", async () => {
  const view = await mountBorrowed();
  try {
    await view.open({ sessionId: 'conv', reveal: true, error: 'navigation to 192.168.0.9 is blocked' });
    await flush();
    assert.deepEqual(borrowedBrowserTab('conv'), { ownerSessionId: 'task', ownerName: '예측', tabId: 'p4' });
    assert.equal(view.tabTitle(), '예측 · OpenDART');
    assert.deepEqual(view.closes, []);

    await view.open({ sessionId: 'conv', reveal: true, tabId: 'p9', title: 'Own page' });
    assert.equal(borrowedBrowserTab('conv'), null);
  } finally {
    await view.unmount();
  }
});
