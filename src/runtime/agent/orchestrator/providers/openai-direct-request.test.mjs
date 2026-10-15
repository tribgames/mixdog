import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-openai-direct-'));
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
// Every id below is a fixture: no code names these models, the catalogs'
// declarations alone decide each capability.
const litellmRow = (extra = {}) => ({
  litellm_provider: 'openai',
  input_cost_per_token: 2e-6,
  output_cost_per_token: 10e-6,
  mode: 'chat',
  ...extra,
});
writeFileSync(
  join(dataDir, 'litellm-catalog.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    data: {
      // Future family: cache-write rate, Priority and Ultrafast columns.
      'gpt-9-fixture': litellmRow({
        cache_creation_input_token_cost: 2.5e-6,
        input_cost_per_token_priority: 4e-6,
        output_cost_per_token_priority: 20e-6,
        input_cost_per_token_ultrafast: 10e-6,
        output_cost_per_token_ultrafast: 50e-6,
      }),
      // Priced model with no Fast/Ultrafast column and no cache-write rate.
      'gpt-9-plain': litellmRow(),
      // A documented model whose row carries prices only: silent on every tier.
      'gpt-6.1-sol': litellmRow(),
      // Priority column only.
      'gpt-9-priority': litellmRow({ input_cost_per_token_priority: 4e-6, output_cost_per_token_priority: 20e-6 }),
      // Only the undated alias is listed.
      'gpt-9-snap': litellmRow({
        cache_creation_input_token_cost: 2.5e-6,
        input_cost_per_token_priority: 4e-6,
        output_cost_per_token_priority: 20e-6,
      }),
      // The catalog declares Fast mode off even though a Priority rate exists.
      'gpt-9-declined': litellmRow({
        supports_fast_mode: false,
        input_cost_per_token_priority: 4e-6,
        output_cost_per_token_priority: 20e-6,
      }),
    },
  })
);
writeFileSync(
  join(dataDir, 'modelsdev-catalog.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    data: {
      openai: {
        models: {
          // models.dev publishes a cache-write rate for a family LiteLLM lacks.
          'gpt-9-devrow': {
            id: 'gpt-9-devrow',
            reasoning: true,
            tool_call: true,
            limit: { context: 1_000_000, output: 100_000 },
            cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
          },
          'gpt-9-devplain': {
            id: 'gpt-9-devplain',
            reasoning: true,
            tool_call: true,
            limit: { context: 1_000_000, output: 100_000 },
            cost: { input: 2, output: 10, cache_read: 0.2 },
          },
        },
      },
    },
  })
);
process.env.MIXDOG_DATA_DIR = dataDir;

const { applyOpenAIDirectCachePolicy, openAiDirectSupportsFast, openAiDirectSupportsUltrafast } = await import(
  './openai-direct-request.mjs'
);

test('a catalog Ultrafast rate admits an id; no rate admits nothing', () => {
  assert.equal(openAiDirectSupportsUltrafast('gpt-9-fixture'), true);
  assert.equal(openAiDirectSupportsUltrafast({ id: 'gpt-9-fixture' }), true);
  for (const model of ['gpt-9-plain', 'gpt-9-priority', 'gpt-9-devrow', 'gpt-9-unlisted', '']) {
    assert.equal(openAiDirectSupportsUltrafast(model), false, model);
  }
});

test('Fast mode follows the catalog: a declaration wins, then a Priority rate', () => {
  for (const model of ['gpt-9-fixture', 'gpt-9-priority', { id: 'gpt-9-priority' }]) {
    assert.equal(openAiDirectSupportsFast(model), true, JSON.stringify(model));
  }
  // The catalog's explicit false beats the Priority rate it also publishes.
  for (const model of ['gpt-9-declined', 'gpt-9-plain', 'gpt-9-devplain', '']) {
    assert.equal(openAiDirectSupportsFast(model), false, model);
  }
});

test('a row silent on a capability keeps the documented behavior for that capability', () => {
  assert.equal(openAiDirectSupportsFast('gpt-6.1-sol'), true);
  assert.equal(openAiDirectSupportsUltrafast('gpt-6.1-sol'), true);
  assert.deepEqual(applyOpenAIDirectCachePolicy({}, 'gpt-6.1-sol', true).prompt_cache_options, { ttl: '30m' });
});

test('a model no catalog lists keeps the documented behavior', () => {
  for (const model of ['gpt-12-unlisted', 'gpt-6-unlisted', 'gpt-5.5-unlisted']) {
    assert.equal(openAiDirectSupportsFast(model), false, model);
    assert.equal(openAiDirectSupportsUltrafast(model), false, model);
  }
  // GPT-5.6+ take ttl by version; an unlisted pre-5.6 id is off the 24h list.
  for (const model of ['gpt-12-unlisted', 'gpt-6-unlisted']) {
    assert.deepEqual(applyOpenAIDirectCachePolicy({}, model, true).prompt_cache_options, { ttl: '30m' }, model);
  }
  const body = applyOpenAIDirectCachePolicy({}, 'gpt-5.5-unlisted', true);
  assert.equal(body.prompt_cache_options, undefined);
  assert.equal(body.prompt_cache_retention, undefined);
});

test('a dated snapshot reads as its listed undated alias', () => {
  assert.equal(openAiDirectSupportsFast('gpt-9-snap-2027-01-15'), true);
  assert.deepEqual(applyOpenAIDirectCachePolicy({}, 'gpt-9-snap-2027-01-15', true).prompt_cache_options, {
    ttl: '30m',
  });
  assert.equal(openAiDirectSupportsFast('gpt-9-unlisted-2027-01-15'), false);
});

test('GPT-5.6+ select prompt_cache_options ttl instead of prompt_cache_retention', () => {
  for (const model of ['gpt-9-fixture', 'gpt-9-devrow', 'gpt-9-snap']) {
    const body = applyOpenAIDirectCachePolicy({ prompt_cache_retention: '24h' }, model, true);
    assert.deepEqual(body.prompt_cache_options, { ttl: '30m' }, model);
    assert.equal(body.prompt_cache_retention, undefined, model);
  }
});

test('a missing cache-write rate no longer implies a cache form', () => {
  // GPT-9 is 5.6+, so it takes ttl whatever the catalog prices; never inferred from pricing.
  for (const model of ['gpt-9-plain', 'gpt-9-devplain']) {
    const body = applyOpenAIDirectCachePolicy({}, model, true);
    assert.deepEqual(body.prompt_cache_options, { ttl: '30m' }, model);
    assert.equal(body.prompt_cache_retention, undefined, model);
  }
});

test('disabled response storage sends no cache lifetime hint', () => {
  const body = applyOpenAIDirectCachePolicy({ prompt_cache_options: { ttl: '30m' } }, 'gpt-9-fixture', false);
  assert.equal(body.store, false);
  assert.equal(body.prompt_cache_options, undefined);
  assert.equal(body.prompt_cache_retention, undefined);
});
