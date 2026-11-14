// A server window's connection with a core endpoint, built with a fake protocol connection (no Electron, no ssh): its
// desktop operations go through the lane with this process's facts.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDesktopConnection } from './desktop-connection.ts';
import { fakeProtocol } from './fake-core-protocol.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));

function sshConnection() {
  const server = fakeProtocol([{ section: 'config', key: 'desktop', revision: 1, value: { keepAwake: false } }]);
  const events = [];
  const connection = createDesktopConnection(
    { id: 'srv', kind: 'ssh', name: 'Box' },
    {
      sessionOptions: () => ({ userDataPath: 'profile', packaged: false, resourcesPath: '', appPath: '', appVersion: '0.0.0', rendererDir: '' }),
      appVersion: '0.0.0',
      createProtocol: () => server,
      operationHost: () => ({
        pcNotificationsSupported: async () => true,
        readDisplayPreferences: async () => ({ theme: 'dark', language: 'en' }),
      }),
    }
  );
  connection.client.subscribeDesktopEvents((event) => events.push(event));
  return { connection, server, events };
}

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
    await settle();
    // The announcement goes to the core, which tells every client; the windows hear it from the core, not before.
    assert.deepEqual([server.calls[1].method, server.calls[1].params], ['ui/settings/announce', { scope: 'desktop' }]);
    server.calls[1].resolve({});
    assert.equal(await done, undefined);
    assert.deepEqual(events, []);
    server.emit({ type: 'notification', notification: { method: 'ui/settings/changed', params: { scope: 'desktop' } } });
    assert.deepEqual(events, [{ name: 'settings-changed', value: { scope: 'desktop' } }]);
    const announced = connection.client.invokeDesktopOperation('notifyProviderModelsChanged', ['win-1']);
    await settle();
    assert.deepEqual([server.calls[2].method, server.calls[2].params], ['ui/providerModels/announce', { origin: 'win-1' }]);
    server.calls[2].resolve({});
    await announced;
    server.emit({ type: 'notification', notification: { method: 'ui/providerModels/changed', params: { origin: 'win-1' } } });
    assert.deepEqual(events.at(-1), { name: 'provider-models-changed', value: { origin: 'win-1' } });
    const git = connection.client.invokeDesktopOperation('notifySettingsChanged', ['git']);
    await settle();
    assert.deepEqual([server.calls[3].method, server.calls[3].params], ['ui/settings/announce', { scope: 'git' }], 'only a desktop-scope change carries the display preferences');
    server.calls[3].resolve({});
    await git;
    await assert.rejects(connection.client.invokeDesktopOperation('notifySettingsChanged', ['nope']), /scope is invalid/);
  } finally {
    await connection.dispose();
  }
});
