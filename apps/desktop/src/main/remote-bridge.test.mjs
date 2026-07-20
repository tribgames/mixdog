// Remote bridge smoke tests: token gate, rpc routing, state fanout, and the
// remote capability blocklist, all against a stub EngineHost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { startRemoteBridge } from './remote-bridge';

function createFakeHost() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(snapshot) {
      for (const listener of [...listeners]) listener(snapshot);
    },
    getSnapshot: () => ({ items: [], busy: false }),
    listProjects: () => [{ name: 'demo', path: 'C:/demo', alias: null, pinned: false }],
    invokeCapability: async (capability) => ({ value: `ran:${capability}`, snapshot: null }),
  };
}

async function startTestBridge() {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-bridge-'));
  const rendererDir = join(dir, 'renderer');
  mkdirSync(rendererDir, { recursive: true });
  writeFileSync(join(rendererDir, 'index.html'), '<!doctype html><title>bridge-shell</title>');
  const host = createFakeHost();
  const bridge = await startRemoteBridge({
    port: 0,
    host,
    userDataPath: dir,
    rendererDir,
  });
  return { host, bridge };
}

function connectClient(bridge, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?token=${token}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`unexpected status ${response.statusCode}`));
    });
  });
}

function rpc(socket, id, method, params = []) {
  return new Promise((resolve) => {
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== id) return;
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

test('serves the renderer shell over http', async () => {
  const { bridge } = await startTestBridge();
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /bridge-shell/);
  } finally {
    await bridge.close();
  }
});

test('rejects a websocket without a valid token', async () => {
  const { bridge } = await startTestBridge();
  try {
    await assert.rejects(() => connectClient(bridge, 'not-the-token'));
  } finally {
    await bridge.close();
  }
});

test('routes rpc calls to the engine host', async () => {
  const { bridge } = await startTestBridge();
  const socket = await connectClient(bridge, bridge.token);
  try {
    const reply = await rpc(socket, 1, 'listProjects');
    assert.equal(reply.ok, true);
    assert.equal(reply.value[0].name, 'demo');
  } finally {
    socket.close();
    await bridge.close();
  }
});

test('broadcasts engine state pushes', async () => {
  const { host, bridge } = await startTestBridge();
  const socket = await connectClient(bridge, bridge.token);
  try {
    const push = new Promise((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.event === 'state') resolve(message.payload);
      });
    });
    host.emit({ items: [], busy: true });
    assert.equal((await push).busy, true);
  } finally {
    socket.close();
    await bridge.close();
  }
});

test('blocks secret capabilities over the bridge', async () => {
  const { bridge } = await startTestBridge();
  const socket = await connectClient(bridge, bridge.token);
  try {
    const reply = await rpc(socket, 2, 'invokeCapability', [
      { capability: 'saveProviderApiKey', args: ['openai', 'sk-test'] },
    ]);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /not available over the remote bridge/);
    const allowed = await rpc(socket, 3, 'invokeCapability', [
      { capability: 'compact', args: [] },
    ]);
    assert.equal(allowed.ok, true);
    assert.equal(allowed.value.value, 'ran:compact');
  } finally {
    socket.close();
    await bridge.close();
  }
});

test('rejects unknown methods', async () => {
  const { bridge } = await startTestBridge();
  const socket = await connectClient(bridge, bridge.token);
  try {
    const reply = await rpc(socket, 4, 'openExternal', ['https://example.com']);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /unknown method/);
  } finally {
    socket.close();
    await bridge.close();
  }
});
