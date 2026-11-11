// Each wait of the replay's lease-clock steps fails with the thing it awaited once that thing is withheld.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { bounded, openClockSocket } from './remote-protocol-terminal-deadlines.mjs';

const SHORT_MS = 200;

test('a lease-clock connection that never opens fails naming the port', async () => {
  const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
  await assert.rejects(openClockSocket(4321, SHORT_MS, () => socket), {
    message: `the connection to the lease clock on port 4321 to open (no answer within ${SHORT_MS} ms)`,
  });
  assert.equal(socket.destroyed, true, 'the unopened socket is released');
});

test('a step the core does not acknowledge fails naming the step', async () => {
  await assert.rejects(bounded(new Promise(() => {}), 'the core did not acknowledge the lease clock step of 30000 ms', SHORT_MS), {
    message: `the core did not acknowledge the lease clock step of 30000 ms (no answer within ${SHORT_MS} ms)`,
  });
});
