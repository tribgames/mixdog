// The order in which the phone's router starts and ends calls of different feature groups, compared whole with what Node's relay
// dispatch and call queue did (apps/mobile/fixtures/phone-order/golden.json, recorded by benchmarks/rust-core/recorders/
// record-phone-order.mjs from b6f10295a). The real router and the real files and terminal adapters run; the chat group is a stand-in adapter that
// opts into nothing, as a real adapter does not: the router alone puts every group's calls into the connection's one queue.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { orderCalls, orderScenarios, play } from '../../../../benchmarks/rust-core/recorders/lib/phone-order-script.mjs';
import { adapter as filesAdapter } from './remote-protocol-files.ts';
import { adapter as terminalAdapter } from './remote-protocol-terminal.ts';
import { bounded } from './remote-protocol-terminal-deadlines.mjs';
import { createProtocolRouter } from './remote-shim-protocol.ts';

// The router arms a per-call deadline on the page's window timers. This test is about order, not the deadline: its window never fires one.
globalThis.window = { setTimeout: () => 0, clearTimeout() {} };

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('../../../mobile/fixtures/phone-order/golden.json', import.meta.url)), 'utf8'));
const nameOf = Object.fromEntries(Object.entries(orderCalls).map(([name, call]) => [call.method, name]));
// What the files adapter asks the core for each of its calls the script uses.
const coreMethods = {
  'projectFs/writeText': 'writeProjectFile',
  'projectFs/listDir': 'listProjectDir',
  'projectFs/stat': 'statProjectFile',
  'terminal/ensure': 'termEnsure',
  'terminal/attach': 'termAttach',
  'terminal/profiles': 'termProfiles',
  'terminal/dispose': 'termDispose',
  'terminal/input': 'termWrite',
  'terminal/resize': 'termResize',
};

// The phone's connection may or may not be ready when a call arrives (Node has no such step): ready before the first call, or only after
// every call of the scenario has arrived. Node's order is the same for both.
const readiness = {
  'ready before the calls': (steps) => [['ready'], ...steps],
  'ready only after the calls arrived': (steps) => {
    const first = steps.findIndex(([op]) => op === 'settle');
    return [...steps.slice(0, first), ['ready'], ...steps.slice(first)];
  },
};

for (const [scenario, recordedSteps] of Object.entries(orderScenarios)) for (const [when, withReady] of Object.entries(readiness)) {
  const steps = withReady(recordedSteps);
  test(`order of calls across groups: ${scenario} (${when})`, async () => {
    let hooks;
    // The connection and the view sync are separate gates: the scenarios open both at once, the test below opens only the connection.
    const connected = Promise.withResolvers();
    const synced = Promise.withResolvers();
    const ran = (method) => async () => {
      hooks.started(nameOf[method]);
      await hooks.gate(nameOf[method]);
    };
    const chat = {
      group: 'chat',
      calls: Object.fromEntries(['renameSession', 'setSessionArchived', 'getSnapshot', 'readCapabilities'].map((method) => [method, ran(method)])),
    };
    // The core: a call of the files adapter reaches it under a protocol method name; it is the Node call by that name.
    const host = { ctx: { phone: { start: () => connected.promise, synced: () => synced.promise } }, client: () => ({
        call: async (method) => (await ran(coreMethods[method])(), {}),
        notify: (method) => void ran(coreMethods[method])(),
      }), declareLane() {} };
    const router = createProtocolRouter([filesAdapter, terminalAdapter, chat], { host, started: () => connected.promise, synced: () => synced.promise, probe() {}, silentSince: () => false });
    const trace = await play(steps, {
      begin: (given) => (hooks = given),
      send: (name) => router.call(orderCalls[name].method, orderCalls[name].params),
      fire: (name) => router.fire(orderCalls[name].method, orderCalls[name].params),
      ready: () => (connected.resolve(), synced.resolve()),
    });
    assert.deepEqual(trace, { events: golden.scenarios[scenario].events, answers: golden.scenarios[scenario].answers });
  });
}

test('keystrokes and resizes go out once the connection is up, without waiting for the view sync', async () => {
  // One log in the order things happen: nothing the calls send may come before the marker written just ahead of the connection coming up.
  const log = [];
  const connected = Promise.withResolvers();
  const synced = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  const host = {
    ctx: { phone: { start: () => connected.promise, synced: () => synced.promise } },
    client: () => ({
      call: async () => ({}),
      notify: (method) => {
        log.push(method);
        if (log.filter((entry) => entry.startsWith('terminal/')).length === 2) delivered.resolve();
      },
    }),
    declareLane() {},
  };
  const router = createProtocolRouter([terminalAdapter], { host, started: () => connected.promise, synced: () => synced.promise, probe() {}, silentSince: () => false });
  router.fire('termWrite', ['t', 'x']);
  router.fire('termResize', ['t', 80, 24, true]);
  log.push('connection up');
  connected.resolve();
  await bounded(delivered.promise, 'both terminal calls to be sent once the connection is up, with the view sync still unfinished', 10_000);
  assert.deepEqual(log, ['connection up', 'terminal/input', 'terminal/resize']);
});