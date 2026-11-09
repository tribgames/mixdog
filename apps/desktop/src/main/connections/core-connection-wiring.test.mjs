// A server connection with a core endpoint, built with fake protocol connections (no Electron, no ssh): its model
// proxy is the relay over this PC's own core, and its desktop operations go through the lane with this process's facts.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDesktopConnection } from './desktop-connection.ts';
import { fakeProtocol } from './fake-core-protocol.mjs';
import { createCoreModelProxy } from '../protocol/model-proxy-relay.ts';

const execute = (protocol, id, call = { method: 'send', provider: 'openai' }) =>
  protocol.emit({ type: 'serverRequest', request: { id, method: 'model/proxy/execute', params: { call } } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function sshConnection(overrides = {}) {
  const server = fakeProtocol([{ section: 'config', key: 'desktop', revision: 1, value: { keepAwake: false } }]);
  const local = fakeProtocol();
  const events = [];
  const connection = createDesktopConnection(
    { id: 'srv', kind: 'ssh', name: 'Box', target: 'root@127.0.0.1:2223', ...overrides.spec },
    {
      sessionOptions: () => ({ userDataPath: 'C:\\profile', packaged: false, resourcesPath: '', appPath: '', appVersion: '0.0.0', rendererDir: '' }),
      appVersion: '0.0.0',
      createProtocol: () => server,
      localProtocol: () => local,
      allowedProviders: () => ['openai'],
      operationHost: () => ({
        pcNotificationsSupported: async () => true,
        readDisplayPreferences: async () => ({ theme: 'dark', language: 'en' }),
      }),
      ...overrides.deps,
    }
  );
  connection.client.subscribeDesktopEvents((event) => events.push(event));
  return { connection, server, local, events };
}

test('a server request runs on this PC core with the host\'s provider list, and the answer returns to the server', async () => {
  const { connection, server, local } = sshConnection();
  try {
    execute(server, 7);
    assert.equal(local.calls.length, 1);
    assert.equal(local.calls[0].method, 'modelProxy/run');
    assert.deepEqual(local.calls[0].params.allowedProviders, ['openai']);
    local.calls[0].resolve({ result: { result: 'sent', attempts: 1 } });
    await settle();
    assert.deepEqual(server.sent.at(-1), ['respond', 7, { result: { result: { result: 'sent', attempts: 1 } } }]);
  } finally {
    await connection.dispose();
  }
  assert.equal(server.closed, 1);
});

test('a server on its own logins takes up nothing of this PC', async () => {
  const { connection, server, local } = sshConnection({ spec: { modelLogin: 'server' } });
  try {
    execute(server, 1);
    assert.deepEqual(local.calls, []);
    assert.deepEqual(server.sent, []);
  } finally {
    await connection.dispose();
  }
});

test('a connection without this PC core refuses to be built rather than run the proxy elsewhere', () => {
  assert.throws(() => sshConnection({ deps: { localProtocol: () => null } }), /own core/);
});

test('the lane gets the facts only this process knows', async () => {
  const { connection, server, events } = sshConnection();
  try {
    const state = await connection.client.invokeDesktopOperation('notificationPreferencesState', ['pc', null]);
    assert.equal(state.devices[0].canNotify, true);
    assert.equal((await connection.client.invokeDesktopOperation('readSettings', [])).keepAwake, false);
    const done = connection.client.invokeDesktopOperation('notifySettingsChanged', ['desktop']);
    await settle();
    assert.equal(server.calls[0].method, 'host/state/set');
    assert.deepEqual(server.calls[0].params, { key: 'displayPreferences', value: { theme: 'dark', language: 'en' } });
    server.calls[0].resolve({});
    assert.equal(await done, undefined);
    assert.deepEqual(events, [{ name: 'settings-changed', value: { scope: 'desktop' } }]);
    await connection.client.invokeDesktopOperation('notifyProviderModelsChanged', ['win-1']);
    assert.deepEqual(events.at(-1), { name: 'provider-models-changed', value: { origin: 'win-1' } });
    await connection.client.invokeDesktopOperation('notifySettingsChanged', ['git']);
    assert.equal(server.calls.length, 1, 'only a desktop-scope change carries the display preferences');
    await assert.rejects(connection.client.invokeDesktopOperation('notifySettingsChanged', ['nope']), /scope is invalid/);
  } finally {
    await connection.dispose();
  }
});

test('createCoreModelProxy counts running calls, revoke abandons them and keeps serving, dispose stops', async () => {
  const server = fakeProtocol();
  const local = fakeProtocol();
  const settled = [];
  const proxy = createCoreModelProxy(server, local, () => null, { onCallSettled: (event) => settled.push(event) });
  execute(server, 1);
  execute(server, 2);
  assert.equal(proxy.running, 2);
  proxy.revoke();
  assert.equal(proxy.running, 0);
  assert.deepEqual(settled.map((e) => [e.provider, e.outcome]), [['openai', 'abandoned'], ['openai', 'abandoned']]);
  assert.equal(local.sent.filter(([, method]) => method === 'modelProxy/cancel').length, 2, 'both runs are cancelled');
  execute(server, 3);
  assert.equal(proxy.running, 1, 'still serving after a revoke');
  local.calls.at(-1).reject(new Error('boom'));
  await settle();
  assert.equal(settled.at(-1).outcome, 'failed');
  proxy.dispose();
  execute(server, 4);
  assert.equal(proxy.running, 0, 'a disposed proxy takes up nothing');
});
