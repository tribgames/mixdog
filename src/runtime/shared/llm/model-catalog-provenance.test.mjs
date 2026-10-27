// A relay's model borrows its serving vendor's row. Which vendor that is must
// come from provenance, never from the order catalog entries happen to have.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-catalog-provenance-'));
process.env.MIXDOG_DATA_DIR = dir;
test.after(() => rmSync(dir, { recursive: true, force: true }));

const row = (input, extra = {}) => ({
  name: 'Future',
  reasoning: true,
  tool_call: true,
  limit: { context: 500000, output: 32000 },
  cost: { input, output: input * 3 },
  ...extra,
});
const writeCatalog = (file, data) => writeFileSync(join(dir, file), JSON.stringify({ fetchedAt: Date.now(), data }));

let generation = 0;
async function load({ modelsdev, litellm = {} }) {
  writeCatalog('modelsdev-catalog.json', modelsdev);
  writeCatalog('litellm-catalog.json', litellm);
  return import(`./model-catalog.mjs?provenance=${generation++}`);
}
const reversed = (object) => Object.fromEntries(Object.entries(object).reverse());
const relayPrice = (catalog, id) => catalog.getModelMetadataSync(id, 'cursor-oauth')?.inputCostPerM ?? null;

test('unregistered aggregators that disagree lend nothing, in either catalog order', async () => {
  const entries = {
    'agg-a': { models: { 'zeta-9-max': row(70) } },
    'agg-b': { models: { 'zeta-9-max': row(7) } },
  };
  for (const modelsdev of [entries, reversed(entries)]) {
    assert.equal(relayPrice(await load({ modelsdev }), 'zeta-9-max'), null);
  }
});

test('a registered first-party vendor beats any aggregator, in either catalog order', async () => {
  const entries = {
    'agg-a': { models: { 'zeta-9-max': row(70) } },
    anthropic: { models: { 'zeta-9-max': row(7) } },
    'agg-b': { models: { 'zeta-9-max': row(700) } },
  };
  for (const modelsdev of [entries, reversed(entries)]) {
    assert.equal(relayPrice(await load({ modelsdev }), 'zeta-9-max'), 7);
  }
});

test('a lone unregistered provider is still the only provenance there is', async () => {
  const catalog = await load({ modelsdev: { 'agg-a': { models: { 'zeta-9-max': row(7) } } } });
  assert.equal(relayPrice(catalog, 'zeta-9-max'), 7);
});

test('the LiteLLM vendor outranks every models.dev provider', async () => {
  const modelsdev = {
    anthropic: { models: { 'zeta-9-max': row(70) } },
    openai: { models: { 'zeta-9-max': row(700) } },
  };
  const litellm = {
    'zeta-9-max': {
      litellm_provider: 'openai',
      mode: 'chat',
      input_cost_per_token: 7e-6,
      output_cost_per_token: 21e-6,
    },
  };
  for (const order of [modelsdev, reversed(modelsdev)]) {
    assert.equal(relayPrice(await load({ modelsdev: order, litellm }), 'zeta-9-max'), 700);
  }
});

test('a custom-* provider listed in a catalog is never the vendor and does not recurse', async () => {
  const catalog = await load({
    modelsdev: {
      'custom-mine': { models: { 'zeta-9-max': row(70) } },
      anthropic: { models: { 'zeta-9-max': row(7) } },
    },
  });
  assert.equal(relayPrice(catalog, 'zeta-9-max'), 7);
  assert.equal(catalog.getModelMetadataSync('zeta-9-max', 'custom-mine')?.inputCostPerM ?? null, 70);
  const onlyCustom = await load({ modelsdev: { 'custom-mine': { models: { 'zeta-9-max': row(70) } } } });
  assert.equal(relayPrice(onlyCustom, 'zeta-9-max'), null);
});
