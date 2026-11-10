// With no usable disk copy the resident tables stay empty: a sync read answers
// with no price rather than a wrong one, and the revision changes once a fetch
// fills the table so price-dependent consumers re-check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';

process.env.MIXDOG_DATA_DIR = makeTempDirSync('model-catalog-cold-window');
const catalog = await import('./model-catalog.mjs');

test('a cold catalog yields no price, a defined revision, and a new revision after the fill', async (t) => {
  const cold = catalog.getModelMetadataSync('gemini-cold-test', 'gemini');
  assert.equal(cold?.inputCostPerM ?? null, null);
  assert.equal(cold?.contextWindow ?? null, null);
  const before = catalog.pricingCatalogRevisionSync();
  assert.match(before, /^[0-9a-f]{64}$/);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    text: async () =>
      JSON.stringify({
        'gemini/gemini-cold-test': {
          litellm_provider: 'gemini',
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
          max_input_tokens: 123456,
        },
      }),
  }));
  await catalog.warmModelMetadataCatalogs();
  assert.equal(catalog.getModelMetadataSync('gemini-cold-test', 'gemini')?.inputCostPerM, 1);
  assert.notEqual(catalog.pricingCatalogRevisionSync(), before);
});
