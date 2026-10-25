import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelProxyChannel,
  decodeModelProxyWire,
  encodeModelProxyWire,
  installModelProxyChannel,
} from './model-proxy-channel.mjs';
import { createModelProxyBridgeServer, ModelProxyBridgeChannel } from './model-proxy-bridge.mjs';

test('PC-mode quota checks use the PC answer without reading server providers or accounts', async (t) => {
  const previous = process.env.MIXDOG_MODEL_PROXY;
  process.env.MIXDOG_MODEL_PROXY = 'client';
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_MODEL_PROXY;
    else process.env.MIXDOG_MODEL_PROXY = previous;
  });
  const serverReads = [];
  const forbidden = (name) => () => {
    serverReads.push(name);
    throw new Error(`unexpected server ${name}`);
  };
  t.mock.module('./registry.mjs', { namedExports: { getProvider: forbidden('provider') } });
  t.mock.module('./oauth-usage.mjs', { namedExports: { fetchOAuthUsageSnapshot: forbidden('usage') } });
  t.mock.module('../../../shared/provider-accounts.mjs', {
    namedExports: {
      ACCOUNT_PROVIDERS: ['openai-oauth', 'anthropic-oauth'],
      chooseProviderAccount: forbidden('account selection'),
      quotaWindowAppliesToModel: forbidden('quota window'),
      readProviderAccountPool: forbidden('account pool'),
    },
  });
  const { providerQuotaUsable } = await import('./quota-reading.mjs');
  const channel = new ModelProxyChannel();
  t.after(installModelProxyChannel(channel));
  const requests = [];
  const handled = new Set();
  let answer = true;
  let disconnectDuringReading = false;
  const detach = channel.attachPublisher((snapshot) => {
    for (const request of snapshot.requests) {
      if (handled.has(request.id)) continue;
      handled.add(request.id);
      queueMicrotask(() => {
        const call = decodeModelProxyWire(channel.claim(request.id).payload);
        requests.push({ provider: call.provider, method: call.method, model: call.model });
        if (disconnectDuringReading) channel.setClientPresent(false);
        else channel.resolve(request.id, true, encodeModelProxyWire(answer), null);
      });
    }
  });
  t.after(detach);
  for (const [provider, model] of [
    ['openai-oauth', 'gpt-x'],
    ['anthropic-oauth', 'claude-x'],
  ]) {
    for (answer of [true, false]) {
      assert.equal(await providerQuotaUsable(provider, model), answer);
      assert.deepEqual(requests.at(-1), { provider, model, method: 'quotaUsable' });
    }
  }
  assert.equal(requests.length, 4, 'each check asks the PC afresh');
  const bridgeServer = createModelProxyBridgeServer({ channel });
  const endpoint = await bridgeServer.start();
  t.after(() => bridgeServer.close('test complete'));
  const bridge = new ModelProxyBridgeChannel(endpoint);
  t.after(() => bridge.dispose());
  assert.equal(await bridge.whenConnected(2_000), true);
  const restoreChannel = installModelProxyChannel(bridge);
  try {
    answer = true;
    assert.equal(await providerQuotaUsable('openai-oauth', 'gpt-child'), true);
    assert.deepEqual(requests.at(-1), { provider: 'openai-oauth', method: 'quotaUsable', model: 'gpt-child' });
  } finally {
    restoreChannel();
  }
  disconnectDuringReading = true;
  await assert.rejects(providerQuotaUsable('openai-oauth', 'gpt-x'), { code: 'MODEL_PROXY_UNAVAILABLE' });
  await assert.rejects(providerQuotaUsable('openai-oauth', 'gpt-x'), { code: 'MODEL_PROXY_UNAVAILABLE' });
  assert.equal(requests.length, 6, 'an absent PC fails without sending or falling back');
  assert.deepEqual(serverReads, []);
});
