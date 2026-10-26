// A server on its own logins (the saved server's "Server accounts"): this PC
// serves none of its model calls, its quota reads stay on the server, and a
// changed choice reaches the attached connection. A server on this PC's
// logins is served exactly as before.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../../shared/contract.ts';
import { registerWindowSettingsIpc } from '../ipc-window-settings.ts';
import { createServerLoginHandlers } from '../ssh/ssh-ipc-server-logins.ts';
import { createModelProxyHost } from '../model-proxy-host.ts';
import { ConnectionPool, createConnectionManager, createDesktopConnection } from './index.ts';
import {
  encodeModelProxyWire,
  MODEL_PROXY_OPERATIONS,
  MODEL_PROXY_REQUEST_EVENT,
} from '../../../../../src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs';

const SNAPSHOT = { requests: [{ id: 'call-1' }], cancelled: [] };

const deps = (loads) => ({
  moduleUrl: () => 'file:///unused.mjs',
  environmentReady: () => Promise.resolve(),
  sessionOptions: () => ({
    userDataPath: '',
    packaged: false,
    resourcesPath: '',
    appPath: '',
    appVersion: '0.0.0',
    rendererDir: '',
  }),
  loadModelProxyRuntime: async () => {
    loads.push('runtime');
    throw new Error('not in this test');
  },
  appVersion: '0.0.0',
  bundlePath: 'daemon.cjs',
});

/** A server connection whose daemon operations are recorded, never sent. */
function serverConnection(t, modelLogin) {
  const loads = [];
  const connection = createDesktopConnection(
    {
      id: `srv-${modelLogin ?? 'pc'}`,
      kind: 'ssh',
      name: 'Box',
      target: 'root@127.0.0.1:2223',
      ...(modelLogin ? { modelLogin } : {}),
    },
    deps(loads)
  );
  const operations = [];
  connection.client.invokeDesktopOperation = async (operation, args) => {
    operations.push([operation, args]);
    return null;
  };
  t.after(() => connection.dispose());
  return { connection, operations, loads };
}

const settle = async () => {
  for (let turn = 0; turn < 25; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("a server on its own logins is served nothing from this PC; one on this PC's logins is served as before", async (t) => {
  const own = serverConnection(t, 'server');
  assert.equal(own.connection.modelLogin, 'server');
  assert.equal(own.connection.link.view().modelLogin, 'server');
  assert.equal(own.connection.modelProxy.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, SNAPSHOT), true);
  await settle();
  assert.deepEqual(own.operations, [], 'no claim, no provider list, no call');
  assert.deepEqual(own.loads, [], "this PC's provider runtime is never loaded");

  const pc = serverConnection(t);
  assert.equal(pc.connection.modelLogin, 'pc');
  assert.equal(pc.connection.link.view().modelLogin, 'pc');
  pc.connection.modelProxy.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, SNAPSHOT);
  await settle();
  assert.ok(pc.operations.length > 0, 'the advertised call is claimed');
  assert.ok(pc.operations.every(([, args]) => JSON.stringify(args).includes('call-1')));
});

test("a watch of the server's own logins ends on a changed model login or a disconnect, once", async (t) => {
  const own = serverConnection(t, 'server');
  own.connection.client.reattach = async () => undefined;
  const ended = [];
  own.connection.onModelLoginEnd('server', () => ended.push('mode'));
  const kept = own.connection.onModelLoginEnd('server', () => ended.push('unsubscribed'));
  kept();
  await own.connection.applyModelLogin('pc');
  assert.deepEqual(ended, ['mode'], 'the change ends it before the server restarts');
  // A watch taken under a model login that is no longer current ends at once.
  own.connection.onModelLoginEnd('server', () => ended.push('stale'));
  await Promise.resolve();
  assert.deepEqual(ended, ['mode', 'stale']);

  const other = serverConnection(t, 'server');
  other.connection.onModelLoginEnd('server', () => ended.push('disconnect'));
  await other.connection.dispose();
  assert.deepEqual(ended, ['mode', 'stale', 'disconnect']);
  other.connection.onModelLoginEnd('server', () => ended.push('after'));
  await Promise.resolve();
  assert.deepEqual(ended, ['mode', 'stale', 'disconnect', 'after']);
  await own.connection.applyModelLogin('server');
  assert.equal(ended.length, 4, 'an ended watch is never called again');
});

test('a pending login without a forward is cancelled on the old attachment even when the restart fails', async (t) => {
  const own = serverConnection(t, 'server');
  const sent = [];
  own.connection.client.invokeCapability = async (capability, args) => {
    sent.push([capability, args]);
    return {
      value:
        capability === 'beginOAuthProviderLogin'
          ? { flowId: 'f1', provider: 'openai-oauth', state: 'pending', url: 'https://auth.example/x' }
          : null,
    };
  };
  own.connection.client.reattach = async () => {
    throw new Error('the daemon did not restart');
  };
  const host = { id: 'srv', name: 'Box', target: 'root@127.0.0.1:2223', lastConnectedAt: 1 };
  const handlers = createServerLoginHandlers({
    store: async () => ({ get: () => host }),
    connection: () => {
      const modelLogin = own.connection.modelLogin;
      return {
        modelLogin,
        invoke: async (capability, args) => (await own.connection.client.invokeCapability(capability, args)).value,
        busySessions: async () => 0,
        onEnd: (listener) => own.connection.onModelLoginEnd(modelLogin, listener),
      };
    },
    openExternal: async () => undefined,
    // The callback port is taken here: nothing is forwarded.
    forwardCallback: async () => {
      throw new Error('port in use');
    },
  });
  const started = await handlers.begin('srv', 'openai-oauth');
  assert.equal(started.forwarded, false);
  await assert.rejects(own.connection.applyModelLogin('pc'), /did not restart/);
  assert.deepEqual(
    sent.filter(([capability]) => capability === 'cancelOAuthProviderLogin'),
    [['cancelOAuthProviderLogin', ['f1']]],
    'the login is cancelled before the restart is attempted'
  );
  await handlers.dispose();
});

test('a model proxy host that is not serving takes up no request until it serves again', async () => {
  let serving = false;
  const invoked = [];
  const host = createModelProxyHost({
    invoke: async (operation, args) => {
      invoked.push([operation, args]);
      return null;
    },
    loadRuntime: async () => {
      throw new Error('not loaded');
    },
    serving: () => serving,
  });
  host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, SNAPSHOT);
  await settle();
  assert.deepEqual(invoked, []);
  serving = true;
  host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, SNAPSHOT);
  await settle();
  assert.ok(invoked.length > 0);
  host.dispose();
});

/** A host whose daemon answers each claim only when the test releases it. */
function delayedClaims(payloadFor, runtime) {
  let serving = true;
  const sent = [];
  const releases = new Map();
  const reads = [];
  const host = createModelProxyHost({
    invoke: (operation, args) => {
      if (operation !== MODEL_PROXY_OPERATIONS.claim) {
        sent.push([operation, args]);
        return Promise.resolve({ results: encodeModelProxyWire([]) });
      }
      return new Promise((resolve) => releases.set(args[0], () => resolve({ payload: payloadFor(args[0]) })));
    },
    loadRuntime: async () => {
      reads.push('runtime');
      return runtime(reads);
    },
    serving: () => serving,
  });
  return {
    host,
    sent,
    reads,
    release: (id) => releases.get(id)(),
    claimed: (id) => releases.has(id),
    switchToServer() {
      serving = false;
      host.revoke();
    },
  };
}

const pcRuntime = (reads) => ({
  providerConfig: async () => {
    reads.push('providerConfig');
    return { providers: { 'openai-oauth': { enabled: true } }, ready: true };
  },
  provider: async (name) => {
    reads.push(`provider:${name}`);
    return undefined;
  },
  finalizeTools: (tools) => tools,
});

test("a claim still out when the model login changes reads and returns nothing of this PC's", async () => {
  const proxy = delayedClaims(() => encodeModelProxyWire({ method: 'providerConfig' }), pcRuntime);
  proxy.host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, SNAPSHOT);
  await settle();
  assert.ok(proxy.claimed('call-1'));
  proxy.switchToServer();
  proxy.release('call-1');
  await settle();
  assert.deepEqual(proxy.reads, [], "this PC's runtime and provider config are never read");
  assert.deepEqual(proxy.sent, [], 'no answer, no refusal reaches the server');
  assert.equal(proxy.host.running, 0);
  proxy.host.dispose();
});

test('a claim taken before a switch and back is still revoked: the generation, not the mode, decides', async () => {
  const proxy = delayedClaims(() => encodeModelProxyWire({ method: 'providerConfig' }), pcRuntime);
  proxy.host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, SNAPSHOT);
  await settle();
  // To server accounts and straight back to this PC's: the claim belongs to the replaced daemon.
  proxy.host.revoke();
  proxy.release('call-1');
  await settle();
  assert.deepEqual(proxy.reads, []);
  assert.deepEqual(proxy.sent, []);
  proxy.host.dispose();
});

test('a call running when the model login changes is aborted and its answer stays on this PC', async () => {
  let aborted = null;
  let finish;
  const runtime = (reads) => ({
    ...pcRuntime(reads),
    provider: async (name) => ({
      send: (_messages, _model, _tools, options) =>
        new Promise((resolve) => {
          reads.push(`send:${name}`);
          options.signal.addEventListener('abort', () => {
            aborted = options.signal.reason;
          });
          finish = () => resolve({ content: 'from this PC' });
        }),
    }),
  });
  const proxy = delayedClaims(
    () => encodeModelProxyWire({ method: 'send', provider: 'openai-oauth', messages: [] }),
    runtime
  );
  proxy.host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, SNAPSHOT);
  await settle();
  proxy.release('call-1');
  await settle();
  assert.deepEqual(proxy.reads, ['runtime', 'send:openai-oauth']);
  assert.equal(proxy.host.running, 1);
  proxy.switchToServer();
  assert.match(String(aborted?.message), /model login changed/);
  assert.equal(proxy.host.running, 0);
  finish();
  await settle();
  assert.deepEqual(proxy.sent, [], 'neither the answer nor the failure is sent');
  proxy.host.dispose();
});

test("switching a connection to server accounts revokes the claim this PC's mode left out", async (t) => {
  const pc = serverConnection(t);
  pc.connection.client.reattach = async () => undefined;
  let release;
  const sent = [];
  pc.connection.client.invokeDesktopOperation = (operation) => {
    if (operation !== MODEL_PROXY_OPERATIONS.claim) {
      sent.push(operation);
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      release = () => resolve({ payload: encodeModelProxyWire({ method: 'providerConfig' }) });
    });
  };
  pc.connection.modelProxy.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, SNAPSHOT);
  await settle();
  assert.equal(typeof release, 'function', 'the call was claimed in PC mode');
  await pc.connection.applyModelLogin('server');
  release();
  await settle();
  assert.deepEqual(pc.loads, [], "this PC's provider runtime is never loaded");
  assert.deepEqual(sent, []);
});

test('a changed model login reaches only the attached server connection', async () => {
  const pool = new ConnectionPool();
  const applied = [];
  pool.add({ id: 'local', kind: 'local' });
  pool.add({ id: 'srv', kind: 'ssh', applyModelLogin: async (mode) => applied.push(['srv', mode]) });
  const manager = createConnectionManager({
    pool,
    createConnection: () => {
      throw new Error('not opened here');
    },
    showWindow: () => undefined,
    closeWindows: () => undefined,
  });
  await manager.applyModelLogin('srv', 'server');
  await manager.applyModelLogin('missing', 'server');
  await manager.applyModelLogin('local', 'server');
  assert.deepEqual(applied, [['srv', 'server']]);
});

test("a server on its own logins reads its own quota; one on this PC's logins reads this PC's", async () => {
  const quotaReads = (inUse) => {
    const handlers = new Map();
    const reads = [];
    const service = (who) => ({
      invokeCapability: async (capability) => {
        reads.push([who, capability]);
        return { value: { rows: [] } };
      },
      readCapabilities: async (requests) => requests.map(() => ({ ok: true, value: { rows: [] } })),
      getSnapshot: () => ({}),
    });
    registerWindowSettingsIpc({
      window: { webContents: { setZoomFactor() {}, send() {} } },
      app: {},
      host: service('server'),
      pcHost: { ...service('pc'), inUse: () => inUse },
      handle: (channel, handler) => handlers.set(channel, handler),
      invokeDesktopOperation: async () => undefined,
      readsLocalOnboardingStatus: false,
    });
    return { reads, invoke: (input) => handlers.get(DESKTOP_IPC.invokeCapability)({}, input) };
  };
  const own = quotaReads(false);
  await own.invoke({ capability: 'getUsageDashboard', args: [] });
  assert.deepEqual(own.reads, [['server', 'getUsageDashboard']]);
  const pc = quotaReads(true);
  await pc.invoke({ capability: 'getUsageDashboard', args: [] });
  assert.deepEqual(pc.reads, [['pc', 'getUsageDashboard']]);
});
