import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const writes = [];
const diagnostics = [];
let beats = 0;
globalThis.bridgeStartupFixture = {
  createServer: () => ({
    once() {},
    listen(_port, _host, ready) {
      queueMicrotask(ready);
    },
    address: () => ({ port: 19999 }),
    close(done) {
      done();
    },
    closeAllConnections() {},
  }),
  createBridgeDiscovery: () => ({
    respond() {},
    removeDiscovery() {},
    writeDiscovery: () => new Promise((resolve) => writes.push(resolve)),
    heartbeatDiscovery: async () => {
      beats++;
      return 'superseded';
    },
  }),
};
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/computer/bridge/bridge-server')) {
      if (specifier === 'node:http')
        return {
          url: 'data:text/javascript,export const {createServer}=globalThis.bridgeStartupFixture;',
          shortCircuit: true,
        };
      if (specifier === '../../bridge/discovery-file')
        return {
          url: 'data:text/javascript,export const {createBridgeDiscovery}=globalThis.bridgeStartupFixture;',
          shortCircuit: true,
        };
    }
    return next(specifier, context);
  },
});
const { createBridgeServer } = await import('./bridge-server.ts');
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a stopped discovery continuation cannot publish readiness or own the next heartbeat', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let enabled = true;
  let coreCalls = 0;
  const bridge = createBridgeServer({
    callCore: async () => {
      coreCalls++;
      return { ok: true };
    },
    dataDirectory: () => process.cwd(),
    isBridgeWanted: () => enabled,
    isDisposed: () => false,
    diagnose: (event, data) => diagnostics.push({ event, ...data }),
  });
  bridge.startBridge();
  await settle();
  assert.equal(coreCalls, 0, 'publishing the bridge sends the core nothing');
  enabled = false;
  await bridge.stopBridge();
  enabled = true;
  bridge.startBridge();
  await settle();
  writes[0]('superseded');
  await settle();
  assert.equal(
    diagnostics.some((record) => record.event === 'computer-bridge-ready'),
    false
  );
  t.mock.timers.tick(60000);
  assert.equal(beats, 0);
  writes[1]('owned');
  await settle();
  assert.equal(diagnostics.filter((record) => record.event === 'computer-bridge-ready').length, 1);
  t.mock.timers.tick(60000);
  assert.equal(beats, 1);
  enabled = false;
  await bridge.stopBridge();
  t.mock.timers.tick(60000);
  assert.equal(beats, 1);
});
