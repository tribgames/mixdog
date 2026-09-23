import assert from 'node:assert/strict';
import test from 'node:test';
import { effortOptionsFor } from './effort.mjs';
import { _normalizeCodexModel } from '../runtime/agent/orchestrator/providers/openai-codex-model.mjs';
import { enrichModels } from '../runtime/agent/orchestrator/providers/model-catalog.mjs';

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
