/**
 * The visualize and file methods through two routes: each step runs through
 * the loopback bridge over HTTP (and the window-process request handlers'
 * direct calls) and through the `host/*` handler, and the results
 * must be equal; the outcome of each step (admitted or refused) is also stated here.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFileSnapshotService } from '../file-snapshot.ts';
import { VisualizeBridgeServer } from '../visualize/bridge-server.ts';
import { createVisualizeService } from '../visualize/service.ts';
import { registerFilesHost } from './files.ts';
import { createVisualizeHost } from './visualize.ts';
import { HOST_CAPABILITIES } from './connection.ts';

function handlers() {
  const table = new Map();
  const sent = [];
  const connection = {
    request: async (method, params) => {
      sent.push([method, params]);
      return {};
    },
    notify() {},
    sendBinary() {},
    handleRequest: (method, handler) => table.set(method, handler),
    handleNotification() {},
    servedMethods: () => [],
    onClose() {},
  };
  return { connection, sent, call: (method, params) => table.get(method)(params, new AbortController().signal) };
}

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-host-twin-')));
  const cwd = join(root, 'project');
  mkdirSync(join(cwd, 'site'), { recursive: true });
  writeFileSync(join(cwd, 'site', 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(cwd, 'site', 'app.css'), 'h1{color:red}');
  writeFileSync(join(cwd, 'notes.txt'), 'text');
  writeFileSync(join(cwd, 'pic.png'), 'png');
  writeFileSync(join(root, 'secret.html'), '<p>outside</p>');
  return { root, cwd };
}

function freshService() {
  const published = [];
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => true,
    async preparePane(target) {
      return `fake://${target.kind}/${target.label}`;
    },
    publish: () => {},
    publishHost: (event) => published.push(event),
    watch: () => () => {},
    capture: async () => Buffer.from('PNGDATA'),
    delay: async () => {},
    reloadDebounceMs: 5,
  });
  return { service, published };
}

test('host/visualize/command equals the loopback bridge on every step', async () => {
  const { root, cwd } = workspace();
  const nodeSide = freshService();
  const hostSide = freshService();
  const dataDirectory = mkdtempSync(join(tmpdir(), 'mixdog-host-twin-bridge-'));
  const { promise: ready, resolve } = Promise.withResolvers();
  const bridge = new VisualizeBridgeServer({
    dataDirectory,
    execute: (command) => nodeSide.service.execute(command),
    onReady: resolve,
  });
  const wire = handlers();
  createVisualizeHost(wire.connection, () => ({
    execute: (command) => hostSide.service.execute(command),
    snapshot: () => [],
  }));
  const recorded = [];
  try {
    bridge.start();
    await ready;
    const discovery = JSON.parse(readFileSync(join(dataDirectory, 'visualize-bridge.json'), 'utf8'));
    const viaBridge = async (body) =>
      (
        await fetch(`http://127.0.0.1:${discovery.port}/command`, {
          method: 'POST',
          headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();
    // The bridge answered `{ ...value, ok: true }` or `{ ok: false, error }`; the
    // core applies the same mapping to the host's result or JSON-RPC error.
    const viaHost = async (body) => {
      try {
        return { ...(await wire.call('host/visualize/command', body)), ok: true };
      } catch (error) {
        assert.equal(error.code, -32000);
        return { ok: false, error: error.message };
      }
    };
    const base = { sessionId: 's1', cwd };
    const steps = [
      ['open-page', { ...base, action: 'open', input: { targets: ['site/index.html'] } }],
      ['open-outside-cwd', { ...base, action: 'open', input: { targets: ['../secret.html'] } }],
      ['open-missing', { ...base, action: 'open', input: { targets: ['../missing.html'] } }],
      ['open-too-many', { ...base, action: 'open', input: { targets: ['a', 'b', 'c', 'd'] } }],
      ['unknown-action', { ...base, action: 'zap' }],
      ['bad-session', { ...base, sessionId: '../x', action: 'open' }],
    ];
    for (const [name, body] of steps) {
      const fromNode = await viaBridge(body);
      const fromHost = await viaHost(body);
      assert.deepEqual(fromHost, fromNode, `${name}: host result differs from the bridge`);
      recorded.push({ name, ok: fromNode.ok });
    }
    // The agent tool's `open` takes a supported file anywhere, rooted in its own folder when outside the project (targets.ts
    // `resolveVisualizeTarget`, since 1.4.0; the boundary is pinned in visualize/targets.test.mjs); a missing target, too many targets, an unknown action and a
    // path-shaped session id are refused.
    assert.deepEqual(
      recorded.map((r) => [r.name, r.ok]),
      [
        ['open-page', true],
        ['open-outside-cwd', true],
        ['open-missing', false],
        ['open-too-many', false],
        ['unknown-action', false],
        ['bad-session', false],
      ]
    );
    assert.deepEqual(
      hostSide.published.map((e) => e.sessionId),
      nodeSide.published.map((e) => e.sessionId)
    );
  } finally {
    await bridge.stop();
    nodeSide.service.dispose();
    hostSide.service.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('host/capture/fileSnapshot equals the window-process handler', async () => {
  const { root, cwd } = workspace();
  const renders = [];
  // The window process's own service; only the offscreen render is replaced.
  const snapshots = createFileSnapshotService({
    confine: (rootDir, rel) => join(rootDir, rel),
    render: async ({ fileUrl, onlyFile }) => {
      renders.push({ file: fileUrl.split('/').pop(), onlyFile: Boolean(onlyFile) });
      return 'data:image/png;base64,UE5H';
    },
  });
  const todaySnapshot = (a0, a1, a2) => snapshots.capture(String(a0 || ''), String(a1 || ''), a2 === true);
  const wire = handlers();
  registerFilesHost(wire.connection, () => ({
    captureFileSnapshot: (r, rel, grant) => snapshots.capture(r, rel, grant),
  }));
  const outcome = async (run) => {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };
  const recorded = [];
  try {
    const snapshotSteps = [
      ['snapshot-html', [cwd, 'site/index.html', false]],
      ['snapshot-granted-image', [cwd, 'pic.png', true]],
      ['snapshot-unsupported-type', [cwd, 'notes.txt', false]],
      ['snapshot-missing', [cwd, 'gone.html', false]],
    ];
    for (const [name, [r, rel, grant]] of snapshotSteps) {
      const fromNode = await outcome(() => todaySnapshot(r, rel, grant));
      const fromHost = await outcome(() => wire.call('host/capture/fileSnapshot', { root: r, rel, grant }));
      if (fromNode.ok) {
        // The cache returns the same snapshot object for an unchanged file.
        assert.deepEqual(fromHost.value, fromNode.value, `${name}: host result differs`);
      } else {
        assert.equal(fromHost.ok, false, `${name}: host should fail`);
        assert.equal(fromHost.error, fromNode.error, `${name}: host message differs`);
      }
      recorded.push({ name, ok: fromNode.ok, dataUrl: fromNode.ok ? fromNode.value.dataUrl : undefined });
    }
    assert.deepEqual(
      recorded.map((r) => [r.name, r.ok, r.dataUrl]),
      [
        ['snapshot-html', true, 'data:image/png;base64,UE5H'],
        ['snapshot-granted-image', true, 'data:image/png;base64,UE5H'],
        ['snapshot-unsupported-type', false, undefined],
        ['snapshot-missing', false, undefined],
      ]
    );
    assert.ok(renders.length >= 2, 'the renderer ran for supported files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the host declares the visualize and files capabilities it now serves', () => {
  assert.equal(HOST_CAPABILITIES.visualize, true);
  assert.equal(HOST_CAPABILITIES.files, true);
});
