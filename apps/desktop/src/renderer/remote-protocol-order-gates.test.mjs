// The order in which the phone's router starts calls of different feature groups, and when keystrokes leave. The real router and the
// real files and terminal adapters run; the chat group is a stand-in adapter that opts into nothing, as a real adapter does not: the
// router alone puts every group's calls into the connection's one queue.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter as filesAdapter } from './remote-protocol-files.ts';
import { adapter as terminalAdapter } from './remote-protocol-terminal.ts';
import { bounded } from './remote-protocol-terminal-deadlines.mjs';
import { createProtocolRouter } from './remote-shim-protocol.ts';

// The router arms a per-call deadline on the page's window timers. This test is about order, not the deadline: its window never fires one.
globalThis.window = { setTimeout: () => 0, clearTimeout() {} };

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("a call of one group waits in the connection's queue behind an unfinished call of another group", async () => {
  const connected = Promise.withResolvers();
  const synced = Promise.withResolvers();
  const release = Promise.withResolvers();
  const log = [];
  const chat = {
    group: 'chat',
    calls: { renameSession: async () => (log.push('rename started'), await release.promise, log.push('rename done')) },
  };
  const host = {
    ctx: { phone: { start: () => connected.promise, synced: () => synced.promise } },
    client: () => ({ call: async (method) => (log.push(method), {}), notify() {} }),
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
  const first = router.call('renameSession', ['s1', 'x']);
  const second = router.call('statProjectFile', ['C:/project', 'a.txt']);
  await settle();
  assert.deepEqual(log, ['rename started'], 'the files call has not reached the core while the rename is unfinished');
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(log, ['rename started', 'rename done', 'projectFs/stat']);
});
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
  // The order is the assertion.
  assert.deepEqual(log, ['connection up', 'terminal/input', 'terminal/resize']);
});
