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
const setUserAgent = (value) =>
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => value });

const { navigationKey, newBrowserSelection, browserTabTitle } = await import('./text-format.ts');
const { parsePaneLayout } = await import('./pane-layout-parse.ts');
const { openTabInPaneLeaf, updateTabSelectionInPaneLeaf } = await import('./pane-layout.ts');
const { browserHeaderActions } = await import('./BrowserPane.lazy.tsx');
const { default: BrowserPane } = await import('./BrowserPane.lazy.tsx');
const { WorkspaceTabStrip } = await import('./WorkspaceTabStrip.tsx');
const { useAppTabActions } = await import('./app-root/use-app-tab-actions.ts');
const { requestBrowserInMain } = await import('./browser-main-request.ts');

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => act(async () => wait(120));

test('popup tabs are selectable and closable from the strip without a new-tab button', async () => {
  const { BrowserTabStrip } = await import('./BrowserTabStrip.tsx');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const selected = [];
  const closed = [];
  const tabs = [
    { id: 'page', url: 'https://a.test/', title: 'Page', active: true, loading: false, kind: 'page' },
    { id: 'pop', url: 'https://b.test/', title: 'Login', active: false, loading: false, kind: 'popup' },
  ];
  await act(async () =>
    root.render(
      React.createElement(BrowserTabStrip, {
        tabs,
        onSelect: async (id) => void selected.push(id),
        onClose: async (id) => void closed.push(id),
      })
    )
  );
  assert.equal(host.querySelector('.browser-tab-new'), null);
  await act(async () => host.querySelector('[data-page-id="pop"]').click());
  await act(async () => host.querySelectorAll('.browser-tab-close')[1].click());
  assert.deepEqual(selected, ['pop']);
  assert.deepEqual(closed, ['pop']);
  await act(async () => root.unmount());
  host.remove();
});

test('browser selection has a stable key, persists and restores with the layout', () => {
  const selection = newBrowserSelection('https://example.test/a', 'Example');
  assert.match(selection.id, /^main-browser-[A-Za-z0-9_-]+$/);
  assert.equal(navigationKey(selection), `browser:${selection.id}`);
  assert.notEqual(newBrowserSelection('https://example.test/a').id, selection.id);

  const layout = {
    type: 'leaf',
    id: 'main',
    tabs: [{ kind: 'session', id: 's1' }, selection],
    activeKey: navigationKey(selection),
  };
  assert.deepEqual(parsePaneLayout(JSON.parse(JSON.stringify(layout))), layout);
  // Title is optional; the last URL is what makes the page restorable.
  const bare = { kind: 'browser', id: 'main-browser-x', url: 'https://example.test/' };
  assert.deepEqual(parsePaneLayout({ type: 'leaf', id: 'a', tabs: [bare], activeKey: 'browser:main-browser-x' }).tabs, [
    bare,
  ]);
});

test('a retired id-less browser tab is dropped while a url-less new one is not accepted', () => {
  const parsed = parsePaneLayout({
    type: 'leaf',
    id: 'a',
    tabs: [
      { kind: 'browser', id: 'old' },
      { kind: 'session', id: 's1' },
    ],
    activeKey: 'session:s1',
  });
  assert.deepEqual(parsed.tabs, [{ kind: 'session', id: 's1' }]);
});

test('browser tab title is the page title, falling back to the host', () => {
  assert.equal(
    browserTabTitle({ kind: 'browser', id: 'b', url: 'https://example.test:8080/x', title: 'Docs' }),
    'Docs'
  );
  assert.equal(browserTabTitle({ kind: 'browser', id: 'b', url: 'https://example.test:8080/x' }), 'example.test:8080');
});

test('updating a browser tab keeps its position and the active tab', () => {
  const selection = newBrowserSelection('https://example.test/');
  let root = { type: 'leaf', id: 'a', tabs: [{ kind: 'session', id: 's1' }], activeKey: 'session:s1' };
  root = openTabInPaneLeaf(root, 'a', selection);
  root = openTabInPaneLeaf(root, 'a', { kind: 'session', id: 's1' });
  const next = updateTabSelectionInPaneLeaf(root, 'a', { ...selection, url: 'https://example.test/b', title: 'B' });
  assert.equal(next.activeKey, 'session:s1');
  assert.deepEqual(next.tabs[1], { ...selection, url: 'https://example.test/b', title: 'B' });
});

test('side browser menu offers Open in main tab next to Open in system browser', () => {
  const base = {
    viewportPresetId: 'responsive',
    selectViewportPreset() {},
    credentialSuggestions: [],
    credentialBusy: false,
    credentialStatus: 'idle',
    fillStoredCredential() {},
  };
  let opened = 0;
  const withUrl = browserHeaderActions({ ...base, currentUrl: 'https://example.test/', onOpenInMain: () => opened++ });
  const ids = withUrl.map((action) => action.id);
  assert.equal(ids.indexOf('open-main'), ids.indexOf('open-external') + 1);
  const action = withUrl.find((entry) => entry.id === 'open-main');
  assert.equal(action.label, 'Open in main tab');
  assert.equal(action.disabled, false);
  assert.ok(action.icon);
  action.onSelect();
  assert.equal(opened, 1);
  const blank = browserHeaderActions({ ...base, currentUrl: '', onOpenInMain() {} });
  assert.equal(blank.find((entry) => entry.id === 'open-main').disabled, true);
  const hidden = browserHeaderActions({ ...base, currentUrl: 'https://example.test/' });
  assert.equal(
    hidden.some((entry) => entry.id === 'open-main'),
    false
  );
});

test('tab strip shows a globe icon, the page title and a close control for a browser tab', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const selection = newBrowserSelection('https://example.test/', 'Example page');
  const tab = { key: navigationKey(selection), title: browserTabTitle(selection), selection };
  try {
    await act(async () =>
      root.render(
        React.createElement(WorkspaceTabStrip, {
          tabs: [tab],
          activeKey: tab.key,
          onSelectTab() {},
          onCloseTab() {},
          onReorderTab() {},
          onNewTask() {},
        })
      )
    );
    const node = host.querySelector(`[data-tab-key="${tab.key}"]`);
    assert.ok(node);
    assert.equal(node.querySelector('svg.lucide-globe')?.getAttribute('width'), '15');
    assert.equal(node.querySelector('.workspace-tab-main span').textContent, 'Example page');
    assert.ok(node.querySelector('.workspace-tab-close'));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('Open in main tab request opens a browser tab in the owning pane and folds the side panel', async () => {
  const opened = [];
  const folded = [];
  const focused = [];
  const leaf = { id: 'leaf-1', tabs: [{ kind: 'session', id: 's1' }], activeKey: 'session:s1' };
  const paneWorkspace = {
    leaves: [leaf],
    focusedLeafId: 'leaf-1',
    focusedLeaf: leaf,
    focusLeaf: (id) => focused.push(id),
    openInFocused: (selection) => opened.push(selection),
    splitFocused() {},
  };
  function Harness() {
    useAppTabActions({
      paneWorkspace,
      setTabs() {},
      closeSidebarPanels() {},
      setSessionSideSurface() {},
      paneSideDocks: { select() {}, temporarySelect() {} },
      closePaneRightRegion: (id) => folded.push(id),
      sessionPaneSurfaces: {
        browserSurfaces: new Map(),
        pendingBrowserAutoReveal: { current: new Set() },
        browserAutoRevealSuppressed: { current: new Set() },
      },
      openFileTab() {},
      openSession: async () => {},
      activeProjectPath: '/p',
    });
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    requestBrowserInMain({ sessionId: 's1', url: 'https://example.test/a', title: 'A' });
    assert.deepEqual(folded, ['leaf-1']);
    assert.deepEqual(focused, ['leaf-1']);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].kind, 'browser');
    assert.equal(opened[0].url, 'https://example.test/a');
    assert.equal(opened[0].title, 'A');
    // A session that no pane shows has nowhere to open the tab.
    requestBrowserInMain({ sessionId: 'other', url: 'https://example.test/' });
    assert.equal(opened.length, 1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

function frame(overrides = {}) {
  return {
    sessionId: 'p',
    seq: 1,
    frameId: 'f1',
    documentId: 'd1',
    webContentsId: 7,
    url: 'https://example.test/page',
    title: 'Page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    width: 100,
    height: 50,
    viewportWidth: 100,
    viewportHeight: 50,
    tabs: [{ id: 't', title: 'Page', url: 'https://example.test/page', active: true, loading: false, kind: 'page' }],
    ...overrides,
  };
}

function publish(pageFrame, next) {
  pageFrame.current = next;
  for (const resolve of pageFrame.waiters.splice(0)) resolve();
}

async function mountPane(props, pageFrame) {
  const controls = [];
  window.mixdogDesktop = {
    browserPageFrame: async () => {
      while (!pageFrame.current) await new Promise((resolve) => pageFrame.waiters.push(resolve));
      return pageFrame.current;
    },
    browserPageMetadata: async () => pageFrame.current,
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
      React.createElement(BrowserPane, { active: true, foreground: true, focusAddressOnActivate: false, ...props })
    )
  );
  return {
    host,
    controls,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('main browser tab renders the nav row with a ⋯ menu and no dock header or footer', async () => {
  setUserAgent('Mozilla/5.0 Electron/30');
  const pageFrame = { current: frame() };
  const view = await mountPane(
    { sessionId: 'main-browser-a', mode: 'main', initialUrl: 'https://example.test/page' },
    pageFrame
  );
  try {
    await flush();
    await flush();
    assert.equal(view.host.querySelector('[data-dock-header]'), null);
    assert.equal(view.host.querySelector('.pane-footer-slot'), null);
    const toolbar = view.host.querySelector('.browser-pane-toolbar');
    assert.ok(toolbar);
    assert.ok(toolbar.querySelector('input'));
    const more = toolbar.querySelector('.dock-header-more');
    assert.ok(more, 'device view and system browser live in a ⋯ at the end of the nav row');
    assert.equal(toolbar.lastElementChild.contains(more), true);
    await act(async () => more.click());
    // The ⋯ menu is portalled to the document body.
    const labels = [...toolbar.ownerDocument.querySelectorAll('.dock-header-menu [role="menuitem"]')].map(
      (item) => item.textContent
    );
    assert.ok(labels.includes('Device view'));
    assert.ok(labels.includes('Open in system browser'));
    assert.equal(labels.includes('Open in main tab'), false);
    assert.ok(view.host.querySelector('.browser-zoom-pill'));
  } finally {
    await view.unmount();
  }
});

test('side browser shows a ⋯ with Open in main tab on desktop and hides it on phone/remote', async () => {
  setUserAgent('Mozilla/5.0 Electron/30');
  let view = await mountPane({ sessionId: 'conv-1' }, { current: frame() });
  try {
    await flush();
    await flush();
    assert.ok(view.host.querySelector('[data-dock-header]'));
    await act(async () => view.host.querySelector('.dock-header-more').click());
    const item = [...view.host.ownerDocument.querySelectorAll('.dock-header-menu [role="menuitem"]')].find(
      (entry) => entry.textContent === 'Open in main tab'
    );
    assert.ok(item);
    assert.equal(item.disabled, false);
  } finally {
    await view.unmount();
  }
  setUserAgent('Mozilla/5.0 (iPhone) AppleWebKit Mobile Safari');
  view = await mountPane({ sessionId: 'conv-1' }, { current: frame() });
  try {
    await flush();
    assert.equal(view.host.textContent.includes('Open in main tab'), false);
  } finally {
    await view.unmount();
  }
});

test('loading placeholder covers the surface until the first paint, then gives way', async () => {
  setUserAgent('Mozilla/5.0 Electron/30');
  const pageFrame = { current: null, waiters: [] };
  const view = await mountPane(
    { sessionId: 'main-browser-b', mode: 'main', initialUrl: 'https://example.test/page' },
    pageFrame
  );
  try {
    const placeholder = view.host.querySelector('.browser-pane-loading');
    assert.ok(placeholder, 'shown before the first paint');
    assert.equal(placeholder.querySelector('.progress-spinner') !== null, true);
    assert.equal(placeholder.textContent, 'example.test');
    publish(pageFrame, frame());
    await flush();
    await flush();
    assert.equal(view.host.querySelector('.browser-pane-loading'), null);
  } finally {
    await view.unmount();
  }
});

test('the loading placeholder never outlasts a slow first byte', async () => {
  setUserAgent('Mozilla/5.0 Electron/30');
  const pageFrame = { current: null, waiters: [] };
  const view = await mountPane(
    { sessionId: 'main-browser-slow', mode: 'main', initialUrl: 'https://slow.test/' },
    pageFrame
  );
  try {
    assert.ok(view.host.querySelector('.browser-pane-loading'), 'shown while nothing has arrived');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
    assert.equal(view.host.querySelector('.browser-pane-loading'), null, 'gives way after the fallback beat');
  } finally {
    await view.unmount();
  }
});

test('a load failure replaces the placeholder with the error state', async () => {
  setUserAgent('Mozilla/5.0 Electron/30');
  const pageFrame = { current: null, waiters: [] };
  const view = await mountPane(
    { sessionId: 'main-browser-c', mode: 'main', initialUrl: 'https://down.test/' },
    pageFrame
  );
  try {
    assert.ok(view.host.querySelector('.browser-pane-loading'));
    publish(pageFrame, frame({ url: 'https://down.test/', fault: 'ERR_NAME_NOT_RESOLVED', loading: false }));
    await flush();
    await flush();
    assert.equal(view.host.querySelector('.browser-pane-loading'), null);
    assert.ok(view.host.querySelector('.browser-pane-failure'));
    assert.match(view.host.querySelector('.browser-pane-failure').textContent, /ERR_NAME_NOT_RESOLVED/);
  } finally {
    await view.unmount();
  }
});
