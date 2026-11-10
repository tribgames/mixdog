// Each wait of the replay's teardown and lease-clock steps fails with the thing it awaited once that thing is withheld.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { bounded, openClockSocket, stopCore } from './remote-protocol-terminal-deadlines.mjs';

const SHORT_MS = 200;
// No process has this id: `taskkill` answers at once that there is none, so only the core's exit is awaited.
const NO_SUCH_PID = 2_147_483_000;

test('a core that never exits fails the teardown naming taskkill and the exit', async () => {
  const core = { child: Object.assign(new EventEmitter(), { pid: NO_SUCH_PID, exitCode: null, signalCode: null }) };
  await assert.rejects(stopCore(core, SHORT_MS), {
    message: `taskkill to end the core (pid ${NO_SUCH_PID}) and the core to exit (no answer within ${SHORT_MS} ms)`,
  });
});

const fakeKiller = () => Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; } });

test('a taskkill that fails leaves the core running and says so, whatever the core does', async () => {
  const core = { child: Object.assign(new EventEmitter(), { pid: 77, exitCode: 0, signalCode: null }) };
  const killer = fakeKiller();
  const stopping = stopCore(core, SHORT_MS, () => killer);
  killer.emit('exit', 5);
  await assert.rejects(stopping, { message: 'taskkill could not end the core (pid 77): it exited with status 5' });
});

test('a taskkill that hangs is ended with the failure', async () => {
  const core = { child: Object.assign(new EventEmitter(), { pid: 77, exitCode: 0, signalCode: null }) };
  const killer = fakeKiller();
  await assert.rejects(stopCore(core, SHORT_MS, () => killer), { message: `taskkill to end the core (pid 77) and the core to exit (no answer within ${SHORT_MS} ms)` });
  assert.equal(killer.killed, true, 'the hung killer was ended');
});

test('a core that has already exited does not wait for an exit that will not come', async () => {
  const core = { child: Object.assign(new EventEmitter(), { pid: NO_SUCH_PID, exitCode: 0, signalCode: null }) };
  await stopCore(core, 30_000);
});

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
