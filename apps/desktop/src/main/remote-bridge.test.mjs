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
  const sessionListeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(snapshot) {
      for (const listener of [...listeners]) listener(snapshot);
    },
    subscribeSessionStates(listener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    emitSession(update) {
      for (const listener of [...sessionListeners]) listener(update);
    },
    getSnapshot: () => ({ items: [], busy: false }),
    listProjects: () => [{ name: 'demo', path: 'C:/demo', alias: null, pinned: false }],
    invokeCapability: async (capability) => ({ value: `ran:${capability}`, snapshot: null }),
    submitToSession: async (sessionId) => sessionId === 'remote-pane',
    abortSession: async (sessionId) => sessionId,
    resolveToolApprovalForSession: async (sessionId, id) => `${sessionId}:${id}`,
  };
}

async function startTestBridge(extra = {}) {
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
    ...extra,
  });
  return { host, bridge, dir };
}

test('reports live phone clients to the daemon lifetime owner', async () => {
  let changes = 0;
  let reportDisconnected;
  const disconnected = new Promise((resolve) => { reportDisconnected = resolve; });
  const { bridge } = await startTestBridge({
    onClientCountChanged: () => {
      changes += 1;
      if (changes >= 2) reportDisconnected();
    },
  });
  const socket = await connectClient(bridge, bridge.token);
  try {
    assert.equal(bridge.clientCount, 1);
    assert.ok(changes >= 1);
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.close();
    await closed;
    await disconnected;
    assert.equal(bridge.clientCount, 0);
    assert.ok(changes >= 2);
  } finally {
    if (socket.readyState === socket.OPEN) socket.terminate();
    await bridge.close();
  }
});

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

test('serves the renderer shell to a paired token', async () => {
  const { bridge } = await startTestBridge();
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/?token=${bridge.token}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /bridge-shell/);
    // The entry response hands back the cookie that authorizes asset/APK
    // requests, which carry no query string.
    assert.match(String(response.headers.get('set-cookie')), /mixdog_token=/);
  } finally {
    await bridge.close();
  }
});

test('rejects unpaired http requests for the shell and the apk', async () => {
  const { bridge } = await startTestBridge();
  try {
    const shell = await fetch(`http://127.0.0.1:${bridge.port}/`);
    assert.equal(shell.status, 401);
    const apk = await fetch(`http://127.0.0.1:${bridge.port}/mixdog.apk`);
    assert.equal(apk.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${bridge.port}/?token=not-the-token`);
    assert.equal(wrong.status, 401);
  } finally {
    await bridge.close();
  }
});

test('the cookie from the entry page authorizes later asset requests', async () => {
  const { bridge } = await startTestBridge();
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/index.html`, {
      headers: { cookie: `mixdog_token=${bridge.token}` },
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /bridge-shell/);
  } finally {
    await bridge.close();
  }
});

test('rotating the pairing token revokes the previous one', async () => {
  const { dir, bridge } = await startTestBridge();
  const previous = bridge.token;
  await bridge.close();
  const { rotateRemoteToken } = await import('./remote-bridge');
  const rotated = await rotateRemoteToken(dir);
  assert.notEqual(rotated, previous);
  const restarted = await startRemoteBridge({
    port: 0,
    host: createFakeHost(),
    userDataPath: dir,
    rendererDir: join(dir, 'renderer'),
  });
  try {
    assert.equal(restarted.token, rotated);
    const stale = await fetch(`http://127.0.0.1:${restarted.port}/?token=${previous}`);
    assert.equal(stale.status, 401);
    await assert.rejects(() => connectClient(restarted, previous));
  } finally {
    await restarted.close();
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
    assert.equal((await rpc(socket, 2, 'submitToSession', [
      'remote-pane',
      [{ type: 'text', text: 'continue here' }],
      {},
    ])).value, true);
    assert.equal((await rpc(socket, 3, 'abortSession', ['remote-pane'])).value, 'remote-pane');
    assert.equal((await rpc(socket, 4, 'resolveToolApprovalForSession', [
      'remote-pane',
      'approval-1',
      { approved: true },
    ])).value, 'remote-pane:approval-1');
    assert.equal((await rpc(socket, 2, 'submitToSession', [
      'remote-pane',
      [{ type: 'text', text: 'continue here' }],
      {},
    ])).value, true);
    assert.equal((await rpc(socket, 3, 'abortSession', ['remote-pane'])).value, 'remote-pane');
    assert.equal((await rpc(socket, 4, 'resolveToolApprovalForSession', [
      'remote-pane',
      'approval-1',
      { approved: true },
    ])).value, 'remote-pane:approval-1');
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

test('broadcasts session-addressed pane state independently of focus', async () => {
  const { host, bridge } = await startTestBridge();
  const socket = await connectClient(bridge, bridge.token);
  try {
    const push = new Promise((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.event === 'sessionState') resolve(message.payload);
      });
    });
    host.emitSession({
      sessionId: 'remote-pane',
      snapshot: { sessionId: 'remote-pane', items: [], busy: true },
    });
    assert.equal((await push).sessionId, 'remote-pane');
  } finally {
    socket.close();
    await bridge.close();
  }
});

test('broadcasts session-addressed pane state independently of focus', async () => {
  const { host, bridge } = await startTestBridge();
  const socket = await connectClient(bridge, bridge.token);
  try {
    const push = new Promise((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.event === 'sessionState') resolve(message.payload);
      });
    });
    host.emitSession({
      sessionId: 'remote-pane',
      snapshot: { sessionId: 'remote-pane', items: [], busy: true },
    });
    assert.equal((await push).sessionId, 'remote-pane');
  } finally {
    socket.close();
    await bridge.close();
  }
});

test('state pushes ride the items delta after the first full snapshot', async () => {
  const { host, bridge } = await startTestBridge();
  const socket = await connectClient(bridge, bridge.token);
  try {
    const states = [];
    const waitForState = (count) => new Promise((resolve) => {
      const check = () => { if (states.length >= count) resolve(null); };
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.event === 'state') { states.push(message.payload); check(); }
      });
      check();
    });
    const first = { kind: 'message', text: 'hello' };
    const epoch = Symbol.for('mixdog.streaming-tail-text-epoch');
    const firstState = {
      items: [first],
      streamingTail: { id: 'tail', kind: 'assistant', text: 'a' },
      busy: true,
    };
    const secondState = {
      items: [first, { kind: 'message', text: 'world' }],
      streamingTail: { id: 'tail', kind: 'assistant', text: 'ab' },
      busy: false,
    };
    Object.defineProperty(firstState, epoch, { value: 5 });
    Object.defineProperty(secondState, epoch, { value: 5 });
    host.emit(firstState);
    // Identity-shared prefix (same object reference) + one appended item.
    host.emit(secondState);
    await waitForState(2);
    assert.equal(states[0].__itemsRevision, 1);
    assert.equal(states[0].items.length, 1);
    assert.equal(states[1].items, undefined);
    assert.deepEqual(states[1].__itemsPatch.base, 1);
    assert.equal(states[1].__itemsPatch.prefix, 1);
    assert.equal(states[1].__itemsPatch.append.length, 1);
    assert.equal(states[1].__itemsPatch.append[0].text, 'world');
    assert.equal(states[1].busy, undefined);
    assert.deepEqual(states[1].__statePatch.changed, { busy: false });
    assert.deepEqual(states[1].__streamingTailPatch, {
      prefix: 1,
      append: 'b',
      tail: { id: 'tail', kind: 'assistant' },
    });
    // A resync request downgrades the next push to a full snapshot.
    socket.send(JSON.stringify({ method: 'stateResync', params: [] }));
    await waitForState(3);
    // Revisions stay monotonic across resets so stale bases can never match.
    assert.equal(typeof states[2].__itemsRevision, 'number');
    assert.deepEqual(states[2].items, []);
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
