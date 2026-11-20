// The order in which the phone's router sends calls once the connection is up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter as terminalAdapter } from './remote-protocol-terminal.ts';
import { bounded } from './remote-protocol-terminal-deadlines.mjs';
import { createProtocolRouter } from './remote-shim-protocol.ts';

// The router arms a per-call deadline on the page's window timers. This test is about order, not the deadline: its window never fires one.
globalThis.window = { setTimeout: () => 0, clearTimeout() {} };

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
  // A fire waits for the connection and sends; the order is the assertion.
  assert.deepEqual(log, ['connection up', 'terminal/input', 'terminal/resize']);
});
