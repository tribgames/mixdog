import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRouteResolution } from './route-resolution.mjs';

const make = (models, route = { provider: '', model: '' }) => {
  const rt = { route, config: {} };
  let collected = 0;
  const api = createRouteResolution({
    rt,
    collectProviderModels: async () => {
      collected += 1;
      return models;
    },
    ensureProvidersReady: async () => {},
    lookupModelMeta: async () => null,
  });
  return { rt, api, collected: () => collected };
};

test('an empty route refuses the turn and never auto-picks a catalog model', async () => {
  const { rt, api } = make([{ provider: 'anthropic-oauth', id: 'claude-opus-5' }]);
  await assert.rejects(() => api.resolveMissingRouteModelForFirstTurn(), /Choose a model with \/model first/);
  assert.equal(rt.route.model, '');
  assert.throws(() => api.requireModelRoute(), /No model configured/);
});

test('an empty route with no provider models keeps the sign-in message', async () => {
  const { api } = make([]);
  await assert.rejects(() => api.resolveMissingRouteModelForFirstTurn(), /No provider models available/);
});

test('a model chosen while the catalog is read is taken, not refused', async () => {
  // A new task's reservation prewarm starts on the still-empty route; the
  // draft's model (setRoute) lands while the provider catalog is awaited, and
  // the first prompt joins this prewarm.
  const rt = { route: { provider: '', model: '' }, config: {} };
  const picked = { provider: 'custom-x', model: 'fake-1' };
  const api = createRouteResolution({
    rt,
    collectProviderModels: async () => {
      rt.route = picked;
      return [{ provider: 'custom-x', id: 'fake-1' }];
    },
    ensureProvidersReady: async () => {},
    lookupModelMeta: async () => null,
  });
  assert.equal(await api.resolveMissingRouteModelForFirstTurn(), picked);
});

test('a route with a model is returned as is without reading the catalog', async () => {
  const route = { provider: 'openai', model: 'gpt-6' };
  const { api, collected } = make([], route);
  assert.equal(await api.resolveMissingRouteModelForFirstTurn(), route);
  assert.equal(collected(), 0);
});
