import assert from 'node:assert/strict';
import test from 'node:test';

import { remoteAccessDescriptor } from './remote-access-descriptor.ts';
import { remoteAccessInfoFromDescriptor } from './remote-access-window.ts';
import { connectionInfoReady, preloadConnectionInfo } from '../renderer/settings/connection-info.ts';

const relayWith = (listClients) => ({
  clientUrl: 'https://relay.example/d/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/',
  token: 'test-token',
  listClients,
});

test('no relay or an unregistered desktop never produces a pairing QR', async () => {
  assert.equal(await remoteAccessDescriptor(null), null);
  for (const message of ['Relay is not connected.', 'Relay device request timed out.']) {
    const relay = relayWith(async () => {
      throw new Error(message);
    });
    const descriptor = await remoteAccessDescriptor(relay);
    assert.equal(descriptor, null);
    const info = await remoteAccessInfoFromDescriptor(descriptor);
    assert.equal(info, null);
    assert.equal(connectionInfoReady(info), false);
  }
});

test('the device route is withheld until the server replies, even with no paired clients', async () => {
  const reply = Promise.withResolvers();
  const relay = relayWith(() => reply.promise);
  let settled = false;
  const pending = remoteAccessDescriptor(relay).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  reply.resolve([]);
  assert.deepEqual(await pending, {
    relay: { clientUrl: relay.clientUrl, token: relay.token, clients: [] },
  });
});

test('the Connection card retries first registration and receives a QR after the relay responds', async () => {
  let registered = false;
  let calls = 0;
  const relay = relayWith(async () => {
    calls += 1;
    if (!registered) throw new Error('Relay is not connected.');
    return [];
  });
  const api = {
    getRemoteAccessInfo: async () => remoteAccessInfoFromDescriptor(await remoteAccessDescriptor(relay)),
  };
  assert.equal(await preloadConnectionInfo(api), null);
  registered = true;
  const info = await preloadConnectionInfo(api);
  assert.equal(connectionInfoReady(info), true);
  assert.equal(info.relayBrowserUrl, relay.clientUrl);
  assert.deepEqual(info.clients, []);
  assert.equal(calls, 2);

  registered = false;
  assert.equal(await api.getRemoteAccessInfo(), null);
});
