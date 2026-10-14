import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebSearchRouteCandidates } from './routes.mjs';
import { makeWebSearchCapableFor } from '../../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';
import {
  isDefaultWebSearchRouteConfig,
  isWebSearchCapableProvider,
  normalizeWebSearchProviderId,
  webSearchProviderFamily,
} from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';

function routesFor(route, catalogRow, { cold = false, noModelCache = false } = {}) {
  let loaded = !cold;
  const provider = {
    getCachedModelInfo: (id) => (!noModelCache && loaded && catalogRow?.id === id ? catalogRow : null),
    listModels: async () => {
      loaded = true;
      return [catalogRow];
    },
  };
  return createWebSearchRouteCandidates({
    getRoute: () => route,
    getReg: () => ({ getProvider: () => provider }),
    getWebSearchRoute: () => null,
    setWebSearchRoute: () => {},
    ensureFullConfig: () => ({}),
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    ensureProviderEnabled: (config) => config,
    normalizeWebSearchProviderId,
    isDefaultWebSearchRouteConfig,
    isWebSearchCapableProvider,
    webSearchCapableFor: makeWebSearchCapableFor(webSearchProviderFamily),
  });
}

test('default web search route follows the main model catalog capability', async () => {
  const route = { provider: 'openai-oauth', model: 'gpt-6.1-sol' };
  const capable = routesFor(route, { id: 'gpt-6.1-sol', supportedTools: ['web_search'] });
  const candidates = await capable.nativeWebSearchRoutes();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].model, 'gpt-6.1-sol');
  assert.equal(candidates[0].source, 'default-web-search-route');

  const notCapable = routesFor(route, { id: 'gpt-6.1-sol', supportsWebSearch: false });
  assert.deepEqual(await notCapable.nativeWebSearchRoutes(), []);
});

test('a listed row decides when the provider keeps no per-model cache', async () => {
  const capable = routesFor(
    { provider: 'gemini', model: 'gemini-9-ultra' },
    { id: 'gemini-9-ultra', supportsWebSearch: true },
    { noModelCache: true }
  );
  assert.equal((await capable.nativeWebSearchRoutes()).length, 1);
  const declined = routesFor(
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { id: 'gemini-3.8-flash', supportsWebSearch: false },
    { noModelCache: true }
  );
  assert.deepEqual(await declined.nativeWebSearchRoutes(), []);
});

test('a cold main-model catalog is loaded before the capability check', async () => {
  const route = { provider: 'openai-oauth', model: 'gpt-6.1-sol' };
  const cold = routesFor(route, { id: 'gpt-6.1-sol', supportsWebSearch: true }, { cold: true });
  const candidates = await cold.nativeWebSearchRoutes();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].model, 'gpt-6.1-sol');
});
