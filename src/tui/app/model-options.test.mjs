import assert from 'node:assert/strict';
import test from 'node:test';
import { parsedModelVersion, modelVersion, compareModelVersion, modelContextWindow, normalizeModelOptions } from './model-options.mjs';
import { isRollingModelAlias } from '../../runtime/shared/model-alias.mjs';

test('model version parsing preserves Claude, compact and generic precedence and missing components', () => {
  for (const [id, expected] of [
    ['CLAUDE-OPUS-5', [5, 0]],
    ['claude-sonnet-4-6', [4, 6]],
    ['claude-sonnet-4.6', [4, 6]],
    ['gpt5.2.123', [5, 2, 123]],
    ['prefix-1-gpt5.2', [5, 2]],
    ['gpt-5', [5]],
    ['vendor-v3.4', [3, 4]],
    ['vendor-v2.3.4567', [2, 3, 456]],
    ['unversioned', []],
    [undefined, []],
  ]) {
    assert.deepEqual(parsedModelVersion(id), expected, String(id));
  }
});

test('version consumers retain display fallback, descending order and model context defaults', () => {
  assert.deepEqual(modelVersion({ id: 'unversioned', display: 'gpt5.1' }), [5, 1]);
  assert.equal(compareModelVersion({ id: 'gpt-5.2' }, { id: 'gpt-5.1' }), -1);
  assert.equal(modelContextWindow({ provider: 'anthropic', id: 'claude-opus-5' }), 1_000_000);
  assert.equal(modelContextWindow({ provider: 'anthropic', id: 'claude-sonnet-4-6' }), 1_000_000);
  assert.equal(modelContextWindow({ provider: 'anthropic', id: 'claude-opus-5', contextWindow: 200_000 }), 200_000);
  assert.equal(modelContextWindow({ provider: 'openai', id: 'gpt-5' }), 0);
});

test('all OpenRouter rolling aliases remain selectable beyond the eight-model family limit', () => {
  const ids = [
    '~google/gemini-flash-latest',
    '~google/gemini-pro-latest',
    '~anthropic/claude-opus-latest',
    '~anthropic/claude-sonnet-latest',
    '~anthropic/claude-haiku-latest',
    '~anthropic/claude-fable-latest',
    '~deepseek/deepseek-pro-latest',
    '~deepseek/deepseek-flash-latest',
    '~deepseek/deepseek-v4-flash-latest',
    '~openai/gpt-astra-latest',
    '~openai/gpt-sol-latest',
    '~openai/gpt-terra-latest',
    '~openai/gpt-luna-latest',
    '~openai/gpt-mini-latest',
    '~z-ai/glm-flash-latest',
    '~z-ai/glm-latest',
    '~moonshotai/kimi-latest',
    '~x-ai/grok-latest',
  ];
  const models = ids.map((id, index) => ({ id, provider: 'openrouter', created: 1000 + index }));
  const normalized = normalizeModelOptions(models);
  assert.equal(normalized.length, ids.length);
  assert.deepEqual(new Set(normalized.map(model => model.id)), new Set(ids));
});

test('rolling aliases do not consume the existing versioned-model allowance', () => {
  const versions = Array.from({ length: 10 }, (_, index) => ({
    provider: 'openrouter',
    id: `vendor/model-${index}`,
    created: 1000 + index,
  }));
  const alias = { provider: 'openrouter', id: 'vendor/model-latest', created: 1 };
  const normalized = normalizeModelOptions([...versions, alias]);
  assert.ok(normalized.includes(alias));
  assert.deepEqual(
    normalized.filter(model => model !== alias).map(model => model.id),
    versions.slice(2).reverse().map(model => model.id)
  );
});

test('Anthropic concrete family limits still keep three Opus versions and one Sonnet', () => {
  const ids = [
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-sonnet-4-5',
    'claude-sonnet-5-5',
  ];
  const normalized = normalizeModelOptions(ids.map(id => ({ id, provider: 'anthropic-oauth' })));
  assert.deepEqual(new Set(normalized.map(model => model.id)), new Set([
    'claude-opus-4-7',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
  ]));
});

test('only a terminal latest alias marker bypasses version trimming', () => {
  assert.equal(isRollingModelAlias('~google/gemini-flash-latest'), true);
  assert.equal(isRollingModelAlias('mistral-large-latest'), true);
  assert.equal(isRollingModelAlias('model-latest-preview'), false);
  assert.equal(isRollingModelAlias('model-latest:batch'), false);
  assert.equal(isRollingModelAlias(''), false);
});
