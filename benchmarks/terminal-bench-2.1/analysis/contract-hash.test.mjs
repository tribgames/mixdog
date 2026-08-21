import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContractDigest } from './contract-hash.mjs';

test('contract digest captures wrappers, edit dialect, provider wire schema, and fallback', async () => {
  const digest = await buildContractDigest(undefined, {
    provider: 'openai-oauth',
    model: 'gpt-5.6-sol',
    workflow: 'solo',
    fallbackProvider: 'anthropic-oauth',
    fallbackModel: 'claude-opus-4-8',
  });

  assert.equal(digest.schemaVersion, 2);
  assert.equal(digest.workflow, 'solo');
  assert.deepEqual(digest.disabledTools, ['web_search', 'web_fetch', 'memory', 'recall']);
  assert.deepEqual(Object.keys(digest.routeContracts), ['lead', 'leadFallback']);

  const lead = digest.routeContracts.lead;
  assert.equal(lead.providerMode, 'native');
  assert.equal(lead.toolCatalogCount, 14);
  assert.equal(lead.activeToolCount, 12);
  assert.equal(lead.providerToolCount, 12);
  assert.ok(lead.toolCatalogNames.includes('load_tool'));
  assert.ok(lead.toolCatalogNames.includes('Skill'));
  assert.ok(lead.toolCatalogNames.includes('cwd'));
  assert.ok(lead.toolCatalogNames.includes('apply_patch'));
  assert.equal(lead.toolCatalogNames.includes('edit'), false);
  assert.equal(lead.activeToolNames.includes('cwd'), false);

  const fallback = digest.routeContracts.leadFallback;
  assert.equal(fallback.toolCatalogCount, 14);
  assert.equal(fallback.providerToolCount, 14);
  assert.ok(fallback.toolCatalogNames.includes('edit'));
  assert.equal(fallback.toolCatalogNames.includes('apply_patch'), false);
  assert.notEqual(lead.providerToolHash, fallback.providerToolHash);
  assert.equal(digest.toolCount, lead.toolCatalogCount);
  assert.equal(digest.activeToolCount, lead.activeToolCount);
});
