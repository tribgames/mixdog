import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as registry from '../../runtime/agent/orchestrator/providers/registry.mjs';
import {
  ModelProxyChannel,
  MODEL_PROXY_OPERATIONS,
  encodeModelProxyWire,
  installModelProxyChannel,
} from '../../runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import { _resetModelProxyProviderConfigForTest } from '../../runtime/agent/orchestrator/providers/model-proxy-provider.mjs';
import { createProviderModels } from '../provider-models.mjs';
import { createQuickModelRows } from '../quick-model-rows.mjs';
import { providerModelCacheRow } from '../model-recency.mjs';
import { makeWebSearchCapableFor } from '../../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';
import { webSearchProviderFamily } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';

const webSearchCapableFor = makeWebSearchCapableFor(webSearchProviderFamily, () => null);

for (const forceFirstRead of [false, true]) {
  test(`remote web-search uses desktop providers on ${forceFirstRead ? 'forced' : 'cold'} load and after provider/host changes`, async (t) => {
    const prior = process.env.MIXDOG_MODEL_PROXY;
    process.env.MIXDOG_MODEL_PROXY = 'client';
    _resetModelProxyProviderConfigForTest();
    t.after(() => {
      if (prior === undefined) delete process.env.MIXDOG_MODEL_PROXY;
      else process.env.MIXDOG_MODEL_PROXY = prior;
      _resetModelProxyProviderConfigForTest();
    });
    const channel = new ModelProxyChannel();
    t.after(installModelProxyChannel(channel));
    let providers = { openai: { enabled: true }, gemini: { enabled: false } };
    const calls = [];
    const attach = () =>
      channel.attachPublisher((snapshot) => {
        for (const { id } of snapshot.requests) {
          const claim = channel.handleOperation(MODEL_PROXY_OPERATIONS.claim, [id]);
          if (!claim) continue;
          const payload = JSON.parse(claim.payload);
          calls.push(payload);
          let value;
          if (payload.method === 'providerConfig') value = { providers, ready: true };
          else {
            assert.ok(['listModels', 'refreshModels'].includes(payload.method));
            assert.equal(providers[payload.provider]?.enabled, true, 'only desktop-enabled providers may be queried');
            value = {
              models: [
                // Current catalogs can declare tools without a boolean flag.
                { id: `${payload.provider}-search`, supportedTools: ['web_search'] },
                { id: `${payload.provider}-plain`, supportsWebSearch: false, supportedTools: ['web_search'] },
                {
                  id: { openai: 'gpt-4-turbo', gemini: 'gemini-1.5-pro', anthropic: 'claude-3-opus' }[payload.provider],
                },
                {
                  id: `${payload.provider}-hidden`,
                  supportsWebSearch: true,
                  hidden: true,
                },
              ],
            };
          }
          queueMicrotask(() =>
            channel.handleOperation(MODEL_PROXY_OPERATIONS.resolve, [id, true, encodeModelProxyWire(value), null])
          );
        }
      });
    let detach = attach();
    t.after(() => detach());
    const quickHelpers = {};
    let ready;
    const api = createProviderModels({
      caches: {
        providerModelsLoadSeq: 0,
        providerModelsCache: { models: null, at: 0 },
        providerModelsPromise: null,
        webSearchProviderModelsCache: { models: null, at: 0 },
      },
      modelMetaByRoute: new Map(),
      getRoute: () => ({}),
      // Remote credentials are absent, and an unrelated server-only entry must
      // never contribute either a model or a provider to the desktop projection.
      getConfig: () => ({
        providers: { openai: { enabled: false }, deepseek: { enabled: true } },
      }),
      getReg: () => registry,
      webSearchCapableFor,
      sortProviderModelsRaw: (models) => models,
      providerModelCacheRowRaw: providerModelCacheRow,
      normalizeWebSearchProviderId: (name) => name,
      isWebSearchCapableProvider: () => true,
      ensureFullConfig() {},
      awaitKeychainPrewarm: async () => {},
      ensureProvidersReady: () => (ready ??= registry.initProviders({})),
      bootProfile() {},
      scheduleProviderModelWarmup() {},
      quickHelpers,
    });
    Object.assign(
      quickHelpers,
      createQuickModelRows({
        getRoute: () => ({}),
        getWebSearchRoute: () => null,
        displayConfig: () => assert.fail('remote web-search must not use server-local quick rows'),
        providerModelCacheRow: api.providerModelCacheRow,
        providerModelsFromCacheRows: api.providerModelsFromCacheRows,
        sortProviderModels: api.sortProviderModels,
        modelMetaByRoute: new Map(),
        modelMetaKey: api.modelMetaKey,
        normalizeWebSearchProviderId: (name) => name,
        normalizeWebSearchRouteConfig: () => null,
        isWebSearchCapableProvider: () => true,
        webSearchCapableFor,
        currentMainWebSearchModelMeta: () => null,
      })
    );
    const ids = (models) => models.map((row) => row.id).sort();
    const first = await api.collectWebSearchProviderModels({
      force: forceFirstRead,
    });
    assert.deepEqual(ids(first), ['openai-search']);
    assert.equal(first[0].webSearchCapable, true);
    assert.equal(first[0].webSearchToolType, 'web_search');
    assert.deepEqual(Object.keys(await api.enabledWebSearchProviderConfig()), ['openai']);
    const callsBefore = calls.length;
    assert.deepEqual(ids(await api.collectWebSearchProviderModels()), ['openai-search']);
    assert.equal(calls.length, callsBefore, 'a warm web-search read reuses the shared model catalog');

    providers = { openai: { enabled: true }, gemini: { enabled: true } };
    assert.deepEqual(ids(await api.collectWebSearchProviderModels({ force: true })), [
      'gemini-search',
      'openai-search',
    ]);
    assert.ok(calls.some((call) => call.provider === 'gemini' && call.method === 'refreshModels'));
    providers = { openai: { enabled: false }, gemini: { enabled: true } };
    assert.deepEqual(ids(await api.collectWebSearchProviderModels({ force: true })), ['gemini-search']);

    // Reconnection may bring a different desktop/host allow-list while the
    // daemon's readiness promise and server-local config remain unchanged.
    detach();
    providers = { anthropic: { enabled: true } };
    detach = attach();
    assert.deepEqual(ids(await api.collectWebSearchProviderModels({ force: true })), ['anthropic-search']);
    assert.deepEqual(ids(await api.collectWebSearchProviderModels()), ['anthropic-search']);
  });
}
