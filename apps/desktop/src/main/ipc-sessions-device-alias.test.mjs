import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerSessionIpc } from './ipc-sessions.ts';

function ipc() {
  const handlers = new Map();
  const operations = [];
  registerSessionIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    host: {},
    invokeDesktopOperation: async (method, args) => {
      operations.push([method, ...args]);
      return null;
    },
  });
  return { call: (...args) => handlers.get(DESKTOP_IPC.setRemoteClientAlias)({}, ...args), operations };
}

test('a device alias is set by a string and cleared only by an explicit empty string', async () => {
  const { call, operations } = ipc();
  await call('cred-1', 'Mom’s iPhone');
  await call('cred-1', '');
  assert.deepEqual(operations, [
    ['remoteAccessSetClientAlias', 'cred-1', 'Mom’s iPhone'],
    ['remoteAccessSetClientAlias', 'cred-1', ''],
  ]);
});

test('a non-string alias payload is refused instead of clearing the alias', async () => {
  const { call, operations } = ipc();
  for (const alias of [undefined, null, 0, false, {}, ['x']]) {
    await assert.rejects(async () => call('cred-1', alias), /alias must be a string/);
  }
  await assert.rejects(async () => call('', 'name'), /clientId/);
  assert.deepEqual(operations, []);
});
