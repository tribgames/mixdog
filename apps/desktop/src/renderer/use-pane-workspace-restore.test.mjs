import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { window: testWindow } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator'],
});

const { usePaneWorkspaceState } = await import('./use-pane-workspace-restore.ts');
const { navigationKey } = await import('./text-format.ts');

const ELECTRON_UA =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Mixdog/1.0 Chrome/130.0.0.0 Electron/41.0.0 Safari/537.36';
const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const PANE_LAYOUT_KEY = 'mixdog.desktop.pane-layout.v1';

const session = (id) => ({ kind: 'session', id });
const fileTab = { kind: 'file', project: '/p', rel: 'a.ts' };
const leaf = (id, ...tabs) => ({ type: 'leaf', id, tabs, activeKey: navigationKey(tabs[0]) });
// [left | [top / bottom]]: the maintainer's split layout.
const STORED = {
  layout: {
    type: 'split',
    direction: 'row',
    ratio: 0.3,
    first: leaf('left', session('s1')),
    second: {
      type: 'split',
      direction: 'column',
      ratio: 0.6,
      first: leaf('top', session('s2'), fileTab),
      second: leaf('bottom', session('s3')),
    },
  },
  focusedLeafId: 'top',
};
const STORED_TEXT = JSON.stringify(STORED);
const SESSIONS = ['s1', 's2', 's3'].map((id) => ({ id }));
const STORED_SHAPE = ['row', ['session:s1'], ['column', ['session:s2', 'file:/p:a.ts'], ['session:s3']]];
const shape = (node) =>
  node.type === 'leaf'
    ? node.tabs.map((tab) => navigationKey(tab))
    : [node.direction, shape(node.first), shape(node.second)];

const pause = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

/** A desktop bridge: the file copy, the catalog, and what the renderer reported. */
function bridge({ file = null, catalog = SESSIONS } = {}) {
  const calls = { fileReads: 0, fileWrites: [], diagnostics: [] };
  const api = {
    catalog,
    listeners: new Set(),
    readPaneLayoutFile: () => {
      calls.fileReads += 1;
      return file;
    },
    writePaneLayoutFile: (layout) => calls.fileWrites.push(layout),
    listSessions: async () => {
      if (!api.catalog) throw new Error('daemon offline');
      return api.catalog;
    },
    subscribeSessions: (listener) => {
      api.listeners.add(listener);
      return () => api.listeners.delete(listener);
    },
    rendererDiagnostic: (diagnostic) => calls.diagnostics.push(diagnostic),
    pushSessions: async () => {
      await act(async () => {
        for (const listener of [...api.listeners]) listener(api.catalog ?? []);
      });
      await pause();
    },
  };
  return { api, calls };
}

async function mount(t, { ua = ELECTRON_UA, local = null, desktop }) {
  Object.defineProperty(testWindow.navigator, 'userAgent', { configurable: true, get: () => ua });
  testWindow.localStorage.clear();
  if (local !== null) testWindow.localStorage.setItem(PANE_LAYOUT_KEY, local);
  testWindow.mixdogDesktop = desktop;
  const renders = [];
  function Harness() {
    const workspace = usePaneWorkspaceState(null);
    renders.push(workspace);
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  await pause();
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    host.remove();
    delete testWindow.mixdogDesktop;
  };
  t.after(unmount);
  const current = () => renders.at(-1);
  const pageHide = () => act(async () => void testWindow.dispatchEvent(new testWindow.Event('pagehide')));
  return { renders, current, pageHide, unmount };
}

test('localStorage empty + file present: the stored split tree restores from the file', async (t) => {
  const { api, calls } = bridge({ file: STORED_TEXT });
  const { renders, current } = await mount(t, { desktop: api });
  assert.equal(calls.fileReads, 1);
  // First paint already carries the file's geometry, before the catalog answers.
  assert.deepEqual(shape(renders[0].state.layout), STORED_SHAPE);
  assert.equal(renders[0].restorePending, true);
  assert.equal(current().restorePending, false);
  assert.deepEqual(shape(current().state.layout), STORED_SHAPE);
  assert.equal(current().state.focusedLeafId, 'top');
  assert.equal(current().restoredFromStorage, true);
});

test('a layout the file holds goes through the same validation as localStorage', async (t) => {
  for (const file of ['not json', '{"layout":{"type":"leaf"}}', '', '{"layout":null}']) {
    const { api } = bridge({ file });
    const { renders, current, unmount } = await mount(t, { desktop: api });
    assert.equal(renders[0].state.layout.tabs[0].kind, 'new', JSON.stringify(file));
    assert.equal(current().restoredFromStorage, false);
    await unmount();
  }
});

test('a valid localStorage layout is the first-paint source: the file is not read', async (t) => {
  const { api, calls } = bridge({ file: JSON.stringify({ layout: leaf('other', fileTab), focusedLeafId: 'other' }) });
  const { current } = await mount(t, { desktop: api, local: STORED_TEXT });
  assert.equal(calls.fileReads, 0);
  assert.deepEqual(shape(current().state.layout), STORED_SHAPE);
});

test('a persisted change reaches the profile file once, on the renderer debounce and the page-hide flush', async (t) => {
  const { api, calls } = bridge({ file: STORED_TEXT });
  const { current, pageHide } = await mount(t, { desktop: api });
  await pageHide();
  assert.deepEqual(calls.fileWrites, [JSON.stringify(current().state)]);
  await pageHide();
  assert.equal(calls.fileWrites.length, 1, 'an unchanged layout sends nothing');

  await act(async () =>
    current().setState((prev) => ({
      ...prev,
      layout: { ...prev.layout, ratio: 0.5 },
    }))
  );
  assert.equal(calls.fileWrites.length, 1, 'the change waits for the debounce');
  await pause(300);
  assert.equal(calls.fileWrites.length, 2);
  assert.equal(calls.fileWrites[1], JSON.stringify(current().state));
  assert.equal(testWindow.localStorage.getItem(PANE_LAYOUT_KEY), calls.fileWrites[1], 'the same JSON as localStorage');
  await pageHide();
  assert.equal(calls.fileWrites.length, 2);
});

test('catalog unavailable at startup: the stored layout is not overwritten, and the session list finishes validation', async (t) => {
  const { api, calls } = bridge({ file: null, catalog: null });
  const { current, pageHide } = await mount(t, { desktop: api, local: STORED_TEXT });

  // The boot cover is not held, and only addressable tabs show.
  assert.equal(current().restorePending, false);
  assert.deepEqual(shape(current().state.layout), ['file:/p:a.ts']);
  // The failure is reported through the renderer's diagnostic channel.
  assert.equal(calls.diagnostics.length, 1);
  assert.equal(calls.diagnostics[0].phase, 'unhandled-rejection');
  assert.equal(calls.diagnostics[0].failureCode, 'pane-catalog-unavailable');

  // Neither the debounce nor a page hide persists the pruned tree.
  await pause(300);
  await pageHide();
  assert.equal(testWindow.localStorage.getItem(PANE_LAYOUT_KEY), STORED_TEXT);
  assert.deepEqual(calls.fileWrites, []);

  // A push while the daemon still cannot answer changes nothing.
  api.listSessions = async () => {
    throw new Error('daemon still starting');
  };
  await api.pushSessions();
  assert.equal(calls.diagnostics.length, 2);
  assert.deepEqual(shape(current().state.layout), ['file:/p:a.ts']);
  await pageHide();
  assert.equal(testWindow.localStorage.getItem(PANE_LAYOUT_KEY), STORED_TEXT);

  // The daemon answers: validation completes and the stored split tree is back.
  api.listSessions = async () => SESSIONS;
  await api.pushSessions();
  assert.deepEqual(shape(current().state.layout), STORED_SHAPE);
  assert.equal(current().state.focusedLeafId, 'top');
  assert.equal(current().restoredFromStorage, true);
  assert.equal(api.listeners.size, 0, 'no longer listening once validated');
  await pageHide();
  assert.deepEqual(calls.fileWrites, [JSON.stringify(current().state)]);
  assert.deepEqual(shape(JSON.parse(testWindow.localStorage.getItem(PANE_LAYOUT_KEY)).layout), STORED_SHAPE);
});

test('a readable catalog drops only the session tabs it does not list', async (t) => {
  const { api } = bridge({ catalog: [{ id: 's2' }] });
  const { current } = await mount(t, { desktop: api, local: STORED_TEXT });
  assert.deepEqual(shape(current().state.layout), ['session:s2', 'file:/p:a.ts']);
  assert.equal(current().restorePending, false);
});

test('the phone surface keeps its behaviour: no file is read, none is written, tabs are not restored', async (t) => {
  const { api, calls } = bridge({ file: STORED_TEXT });
  const { current, pageHide, unmount } = await mount(t, { ua: PHONE_UA, desktop: api, local: STORED_TEXT });
  assert.equal(calls.fileReads, 0);
  assert.equal(current().state.layout.tabs[0].kind, 'new');
  assert.equal(current().restoredFromStorage, false);
  await pageHide();
  await pause(300);
  assert.deepEqual(calls.fileWrites, []);
  // localStorage still follows the live phone tree, as before.
  assert.equal(JSON.parse(testWindow.localStorage.getItem(PANE_LAYOUT_KEY)).layout.tabs[0].kind, 'new');

  await unmount();

  const { api: emptyApi, calls: emptyCalls } = bridge({ file: STORED_TEXT });
  await mount(t, { ua: PHONE_UA, desktop: emptyApi });
  assert.equal(emptyCalls.fileReads, 0, 'not even with localStorage empty');
});
