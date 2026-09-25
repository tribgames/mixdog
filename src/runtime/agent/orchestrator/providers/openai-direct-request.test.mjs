import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOpenAIDirectCachePolicy, openAiDirectSupportsFast } from './openai-direct-request.mjs';

test('public API Fast mode covers documented models only', () => {
  for (const model of [
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-terra',
    'gpt-5.5',
    'gpt-5.4-mini',
    { id: 'gpt-6-sol' },
  ]) {
    assert.equal(openAiDirectSupportsFast(model), true, JSON.stringify(model));
  }
  for (const model of ['gpt-5', 'gpt-4.1', 'gpt-7-sol', '']) {
    assert.equal(openAiDirectSupportsFast(model), false, model);
  }
});

test('GPT-5.6+ models use prompt_cache_options ttl instead of prompt_cache_retention', () => {
  for (const model of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-6-sol-2026-09-22']) {
    const body = applyOpenAIDirectCachePolicy({ prompt_cache_retention: '24h' }, model, true);
    assert.deepEqual(body.prompt_cache_options, { ttl: '30m' }, model);
    assert.equal(body.prompt_cache_retention, undefined, model);
  }
});

test('earlier models keep 24h prompt_cache_retention', () => {
  const body = applyOpenAIDirectCachePolicy({}, 'gpt-5.5', true);
  assert.equal(body.prompt_cache_retention, '24h');
  assert.equal(body.prompt_cache_options, undefined);
});

test('disabled response storage sends no cache lifetime hint', () => {
  const body = applyOpenAIDirectCachePolicy({ prompt_cache_options: { ttl: '30m' } }, 'gpt-6-sol', false);
  assert.equal(body.store, false);
  assert.equal(body.prompt_cache_options, undefined);
  assert.equal(body.prompt_cache_retention, undefined);
});
