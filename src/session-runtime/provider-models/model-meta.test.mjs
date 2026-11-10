import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelMetaIndex } from './model-meta.mjs';

test('a fetching lookup replaces the bare-id placeholder of a cold lookup', async () => {
  let listCalls = 0;
  const provider = {
    listModels: async () => {
      listCalls += 1;
      return [{ id: 'gpt-6.1-sol', supportsWebSearch: true }];
    },
  };
  const reg = { getProvider: () => provider };
  const caches = { providerModelsLoadSeq: 0 };
  const index = createModelMetaIndex({
    caches,
    modelMetaByRoute: new Map(),
    reg: () => reg,
    scheduleProviderModelWarmup: () => {},
  });
  const cold = await index.lookupModelMeta('openai-oauth', 'gpt-6.1-sol');
  assert.deepEqual(cold, { id: 'gpt-6.1-sol', provider: 'openai-oauth' });
  const fetched = await index.lookupModelMeta('openai-oauth', 'gpt-6.1-sol', { allowFetch: true });
  assert.equal(fetched.supportsWebSearch, true);
  assert.equal(listCalls, 1);
  await index.lookupModelMeta('openai-oauth', 'gpt-6.1-sol', { allowFetch: true });
  assert.equal(listCalls, 1, 'a real row is not refetched');
});
