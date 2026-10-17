// A paired device has no file manager, default app or loopback of the PC's:
// its OS actions must not look available and do nothing (#1), and a loopback
// address must reach the PC, not the device itself (#2). The desktop keeps
// its own behaviour; each test pins both sides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { changedFileMenuItems } from './source-control-file-row.tsx';
import { REMOTE_BROWSER_FALLBACKS } from './remote-browser-fallbacks.ts';
import { isLoopbackWebUrl, openRemoteExternalLink } from './remote-external-link.ts';
import { onBrowserPageRevealRequested } from './browser-page-request.ts';

const FILE = { path: 'src/app.ts', status: 'M', staged: false };

function menu(canReveal, canOpenDefault) {
  const calls = [];
  const items = changedFileMenuItems({
    file: FILE,
    busy: false,
    canRevert: true,
    canIgnore: true,
    canReveal,
    canOpenDefault,
    missingChannel: (label) => `${label} needs a newer app`,
    guarded: (action) => action(),
    onDiscard: () => {},
    onIgnore: () => {},
    onCopyFilePath: () => {},
    onCopyRelativePath: () => {},
    onReveal: () => calls.push('reveal'),
    onOpenDefault: () => calls.push('open-default'),
  });
  return { items, calls, byId: (id) => items.find((item) => item.id === id) };
}

test('the remote client offers no OS file actions it cannot perform', async () => {
  // Before the fix both were inert stubs, so the menus showed them enabled.
  assert.equal('revealFile' in REMOTE_BROWSER_FALLBACKS, false);
  assert.equal('openFilePath' in REMOTE_BROWSER_FALLBACKS, false);
  const { createRemoteApi } = await import('./remote-shim-api.ts');
  const api = createRemoteApi({ call: async () => undefined });
  assert.equal(api.revealFile, undefined);
  assert.equal(api.openFilePath, undefined);
});

test('Source Control: the device hides "Show in Explorer" and keeps a working open; the desktop keeps both', () => {
  // The paired device: SourceControlDock passes canReveal null and opens by download.
  const remote = menu(null, true);
  assert.equal(remote.byId('reveal'), undefined);
  assert.equal(remote.byId('open-default').disabled, false);
  assert.equal(remote.byId('open-default').separatorBefore, true);
  assert.equal(remote.byId('open-default').label, 'Download / Share');
  assert.equal(menu(true, true).byId('open-default').label, 'Open with default program');
  remote.byId('open-default').onSelect();
  assert.deepEqual(remote.calls, ['open-default']);
  // The desktop: both present and enabled, nothing else differs.
  const desktop = menu(true, true);
  assert.equal(desktop.byId('reveal').disabled, false);
  assert.equal(desktop.byId('open-default').disabled, false);
  assert.deepEqual(
    desktop.items.map((item) => item.id).filter((id) => id !== 'reveal'),
    remote.items.map((item) => item.id)
  );
  // A desktop app too old for the channel still shows it, explained.
  assert.match(menu(false, false).byId('reveal').title, /needs a newer app/);
});

test('loopback addresses are recognized as the PC’s own', () => {
  for (const url of [
    'http://localhost:5173/',
    'http://app.localhost:3000',
    'http://127.0.0.1:8080/x',
    'https://127.4.5.6/',
    'http://[::1]:9000/',
    'http://0.0.0.0:4000',
  ]) {
    assert.equal(isLoopbackWebUrl(url), true, url);
  }
  for (const url of ['https://example.com/', 'http://192.168.0.2/', 'file:///C:/x', 'mailto:a@b.c', 'not a url']) {
    assert.equal(isLoopbackWebUrl(url), false, url);
  }
});

test('a loopback link opens in the PC’s browser panel, never on the device', async () => {
  const here = [];
  const tabs = [];
  const revealed = [];
  const deps = (sessionId, openHostTab) => ({
    sessionId: () => sessionId,
    ...(openHostTab ? { openHostTab } : {}),
    openHere: async (url) => {
      here.push(url);
    },
  });
  const stop = onBrowserPageRevealRequested((request) => revealed.push(request));
  try {
    // Before the fix this went to window.open on the device.
    await openRemoteExternalLink('http://localhost:5173/', deps('s1'));
    assert.deepEqual(revealed, [{ sessionId: 's1', url: 'http://localhost:5173/' }]);
    // No conversation on screen: a tab in the PC's browser.
    await openRemoteExternalLink(
      'http://127.0.0.1:3000/',
      deps(undefined, async (url) => tabs.push(url))
    );
    assert.deepEqual(tabs, ['http://127.0.0.1:3000/']);
    // Nowhere on the PC to show it: a clear refusal, not the device's browser.
    await assert.rejects(openRemoteExternalLink('http://localhost:1/', deps(undefined)), /on the PC/);
    // Every other address still opens in the device's own browser.
    await openRemoteExternalLink('https://example.com/', deps('s1'));
    assert.deepEqual(here, ['https://example.com/']);
  } finally {
    stop();
  }
});

test('the remote openExternal routes loopback to the PC and the rest to the device', async () => {
  const { createRemoteApi } = await import('./remote-shim-api.ts');
  const opened = [];
  const previousWindow = globalThis.window;
  globalThis.window = new JSDOM('', { url: 'https://relay.test/' }).window;
  window.open = (url) => {
    opened.push(url);
    return null;
  };
  const revealed = [];
  const stop = onBrowserPageRevealRequested((request) => revealed.push(request));
  try {
    const api = createRemoteApi({ call: async () => undefined, lastVisibleSessionIds: ['s9'] });
    await api.openExternal('http://localhost:8000/docs');
    await api.openExternal('https://example.com/');
    assert.deepEqual(revealed, [{ sessionId: 's9', url: 'http://localhost:8000/docs' }]);
    assert.deepEqual(opened, ['https://example.com/']);
  } finally {
    stop();
    globalThis.window = previousWindow;
  }
});
