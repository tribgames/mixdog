// A relay sells access to other vendors' models, so its own name appears in no
// pricing catalog. These cover the repricing that keeps such a route from
// reporting a real spend as zero.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-pricing-'));
writeFileSync(join(dataDir, 'litellm-catalog.json'), JSON.stringify({
  fetchedAt: Date.now(),
  data: {
    'claude-relay-test-1': {
      litellm_provider: 'anthropic',
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      cache_read_input_token_cost: 3e-7,
      max_input_tokens: 200000,
      mode: 'chat',
    },
    'gemini/gemini-relay-test-1': {
      litellm_provider: 'gemini',
      input_cost_per_token: 1e-6,
      output_cost_per_token: 4e-6,
      max_input_tokens: 1000000,
      max_output_tokens: 65536,
      mode: 'chat',
    },
  },
}));
process.env.MIXDOG_DATA_DIR = dataDir;

const { getModelMetadataSync } = await import('./model-catalog.mjs');
const { computeCostUsd } = await import('../../../shared/llm/cost.mjs');

test('a relayed model is priced at the rate of the vendor that served it', () => {
  const direct = getModelMetadataSync('claude-relay-test-1', 'anthropic-oauth');
  const relayed = getModelMetadataSync('claude-relay-test-1', 'cursor-oauth');

  assert.equal(direct.inputCostPerM, 3);
  assert.equal(relayed.inputCostPerM, direct.inputCostPerM);
  assert.equal(relayed.outputCostPerM, direct.outputCostPerM);
  assert.equal(relayed.cacheReadCostPerM, direct.cacheReadCostPerM);
});

test('repricing reaches the prefixed catalog keys too', () => {
  const relayed = getModelMetadataSync('gemini-relay-test-1', 'cursor-oauth');
  assert.equal(relayed.inputCostPerM, 1);
  assert.equal(relayed.outputCostPerM, 4);
});

test('relay pricing does not inherit vendor context or output limits', () => {
  const direct = getModelMetadataSync('gemini-relay-test-1', 'google');
  assert.equal(direct.contextWindow, 1000000);
  assert.equal(direct.outputTokens, 65536);

  for (const provider of ['cursor-oauth', 'cursor-api', 'antigravity-oauth']) {
    const relayed = getModelMetadataSync('gemini-relay-test-1', provider);
    assert.equal(relayed.contextWindow, null, provider);
    assert.equal(relayed.outputTokens, null, provider);
  }
});

test('a relayed turn costs what the same turn costs on the vendor directly', () => {
  const turn = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 };
  const onVendor = computeCostUsd({ ...turn, provider: 'anthropic-oauth', model: 'claude-relay-test-1' });
  // Cursor reports inclusive prompt tokens, Anthropic reports uncached input.
  const onRelay = computeCostUsd({ ...turn, inputTokens: 1_500_000,
    provider: 'cursor-oauth', model: 'claude-relay-test-1' });

  assert.equal(onVendor > 0, true);
  assert.equal(onRelay, onVendor);
});

test('a model no vendor claims is left unpriced rather than guessed at', () => {
  assert.equal(getModelMetadataSync('kimi-relay-test-1', 'cursor-oauth'), null);
  assert.equal(computeCostUsd({
    provider: 'cursor-oauth',
    model: 'kimi-relay-test-1',
    inputTokens: 1_000_000,
  }), 0);
});

test('a local model stays free: nothing is relayed and nothing is priced', () => {
  assert.equal(getModelMetadataSync('claude-relay-test-1', 'mixdog-local'), null);
  assert.equal(computeCostUsd({
    provider: 'mixdog-local',
    model: 'claude-relay-test-1',
    inputTokens: 1_000_000,
  }), 0);
});

test('an ordinary provider is never repriced by a name that merely resembles one', () => {
  // The id starts with a vendor family token, but the route is not a relay, so
  // the provider guard still owns the answer.
  assert.equal(getModelMetadataSync('claude-relay-test-1', 'openai-oauth'), null);
});
