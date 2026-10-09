import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const messages = [{ role: 'user', content: 'Ultrafast' }];
const ultra = { fast: true, modelParameters: { serviceTier: 'ultrafast' } };

test('OAuth payload sends ultrafast only when the catalog advertises it', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-ultrafast-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const [{ _normalizeCodexModel }, { makeModelCache }, { buildRequestBody }, { hydrateProviderModelRow }] =
    await Promise.all([
      import('../runtime/agent/orchestrator/providers/openai-codex-model.mjs'),
      import('../runtime/agent/orchestrator/providers/model-cache.mjs'),
      import('../runtime/agent/orchestrator/providers/openai-oauth.mjs'),
      import('./provider-models/row-hydration.mjs'),
    ]);
  const cache = makeModelCache({ fileName: 'openai-oauth-models.json', version: 6, ttlMs: 60_000 });
  const models = [
    { slug: 'ultra-model', service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }] },
    { slug: 'fast-only-model', service_tiers: [{ id: 'priority' }] },
  ].map(_normalizeCodexModel);
  cache.save(models);
  assert.equal(buildRequestBody(messages, 'ultra-model', [], ultra).service_tier, 'ultrafast');
  assert.equal(buildRequestBody(messages, 'ultra-model', [], { fast: true }).service_tier, 'priority');
  assert.equal(
    buildRequestBody(messages, 'ultra-model', [], { fast: true, modelParameters: { serviceTier: 'priority' } })
      .service_tier,
    'priority'
  );
  assert.equal(buildRequestBody(messages, 'ultra-model', [], { ...ultra, fast: false }).service_tier, undefined);
  // Unsupported ultrafast falls back to priority.
  assert.equal(buildRequestBody(messages, 'fast-only-model', [], ultra).service_tier, 'priority');

  const row = (id) => hydrateProviderModelRow({}, { ...models.find((m) => m.id === id), provider: 'openai-oauth' });
  const option = row('ultra-model').modelParameterOptions.find((o) => o.id === 'serviceTier');
  assert.deepEqual(option, {
    id: 'serviceTier',
    label: 'Speed',
    kind: 'enum',
    options: [
      { value: 'priority', label: 'Fast' },
      { value: 'ultrafast', label: 'Ultrafast' },
    ],
  });
  assert.equal(row('fast-only-model').modelParameterOptions?.some((o) => o.id === 'serviceTier') ?? false, false);
});

test('direct API payload sends ultrafast for astra and 6.1-sol only', async () => {
  const { buildRequestBody } = await import('../runtime/agent/orchestrator/providers/openai-oauth.mjs');
  const direct = { ...ultra, promptCacheProvider: 'openai' };
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-sol-2026-10-01']) {
    assert.equal(buildRequestBody(messages, model, [], direct).service_tier, 'ultrafast', model);
  }
  for (const model of ['gpt-6-sol', 'gpt-5.5']) {
    assert.equal(buildRequestBody(messages, model, [], direct).service_tier, 'priority', model);
  }
  assert.equal(buildRequestBody(messages, 'gpt-5', [], direct).service_tier, undefined);
  assert.equal(
    buildRequestBody(messages, 'gpt-6-astra', [], { ...direct, modelParameters: {} }).service_tier,
    'priority'
  );

  const { hydrateProviderModelRow } = await import('./provider-models/row-hydration.mjs');
  const has = (id) =>
    hydrateProviderModelRow({}, { id, provider: 'openai' }).modelParameterOptions?.some((o) => o.id === 'serviceTier') ?? false;
  assert.equal(has('gpt-6-astra'), true);
  assert.equal(has('gpt-6-sol'), false);
});

test('ws chain breaks to a full frame when service_tier changes', async () => {
  const { _anchorResponseChain, _computeDelta } = await import(
    '../runtime/agent/orchestrator/providers/openai-ws-delta.mjs'
  );
  for (const traceProvider of ['openai-oauth', 'openai-direct']) {
    const base = { model: 'gpt-6-astra', store: true, input: [{ role: 'user', content: 'a' }] };
    const entry = {};
    _anchorResponseChain(entry, {
      responseId: 'resp_1',
      requestBody: { ...base, service_tier: 'priority' },
      responseItems: [],
    });
    const next = { ...base, input: [...base.input, { role: 'user', content: 'b' }] };
    const same = _computeDelta({ entry, body: { ...next, service_tier: 'priority' }, traceProvider });
    assert.equal(same.mode, 'delta', traceProvider);
    const changed = _computeDelta({ entry, body: { ...next, service_tier: 'ultrafast' }, traceProvider });
    assert.equal(changed.mode, 'full', traceProvider);
    assert.equal(changed.reason, 'request_properties_changed');
    assert.equal(changed.frame.previous_response_id, undefined);
  }
});
