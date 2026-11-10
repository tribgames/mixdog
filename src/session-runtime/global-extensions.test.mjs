import assert from 'node:assert/strict';
import test from 'node:test';

import { publishGlobalExtensionChange, subscribeGlobalExtensionChanges } from './global-extensions.mjs';
import { createExtensionSync } from './resource-extension-sync.mjs';

function syncRuntime(calls) {
  return createExtensionSync({
    connectConfiguredMcp: async (options) => {
      calls.push(options);
      return { servers: [] };
    },
    invalidatePreSessionToolSurface() {},
  });
}

test('a named MCP reconnect reaches peer runtimes as a scoped change, not a full reset', async () => {
  const writerCalls = [];
  const peerCalls = [];
  const writer = syncRuntime(writerCalls);
  const peer = syncRuntime(peerCalls);
  try {
    await writer.reconnectMcpAndAnnounce({ only: 'rea', enabled: true, drop: ['old'] });
    // The scoped changes, then a reconcile that touches only servers whose
    // resolved config changed (a plugin server moved off a freed name).
    const expected = [{ only: 'old', enabled: false }, { only: 'rea', enabled: true }, { reconcile: true }];
    assert.deepEqual(writerCalls, expected);
    assert.deepEqual(peerCalls, expected);
    peerCalls.length = 0;
    await writer.reconnectMcpAndAnnounce();
    assert.deepEqual(peerCalls, [{ reset: true }]);
    assert.deepEqual(writerCalls.at(-1), { reset: true });
  } finally {
    writer.dispose();
    peer.dispose();
  }
});

test('enable, disable and reconnect never request an interactive login', async () => {
  const calls = [];
  const runtime = syncRuntime(calls);
  try {
    await runtime.scheduleMcpToggle('server', true);
    await runtime.scheduleMcpToggle('server', false);
    await runtime.reconnectMcpAndAnnounce({ only: 'server', enabled: true });
    assert.deepEqual(calls, [
      { only: 'server', enabled: true },
      { only: 'server', enabled: false },
      { only: 'server', enabled: true },
      { reconcile: true },
    ]);
  } finally {
    runtime.dispose();
  }
});

test('disabling during a pending enable cancels its login instead of waiting it out', async () => {
  const calls = [];
  let finishLogin;
  const runtime = createExtensionSync({
    connectConfiguredMcp: async (options) => {
      calls.push(options);
      if (options.enabled) await new Promise((resolve) => (finishLogin = resolve));
      return { servers: [] };
    },
    cancelMcpLogin: (name) => {
      calls.push(['cancel', name]);
      finishLogin();
    },
    invalidatePreSessionToolSurface() {},
  });
  try {
    const enable = runtime.scheduleMcpToggle('server', true);
    const disable = runtime.scheduleMcpToggle('server', false);
    await Promise.all([enable, disable]);
    assert.deepEqual(calls, [
      { only: 'server', enabled: true },
      ['cancel', 'server'],
      { only: 'server', enabled: false },
    ]);
  } finally {
    runtime.dispose();
  }
});

test('global extension changes fan out to every runtime except the writer', async () => {
  const events = [];
  const writer = subscribeGlobalExtensionChanges((kind) => events.push(['writer', kind]));
  const peer = subscribeGlobalExtensionChanges((kind) => events.push(['peer', kind]));
  try {
    await publishGlobalExtensionChange('mcp', writer.id);
    assert.deepEqual(events, [['peer', 'mcp']]);
  } finally {
    writer.unsubscribe();
    peer.unsubscribe();
  }
});

test('unsubscribed runtimes stop receiving global extension changes', async () => {
  const events = [];
  const runtime = subscribeGlobalExtensionChanges((kind) => events.push(kind));
  runtime.unsubscribe();
  await publishGlobalExtensionChange('skills');
  assert.deepEqual(events, []);
});
