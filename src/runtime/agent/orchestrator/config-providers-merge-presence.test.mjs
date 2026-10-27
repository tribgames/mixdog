import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeStoredProviders } from './config-providers-merge.mjs';
import { readAgentApiKeyAsync } from '../../shared/provider-api-key.mjs';

test("a presence-only merge marks a stored key's provider enabled without attaching the key", async (t) => {
  const prior = process.env.MIXDOG_AGENT_DEEPSEEK_APIKEY;
  process.env.MIXDOG_AGENT_DEEPSEEK_APIKEY = 'pc-deepseek-key';
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_AGENT_DEEPSEEK_APIKEY;
    else process.env.MIXDOG_AGENT_DEEPSEEK_APIKEY = prior;
  });
  const input = () => ({ raw: {}, defaults: { providers: { deepseek: { enabled: false } } }, includeSecrets: true });
  const presence = mergeStoredProviders({ ...input(), presenceOnly: true });
  assert.equal(presence.deepseek.enabled, true);
  assert.equal(Object.hasOwn(presence.deepseek, 'apiKey'), false);
  const full = mergeStoredProviders(input());
  assert.equal(full.deepseek.apiKey, 'pc-deepseek-key');
  // The key itself is read on demand, for that provider only.
  assert.equal(await readAgentApiKeyAsync('deepseek'), 'pc-deepseek-key');
});
