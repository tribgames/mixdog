import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './test-support/test-dom.mjs';
const { overrideConfirmAction } = await import('./app-confirm.tsx');

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator', 'Element', 'HTMLElement', 'CustomEvent'],
  actEnvironment: false,
});

const { openMediaAssetFromWindow, openMediaFolderFromWindow } = await import('./studio-pane-media-actions.ts');
const { SERVER_FILE_REVEAL_EVENT } = await import('./server-transfers.tsx');

/** A server window: the asset's original resolves to a server path, which
 *  resolves to a Project entry or a one-file grant. */
function serverWindow(t, { grant = false } = {}) {
  const calls = { local: [], resolved: [], reveals: [], copied: [], confirms: [] };
  const assetPath = grant ? '/root/.mixdog-remote/user-data/media/assets/a.png' : '/srv/repo/media/a.png';
  window.mixdogDesktop = {
    connection: { kind: 'ssh' },
    resolveLocalPaths: async (paths) => {
      calls.resolved.push(...paths);
      return grant
        ? [
            {
              absolutePath: paths[0],
              projectPath: '/root/.mixdog-remote/user-data/media/assets',
              relPath: 'a.png',
              accessToken: 'grant-1',
              dir: false,
            },
          ]
        : [{ absolutePath: paths[0], projectPath: '/srv/repo', relPath: 'media/a.png', dir: false }];
    },
  };
  const api = {
    invokeCapability: async ({ capability, args }) => {
      assert.equal(capability, 'resolveMediaFile');
      assert.deepEqual(args, ['asset-1', { variant: 'original' }]);
      return { value: { available: true, path: assetPath }, snapshot: null };
    },
    openMediaAsset: async (id) => calls.local.push(['open', id]),
    openMediaFolder: async (id) => calls.local.push(['folder', id]),
  };
  overrideConfirmAction((message) => {
    calls.confirms.push(message);
    return false;
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => calls.copied.push(text) },
  });
  const onReveal = (event) => calls.reveals.push(event.detail);
  window.addEventListener(SERVER_FILE_REVEAL_EVENT, onReveal);
  t.after(() => {
    window.removeEventListener(SERVER_FILE_REVEAL_EVENT, onReveal);
    overrideConfirmAction(null);
    delete window.mixdogDesktop;
  });
  return { api, calls, assetPath };
}

test("a server window offers download-and-open for a Studio asset, never this PC's viewer", async (t) => {
  const { api, calls, assetPath } = serverWindow(t);
  await openMediaAssetFromWindow(api, 'asset-1');
  assert.deepEqual(calls.resolved, [assetPath]);
  // It asks before downloading (declined here), and never hands the path to this PC.
  assert.equal(calls.confirms.length, 1);
  assert.match(calls.confirms[0], /a\.png/);
  assert.deepEqual(calls.local, []);
});

test('a server window reveals a Project asset in its Files tree', async (t) => {
  const { api, calls } = serverWindow(t);
  await openMediaFolderFromWindow(api, 'asset-1');
  assert.deepEqual(calls.reveals, [{ project: '/srv/repo', rel: 'media/a.png' }]);
  assert.deepEqual(calls.copied, []);
  assert.deepEqual(calls.local, []);
});

test('a server window copies the server path of an asset outside any Project', async (t) => {
  const { api, calls, assetPath } = serverWindow(t, { grant: true });
  await openMediaFolderFromWindow(api, 'asset-1');
  assert.deepEqual(calls.copied, [assetPath]);
  assert.deepEqual(calls.reveals, []);
  assert.deepEqual(calls.local, []);
});

test("a local window keeps opening Studio assets with this PC's apps", async (t) => {
  const { api, calls } = serverWindow(t);
  window.mixdogDesktop.connection = { kind: 'local' };
  await openMediaAssetFromWindow(api, 'asset-1');
  await openMediaFolderFromWindow(api, 'asset-1');
  assert.deepEqual(calls.local, [
    ['open', 'asset-1'],
    ['folder', 'asset-1'],
  ]);
  assert.deepEqual(calls.resolved, []);
});
