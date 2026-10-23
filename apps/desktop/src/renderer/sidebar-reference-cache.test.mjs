import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeModelCatalogInvalidation } from './model-catalog-cache.ts';
import {
  invalidateSidebarReferenceForMutation,
  loadSidebarReferences,
  readSidebarReference,
  resetSidebarReferenceCache,
  sidebarReferenceKeysForMutation,
  sidebarReferencesLoading,
  updateSidebarReference,
} from './sidebar-reference-cache.ts';

test('cold sidebar references stay loading until the complete set is available', () => {
  resetSidebarReferenceCache();
  const keys = ['workflows', 'agents'];

  assert.equal(sidebarReferencesLoading(true, false, keys), true);
  updateSidebarReference('workflows', [{ id: 'solo' }]);
  assert.equal(sidebarReferencesLoading(true, false, keys), true);
  updateSidebarReference('agents', [{ id: 'maintainer' }]);
  assert.equal(sidebarReferencesLoading(true, false, keys), false);
});

test('unavailable bridges never leave a permanent loading surface', () => {
  resetSidebarReferenceCache();
  assert.equal(sidebarReferencesLoading(false, false, ['workflows', 'agents']), false);
});

test('a Developer provider toggle retires provider references and wakes mounted model pickers', async () => {
  let woke = 0;
  const unsubscribe = subscribeModelCatalogInvalidation(() => {
    woke += 1;
  });
  try {
    assert.equal(invalidateSidebarReferenceForMutation('setDeveloperOption'), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(woke, 1);
  } finally {
    unsubscribe();
  }
  assert.deepEqual(sidebarReferenceKeysForMutation('setDeveloperOption'), [
    'providerSetup',
    'quickProviderModels',
    'webSearchModels',
  ]);
});

test('Local Provider lifecycle changes invalidate setup and model references', () => {
  for (const mutation of ['installBuiltinFeature', 'installLocalProviderModel', 'setBuiltinToolEnabled']) {
    assert.deepEqual(sidebarReferenceKeysForMutation(mutation), [
      'providerSetup',
      'quickProviderModels',
      'webSearchModels',
    ]);
  }
});

// #205: a boot-time partial (Nano-GPT answers /models in ~44 s against a 4 s
// timeout) or empty catalog must not be served for the 24 h TTL.
function catalogApi(answers) {
  const calls = { models: 0 };
  return {
    calls,
    invokeCapability: async () => ({ value: null }),
    listProviderModels: async () => answers[Math.min(calls.models++, answers.length - 1)](),
  };
}
const row = (model, extra = {}) => ({ provider: 'openai-oauth', model, display: model, effortOptions: [], ...extra });

test('a partial model catalog goes stale at its retry time, not after 24 hours', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  resetSidebarReferenceCache();
  const api = catalogApi([
    () => [row('a', { catalogPartial: true, catalogRetryAt: Date.now() + 5_000 })],
    () => [row('a'), row('b')],
  ]);
  await loadSidebarReferences(api, ['quickProviderModels']);
  await loadSidebarReferences(api, ['quickProviderModels']);
  assert.equal(api.calls.models, 1, 'held until its retry time');

  t.mock.timers.tick(5_100);
  await loadSidebarReferences(api, ['quickProviderModels']);
  assert.equal(api.calls.models, 2);
  assert.deepEqual(
    readSidebarReference('quickProviderModels').map((entry) => entry.model),
    ['a', 'b']
  );
  await loadSidebarReferences(api, ['quickProviderModels']);
  assert.equal(api.calls.models, 2, 'a complete answer is held again');
});

test('an empty model catalog is read again after a short time, not after 24 hours', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  resetSidebarReferenceCache();
  const api = catalogApi([() => [], () => [row('a')]]);
  await loadSidebarReferences(api, ['quickProviderModels']);
  await loadSidebarReferences(api, ['quickProviderModels']);
  assert.equal(api.calls.models, 1);

  t.mock.timers.tick(31_000);
  await loadSidebarReferences(api, ['quickProviderModels']);
  assert.equal(api.calls.models, 2);
  assert.equal(readSidebarReference('quickProviderModels')[0].model, 'a');
});
