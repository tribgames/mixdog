// The order in which the phone's router starts and ends calls of different feature groups, compared whole with what Node's relay
// dispatch and call queue did (apps/mobile/fixtures/phone-order/golden.json, recorded by benchmarks/rust-core/recorders/
// record-phone-order.mjs from b6f10295a). The real router and the real files adapter run; the chat group is a stand-in adapter that
// opts into nothing, as a real adapter does not: the router alone puts every group's calls into the connection's one queue.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { orderCalls, orderScenarios, play } from '../../../../benchmarks/rust-core/recorders/lib/phone-order-script.mjs';
import { adapter as filesAdapter } from './remote-protocol-files.ts';
import { createProtocolRouter } from './remote-shim-protocol.ts';

// The router arms a per-call deadline on the page's window timers. This test is about order, not the deadline: its window never fires one.
globalThis.window = { setTimeout: () => 0, clearTimeout() {} };

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('../../../mobile/fixtures/phone-order/golden.json', import.meta.url)), 'utf8'));
const nameOf = Object.fromEntries(Object.entries(orderCalls).map(([name, call]) => [call.method, name]));
// What the files adapter asks the core for each of its calls the script uses.
const coreMethods = { 'projectFs/writeText': 'writeProjectFile', 'projectFs/listDir': 'listProjectDir', 'projectFs/stat': 'statProjectFile' };

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
    const ready = Promise.withResolvers();
    const ran = (method) => async () => {
      hooks.started(nameOf[method]);
      await hooks.gate(nameOf[method]);
    };
    const chat = {
      group: 'chat',
      calls: Object.fromEntries(['renameSession', 'setSessionArchived', 'getSnapshot', 'readCapabilities'].map((method) => [method, ran(method)])),
    };
    // The core: a call of the files adapter reaches it under a protocol method name; it is the Node call by that name.
    const host = { ctx: {}, client: () => ({ call: async (method) => (await ran(coreMethods[method])(), {}) }), declareLane() {} };
    const router = createProtocolRouter([filesAdapter, chat], { host, started: () => ready.promise, synced: () => ready.promise, probe() {}, silentSince: () => false });
    const trace = await play(steps, {
      begin: (given) => (hooks = given),
      send: (name) => router.call(orderCalls[name].method, orderCalls[name].params),
      fire: (name) => router.fire(orderCalls[name].method, orderCalls[name].params),
      ready: () => ready.resolve(),
    });
    assert.deepEqual(trace, { events: golden.scenarios[scenario].events, answers: golden.scenarios[scenario].answers });
  });
}
