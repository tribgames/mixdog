import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelProxyChannel,
  MODEL_PROXY_OPERATIONS,
  encodeModelProxyWire,
  installModelProxyChannel,
} from '../../runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import { _resetModelProxyProviderConfigForTest } from '../../runtime/agent/orchestrator/providers/model-proxy-provider.mjs';
import { providerSetup } from '../services/provider-admin.mjs';
import { createProviderUsage } from '../provider-usage.mjs';
import { createSetupApi } from './setup.mjs';

test('SSH setup uses PC availability through the session API and follows refresh, disconnect and reconnect', async (t) => {
  const prior = process.env.MIXDOG_MODEL_PROXY;
  process.env.MIXDOG_MODEL_PROXY = 'client';
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_MODEL_PROXY;
    else process.env.MIXDOG_MODEL_PROXY = prior;
    _resetModelProxyProviderConfigForTest();
  });
  const channel = new ModelProxyChannel();
  t.after(installModelProxyChannel(channel));
  _resetModelProxyProviderConfigForTest();
  let providers = {
    'openai-oauth': { enabled: true, access_token: 'must-not-leak', accountId: 'private-account' },
    'cursor-oauth': { enabled: true },
    'anthropic-oauth': { enabled: false },
    openai: { enabled: false },
  };
  let requests = 0;
  const attach = () => channel.attachPublisher((snapshot) => {
    for (const { id } of snapshot.requests) {
      const claim = channel.handleOperation(MODEL_PROXY_OPERATIONS.claim, [id]);
      if (!claim) continue;
      requests++;
      const payload = JSON.parse(claim.payload);
      assert.equal(payload.method, 'providerConfig');
      queueMicrotask(() => channel.handleOperation(MODEL_PROXY_OPERATIONS.resolve, [
        id, true, encodeModelProxyWire({ providers, ready: true }), null,
      ]));
    }
  });
  let detach = attach();
  t.after(() => detach());
  const forbidden = () => assert.fail('SSH setup must not probe the server keychain or warm local credentials');
  const usage = createProviderUsage({
    caches: { providerSetupCache: { setup: { staleLocalSnapshot: true } } },
    displayConfig: () => ({ providers: { openai: { enabled: true } } }),
    providerSetup,
  });
  const api = createSetupApi({
    cachedProviderSetup: usage.cachedProviderSetup,
    awaitKeychainPrewarm: forbidden,
    isKeychainPrewarmReady: forbidden,
    hasProviderSetupCached: forbidden,
    reloadFullConfig: forbidden,
  });
  const first = await api.getProviderSetup();
  assert.equal(first.managedByClient, true);
  assert.equal(first.keychain, undefined);
  assert.equal(first.pendingSecrets, undefined);
  assert.deepEqual(first.oauth.map(({ id, authenticated, usable, status }) => ({ id, authenticated, usable, status })), [
    { id: 'openai-oauth', authenticated: true, usable: true, status: 'Connected' },
    { id: 'anthropic-oauth', authenticated: false, usable: false, status: 'Not connected' },
    { id: 'cursor-oauth', authenticated: true, usable: true, status: 'Connected' },
  ]);
  assert.equal(first.api[0].authenticated, false, 'server configuration cannot enable a PC provider');
  assert.doesNotMatch(JSON.stringify(first), /must-not-leak|private-account|access_token|accountId/);
  await api.getProviderSetup();
  assert.equal(requests, 1, 'reuse the bounded proxy cache instead of probing every UI read');

  providers['openai-oauth'] = { enabled: false };
  const refreshed = await api.getProviderSetup({ force: true, unlockKeychain: true });
  assert.equal(refreshed.oauth.find((row) => row.id === 'openai-oauth').authenticated, false);
  assert.equal(requests, 2);
  providers['openai-oauth'] = { enabled: true };
  assert.equal((await api.getProviderSetup({ recheckKeychain: true })).oauth[0].authenticated, true);

  detach();
  assert.deepEqual(await api.getProviderSetup(), {
    managedByClient: true, unavailable: true, api: [], oauth: [], local: [],
  });
  providers = { 'cursor-oauth': { enabled: true } };
  detach = attach();
  const reconnected = await api.getProviderSetup();
  assert.deepEqual(reconnected.oauth.map((row) => row.id), ['cursor-oauth'], 'respect the new PC/host allow-list');
  assert.equal(reconnected.unavailable, undefined);
});
