import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserRemoteControl } from './remote-control.ts';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const changes = [];
  const guest = {
    id: 1,
    isDestroyed: () => false,
    getURL: () => 'https://example.test/',
    getTitle: () => 'Example',
    isLoadingMainFrame: () => false,
    getZoomFactor: () => 1,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  const remote = createBrowserRemoteControl({
    state: new BrowserGuestStateStore(),
    cdp: { waitForInitialDocument: async () => {} },
    ensureGuest: async () => guest,
    captureScreenshot: async () => ({ data: 'pixels', width: 10, height: 20, mimeType: 'image/jpeg' }),
    viewerChanged: (sessionId, active) => changes.push([sessionId, active]),
  });
  return { remote, changes };
}

test('a polling phone is reported present once and absent only after it stops', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserFrame('s');
  await f.remote.remoteBrowserFrame('s');
  assert.deepEqual(f.changes, [['s', true]], 'continued polling is not a new viewer');
  t.mock.timers.tick(3_000);
  await f.remote.remoteBrowserFrame('s');
  t.mock.timers.tick(3_000);
  assert.deepEqual(f.changes, [['s', true]], 'each frame extends the same presence');
  t.mock.timers.tick(1_000);
  assert.deepEqual(f.changes, [['s', true], ['s', false]]);
  await f.remote.remoteBrowserFrame('s');
  assert.deepEqual(f.changes, [['s', true], ['s', false], ['s', true]]);
});

test('releasing a session forgets its viewer without reporting another change', async (t) => {
  const f = fixture(t);
  await f.remote.remoteBrowserFrame('s');
  f.remote.releaseViewer('s');
  f.remote.releaseViewer('s');
  t.mock.timers.tick(10_000);
  assert.deepEqual(f.changes, [['s', true]]);
});
