import assert from 'node:assert/strict';
import test from 'node:test';
import { effortOptionsFor } from './effort.mjs';
import { _normalizeCodexModel } from '../providers/openai-codex-model.mjs';
import { enrichModels } from '../providers/model-catalog.mjs';

test('Muse model-level levels override the provider list, so spark-1.3 offers max and 1.2 does not', () => {
  const row = (values) => ({ reasoningOptions: [{ type: 'effort', values }] });
  const five = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  assert.deepEqual(effortOptionsFor('muse-code-oauth', row([...five, 'max'])), [...five, 'max']);
  assert.deepEqual(effortOptionsFor('muse-code-oauth', row(five)), five);
  assert.deepEqual(effortOptionsFor('muse-code-oauth', {}), five);
});

test('Codex OAuth effort levels survive enrichment with public API options', async () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort }));
  // Offline catalogs: the gpt-6-sol manual override still supplies the public
  // API effort options (none..max) that must not replace the route's levels.
  const fetchFn = async () => ({ ok: true, json: async () => ({}) });
  const [row] = await enrichModels([_normalizeCodexModel({ slug: 'gpt-6-sol', supported_reasoning_levels: levels })], {
    fetchFn,
  });
  assert.deepEqual(effortOptionsFor('openai-oauth', row), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});
