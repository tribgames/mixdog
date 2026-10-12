import assert from 'node:assert/strict';
import test from 'node:test';
import { saveWorkspaceFlow } from './workspace-save.ts';

test('remote surfaces prompt for a host path before saving', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls = [];
  const api = { saveWorkspace: async (file, folders) => (calls.push([file, folders]), { name: 'w' }) };
  try {
    globalThis.window = { mixdogRemoteServer: 'https://relay.test' };
    assert.equal(await saveWorkspaceFlow(api, [], () => '  '), null);
    assert.equal(calls.length, 0);
    await saveWorkspaceFlow(api, [], () => ' /srv/a.code-workspace ');
    assert.deepEqual(calls[0], ['/srv/a.code-workspace', []]);
    globalThis.window = {};
    await saveWorkspaceFlow(api, [], () => assert.fail('no prompt on the host'));
    assert.deepEqual(calls[1], [null, []]);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'window', saved);
    else delete globalThis.window;
  }
});
