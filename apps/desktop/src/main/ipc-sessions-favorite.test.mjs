import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerSessionIpc } from './ipc-sessions.ts';
import { createRemoteMethods } from './remote-methods.ts';

const SESSION = `sess_desktop_${'a'.repeat(64)}`;

function ipc() {
  const handlers = new Map();
  const calls = [];
  registerSessionIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    host: { setSessionFavorite: async (...args) => calls.push(args) },
    invokeDesktopOperation: async () => undefined,
  });
  return { call: (...args) => handlers.get(DESKTOP_IPC.setSessionFavorite)({}, ...args), calls };
}

test('the favorite IPC handler validates its arguments and forwards to the host', async () => {
  const { call, calls } = ipc();
  await call(SESSION, true);
  await call(` ${SESSION} `, false);
  assert.deepEqual(calls, [
    [SESSION, true],
    [SESSION, false],
  ]);
  await assert.rejects(async () => call(SESSION, 'yes'), /favorite must be a boolean/);
  await assert.rejects(async () => call('../bad id', true), /session id is invalid/);
  await assert.rejects(async () => call(undefined, true), /session id must be a string/);
  assert.equal(calls.length, 2);
});

test('the remote setSessionFavorite method applies the same validation', async () => {
  const calls = [];
  const methods = createRemoteMethods({ host: { setSessionFavorite: async (...args) => calls.push(args) } });
  await methods.setSessionFavorite([SESSION, true]);
  assert.deepEqual(calls, [[SESSION, true]]);
  assert.throws(() => methods.setSessionFavorite([SESSION, 1]), /favorite must be a boolean/);
  assert.throws(() => methods.setSessionFavorite(['bad id', true]), /session id is invalid/);
  assert.equal(calls.length, 1);
});
