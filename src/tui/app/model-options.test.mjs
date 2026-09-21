import assert from 'node:assert/strict';
import test from 'node:test';
import { parsedModelVersion, modelVersion, compareModelVersion, modelContextWindow } from './model-options.mjs';

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
