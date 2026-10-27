import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';

const writes = [];
const diagnostics = [];
const BLOCKED_PORT = 6667;
const SAFE_PORT = 19999;
// Every listen of the first bridge start is assigned a blocked port (one initial
// listen plus the helper's 16 retries); later listens get a safe one.
let blockedListens = 17;
let listenError = false;
const servers = [];

class FakeServer extends EventEmitter {
  port = 0;
  listening = false;
  listen(_port, _host, ready) {
    if (listenError) {
      queueMicrotask(() => this.emit('error', Object.assign(new Error('listen EACCES'), { code: 'EACCES' })));
      return;
    }
    this.port = blockedListens > 0 ? BLOCKED_PORT : SAFE_PORT;
    blockedListens -= 1;
    this.listening = true;
    queueMicrotask(ready);
  }
  address() {
    return this.listening ? { port: this.port } : null;
  }
  close(done) {
    this.listening = false;
    done();
  }
  closeAllConnections() {}
}

globalThis.bridgeExhaustionFixture = {
  createServer: () => {
    const server = new FakeServer();
    servers.push(server);
    return server;
  },
  createBridgeDiscovery: () => ({
    respond() {},
    removeDiscovery() {},
    writeDiscovery: () => new Promise((resolve) => writes.push(resolve)),
    heartbeatDiscovery: async () => 'owned',
  }),
};
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/computer/host/bridge-server')) {
      if (specifier === 'node:http')
        return {
          url: 'data:text/javascript,export const {createServer}=globalThis.bridgeExhaustionFixture;',
          shortCircuit: true,
        };
      if (specifier === '../../bridge/discovery-file')
        return {
          url: 'data:text/javascript,export const {createBridgeDiscovery}=globalThis.bridgeExhaustionFixture;',
          shortCircuit: true,
        };
    }
    return next(specifier, context);
  },
});
const { createBridgeServer, LISTEN_RETRY_MS } = await import('./bridge-server.ts');
const settle = async () => {
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};
const hostOf = (wanted, extra = {}) => ({
  ...extra,
  powerShellBySession: new Map(),
  elevatedSessionIds: () => [],
  abortComputerSession: async () => ({ text: '' }),
  executeSerialized: async () => ({ text: '' }),
  reapIdleSessionWorkers: () => {},
  dataDirectory: () => process.cwd(),
  isBridgeWanted: wanted,
  isDisposed: () => false,
  diagnose: (event, data) => diagnostics.push({ event, ...data }),
});

test('exhausted blocked-port retries clear the bridge state without an uncaught error and a later start publishes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  let wanted = false;
  const bridge = createBridgeServer(hostOf(() => wanted));

  wanted = true;
  bridge.startBridge();
  await settle();
  assert.deepEqual(uncaught, [], 'the exhaustion error is handled');
  assert.equal(
    diagnostics.some((record) => record.event === 'computer-bridge-error' && /no fetch-safe/.test(record.message)),
    true
  );
  assert.equal(servers[0].listening, false);
  assert.equal(servers.length, 1, 'the failed start waits for the retry pause');
  t.mock.timers.tick(LISTEN_RETRY_MS);
  await settle();
  assert.equal(servers.length, 2, 'the cleared state let the wanted bridge start again');
  assert.equal(servers[1].port, SAFE_PORT);
  assert.equal(writes.length, 1, 'the restart published its discovery on the safe port');

  wanted = false;
  await bridge.stopBridge();
  wanted = true;
  bridge.startBridge();
  await settle();
  assert.equal(servers.length, 3, 'a later start creates a new server');
  assert.equal(writes.length, 2);
  assert.deepEqual(uncaught, []);

  wanted = false;
  await bridge.stopBridge();
});

test('a persistent listen failure restarts at most once per retry interval and stopping cancels the pending retry', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => {
    process.off('uncaughtException', onUncaught);
    listenError = false;
  });
  listenError = true;
  const first = servers.length;
  let wanted = true;
  const bridge = createBridgeServer(hostOf(() => wanted));

  bridge.startBridge();
  await settle();
  assert.equal(servers.length - first, 1, 'one attempt, then the pause: no restart spin');
  t.mock.timers.tick(LISTEN_RETRY_MS - 1);
  await settle();
  assert.equal(servers.length - first, 1, 'nothing restarts before the interval ends');
  for (let interval = 2; interval <= 4; interval += 1) {
    t.mock.timers.tick(interval === 2 ? 1 : LISTEN_RETRY_MS);
    await settle();
    assert.equal(servers.length - first, interval, 'one restart per interval');
  }

  wanted = false;
  await bridge.stopBridge();
  const stopped = servers.length;
  wanted = true; // a surviving timer would now restart the bridge
  t.mock.timers.tick(LISTEN_RETRY_MS * 4);
  await settle();
  assert.equal(servers.length, stopped, 'stopping cancelled the pending retry');
  assert.deepEqual(uncaught, []);
});

test('an explicit stop issued while the listen-failure cleanup is unresolved leaves no retry behind', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => {
    listenError = false;
  });
  listenError = true;
  const first = servers.length;
  let wanted = true;
  let finishCleanup;
  const cleanup = new Promise((resolve) => {
    finishCleanup = resolve;
  });
  const bridge = createBridgeServer(hostOf(() => wanted, { waitForCleanup: () => cleanup }));

  bridge.startBridge();
  await settle();
  assert.equal(servers.length - first, 1, 'the failed start is still cleaning up');
  wanted = false;
  const stopping = bridge.stopBridge();
  finishCleanup(true);
  await stopping;
  await settle();
  wanted = true; // a retry armed by the overtaken cleanup would restart the bridge now
  t.mock.timers.tick(LISTEN_RETRY_MS * 4);
  await settle();
  assert.equal(servers.length - first, 1, 'no start follows the explicit stop');
});
