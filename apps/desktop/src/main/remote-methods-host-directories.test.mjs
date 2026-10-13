import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteMethods, executeRemoteFrame } from './remote-methods.ts';

test('an inherited property name is an unknown method, never dispatched', async () => {
  const methods = { ping: async () => 'pong' };
  for (const method of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const reply = await executeRemoteFrame(methods, JSON.stringify({ id: 1, method, params: [] }));
    assert.deepEqual(reply, { id: 1, ok: false, error: `unknown method: ${method}` });
  }
  assert.deepEqual(await executeRemoteFrame(methods, JSON.stringify({ id: 2, method: 'ping', params: [] })), {
    id: 2,
    ok: true,
    value: 'pong',
  });
});

test('listHostDirectories validates the path and runs the read-only operation without a project', () => {
  const calls = [];
  const methods = createRemoteMethods({
    host: {
      invokeDesktopOperation: async (name, args) => {
        calls.push([name, args]);
        return { path: args[0], folders: [], truncated: false };
      },
    },
  });
  assert.throws(() => methods.listHostDirectories(['relative']), /absolute/);
  assert.throws(() => methods.listHostDirectories([42]), /string/);
  assert.deepEqual(calls, []);
  const absolute = process.platform === 'win32' ? 'C:\\Users' : '/home';
  methods.listHostDirectories([absolute]);
  assert.deepEqual(calls, [['listHostDirectories', [absolute]]]);
});
