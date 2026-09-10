import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const writes = [];
const diagnostics = [];
let reaped = 0;
globalThis.bridgeStartupFixture = {
  createServer: () => ({
    listen(_port, _host, ready) { queueMicrotask(ready); },
    address: () => ({ port: 19999 }),
    close(done) { done(); },
    closeAllConnections() {},
  }),
  createBridgeDiscovery: () => ({
    respond() {}, removeDiscovery() {},
    writeDiscovery: () => new Promise(resolve => writes.push(resolve)),
    heartbeatDiscovery: async () => 'superseded',
  }),
};
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/computer/host/bridge-server')) {
      if (specifier === 'node:http') return {
        url: 'data:text/javascript,export const {createServer}=globalThis.bridgeStartupFixture;', shortCircuit: true,
      };
      if (specifier === '../../bridge/discovery-file') return {
        url: 'data:text/javascript,export const {createBridgeDiscovery}=globalThis.bridgeStartupFixture;', shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});
const { createBridgeServer } = await import('./bridge-server.ts');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a stopped discovery continuation cannot publish readiness or own the next heartbeat', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let enabled = true;
  const bridge = createBridgeServer({
    callPowerShell: async () => ({ ok: true }), adoptWarmedWorker() {}, releaseSpareWorker() {},
    powerShellBySession: new Map(), elevatedSessionIds: () => [], abortComputerSession: async () => ({ text: '' }),
    executeSerialized: async () => ({ text: '' }), reapIdleSessionWorkers: () => reaped++,
    dataDirectory: () => process.cwd(), isBridgeWanted: () => enabled, isDisposed: () => false,
    diagnose: (event, data) => diagnostics.push({ event, ...data }),
  });
  bridge.startBridge();
  await settle();
  enabled = false;
  await bridge.stopBridge();
  enabled = true;
  bridge.startBridge();
  await settle();
  writes[0]('superseded');
  await settle();
  assert.equal(diagnostics.some(record => record.event === 'computer-bridge-ready'), false);
  t.mock.timers.tick(60000);
  assert.equal(reaped, 0);
  writes[1]('owned');
  await settle();
  assert.equal(diagnostics.filter(record => record.event === 'computer-bridge-ready').length, 1);
  t.mock.timers.tick(60000);
  assert.equal(reaped, 1);
  enabled = false;
  await bridge.stopBridge();
  t.mock.timers.tick(60000);
  assert.equal(reaped, 1);
});
