// The order in which the phone's router starts and ends calls of different feature groups, compared whole with what Node's relay
// dispatch and call queue did. The committed phone-order fixture contains the scripts as well as the expected traces.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { adapter as filesAdapter } from './remote-protocol-files.ts';
import { adapter as terminalAdapter } from './remote-protocol-terminal.ts';
import { bounded } from './remote-protocol-terminal-deadlines.mjs';
import { createProtocolRouter } from './remote-shim-protocol.ts';

// The router arms a per-call deadline on the page's window timers. This test is about order, not the deadline: its window never fires one.
globalThis.window = { setTimeout: () => 0, clearTimeout() {} };

const golden = JSON.parse(
  readFileSync(new URL('../../../mobile/fixtures/phone-order/golden.json', import.meta.url), 'utf8')
);
const orderCalls = golden.calls;
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

// The recording is Node's desktop queue, which sees a call when its frame arrives: the phone's gates (connection, view sync) come before
// it, so the connection is ready before the first call here. Calls held at the gates leave in the order Node's phone sends them, which the
// lifecycle recording compares (apps/mobile/fixtures/phone-lifecycle: the ungated boot reads leave beside the sync, a fire waits for the
// connection only); this recording has no gate step to compare them against.
for (const [scenario, { steps, events: expectedEvents, answers: expectedAnswers }] of Object.entries(
  golden.scenarios
)) {
  test(`order of calls across groups: ${scenario}`, async () => {
    const events = [];
    const answers = {};
    const pending = [];
    const gates = new Map(Object.keys(orderCalls).map((name) => [name, Promise.withResolvers()]));
    // The connection and the view sync are separate gates: the scenarios open both at once, the test below opens only the connection.
    const connected = Promise.withResolvers();
    const synced = Promise.withResolvers();
    const ran = (method) => () => {
      const name = nameOf[method];
      assert.ok(name, `unscripted method: ${method}`);
      events.push(['start', name]);
      const end = () => {
        events.push(['end', name]);
        return {};
      };
      return orderCalls[name].instant ? end() : gates.get(name).promise.then(end);
    };
    const chat = {
      group: 'chat',
      calls: Object.fromEntries(
        ['renameSession', 'setSessionArchived', 'getSnapshot', 'readCapabilities'].map((method) => [
          method,
          ran(method),
        ])
      ),
    };
    // The core: a call of the files adapter reaches it under a protocol method name; it is the Node call by that name.
    const host = {
      ctx: { phone: { start: () => connected.promise, synced: () => synced.promise } },
      client: () => ({
        call: async (method) => (await ran(coreMethods[method])(), {}),
        notify: (method) => void ran(coreMethods[method])(),
      }),
      declareLane() {},
    };
    const router = createProtocolRouter([filesAdapter, terminalAdapter, chat], {
      host,
      started: () => connected.promise,
      synced: () => synced.promise,
      probe() {},
      silentSince: () => false,
    });
    connected.resolve();
    synced.resolve();
    for (const [action, name] of steps) {
      switch (action) {
        case 'send': {
          const { method, params } = orderCalls[name];
          pending.push(
            router.call(method, params).then(
              () => {
                answers[name] = 'ok';
              },
              (error) => {
                answers[name] = error.message;
              }
            )
          );
          break;
        }
        case 'fire':
          router.fire(orderCalls[name].method, orderCalls[name].params);
          break;
        case 'release':
          gates.get(name).resolve();
          break;
        case 'settle':
          // Drain promise continuations for the calls whose gates have opened.
          await nextTurn();
          break;
        default:
          assert.fail(`unknown script step: ${action}`);
      }
    }
    await bounded(Promise.all(pending), 'all scripted calls to settle', 10_000);
    assert.deepEqual({ events, answers }, { events: expectedEvents, answers: expectedAnswers });
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
  const router = createProtocolRouter([terminalAdapter], {
    host,
    started: () => connected.promise,
    synced: () => synced.promise,
    probe() {},
    silentSince: () => false,
  });
  router.fire('termWrite', ['t', 'x']);
  router.fire('termResize', ['t', 80, 24, true]);
  log.push('connection up');
  connected.resolve();
  await bounded(
    delivered.promise,
    'both terminal calls to be sent once the connection is up, with the view sync still unfinished',
    10_000
  );
  // Node's fire waits for the connection and sends (remote-shim-calls.ts:354); the core's frame names are the spec table's, so there is no
  // Node output of these entries to record: the order is the assertion (the lane's own order is recorded in phone-order/golden.json).
  assert.deepEqual(log, ['connection up', 'terminal/input', 'terminal/resize']);
});
