/**
 * Golden twin for the visualize and file methods: each step runs through
 * today's Node path (the loopback bridge over HTTP; the window-process request
 * handlers' direct calls) and through the new `host/*` handler, and the results
 * must be equal. The Node-path results are the recorded corpus
 * (`native/core/fixtures/desktop-host/visualize-files-golden.json`); the test
 * fails when they drift from the file, and rewrites it with MIXDOG_GOLDEN_WRITE=1.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createFileSnapshotService } from '../file-snapshot.ts';
import { VisualizeBridgeServer } from '../visualize/bridge-server.ts';
import { createVisualizeService } from '../visualize/service.ts';
import { registerFilesHost } from './files.ts';
import { createVisualizeHost } from './visualize.ts';
import { HOST_CAPABILITIES } from './connection.ts';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '../../../../../native/core/fixtures/desktop-host/visualize-files-golden.json');

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

// The workspace root (parent of the project) varies per run; the project folder is `<CWD>`.
const strip = (value, cwd) => {
  const escaped = (path) => path.replaceAll('\\', '\\\\');
  return JSON.parse(
    JSON.stringify(value).split(escaped(cwd)).join('<CWD>').split(escaped(dirname(cwd))).join('<ROOT>')
  );
};

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
      recorded.push({ name, request: strip(body, cwd), result: strip(fromNode, cwd) });
    }
    assert.equal(recorded[0].result.ok, true);
    assert.equal(recorded[2].result.ok, false);
    assert.deepEqual(hostSide.published.map((e) => e.sessionId), nodeSide.published.map((e) => e.sessionId));
  } finally {
    await bridge.stop();
    nodeSide.service.dispose();
    hostSide.service.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDirectory, { recursive: true, force: true });
  }
  verifyCorpus('visualize', recorded);
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
      recorded.push({
        name,
        request: strip({ root: r, rel, grant }, cwd),
        result: strip(fromNode.ok ? { ok: true, value: { dataUrl: fromNode.value.dataUrl, size: fromNode.value.size } } : fromNode, cwd),
      });
    }
    assert.ok(renders.length >= 2, 'the renderer ran for supported files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  verifyCorpus('files', recorded);
});

test('the host declares the visualize and files capabilities it now serves', () => {
  assert.equal(HOST_CAPABILITIES.visualize, true);
  assert.equal(HOST_CAPABILITIES.files, true);
});

function verifyCorpus(section, recorded) {
  const current = existsSync(CORPUS) ? JSON.parse(readFileSync(CORPUS, 'utf8')) : {};
  if (process.env.MIXDOG_GOLDEN_WRITE === '1') {
    mkdirSync(dirname(CORPUS), { recursive: true });
    writeFileSync(CORPUS, `${JSON.stringify({ ...current, version: 1, [section]: recorded }, null, 2)}\n`);
    return;
  }
  assert.deepEqual(current[section], recorded, `${section} drifted from the recorded Node-path corpus`);
}
