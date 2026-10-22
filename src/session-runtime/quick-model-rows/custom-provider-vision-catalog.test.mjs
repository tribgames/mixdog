// Auto image input on a custom provider's quick rows follows the catalog; an
// explicit override (true or false) always wins. Isolated catalog fixture, so
// the result never depends on the machine's cached catalog.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-vision-rows-'));
process.env.MIXDOG_DATA_DIR = dir;
test.after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(
  join(dir, 'litellm-catalog.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    data: {
      'gemini/vision-known-model': { litellm_provider: 'gemini', mode: 'chat', supports_vision: true },
      'gemini/text-known-model': { litellm_provider: 'gemini', mode: 'chat', supports_vision: false },
    },
  })
);
writeFileSync(join(dir, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));

const { createQuickProviderRows } = await import('./provider-rows.mjs');
const { metadataFor } = await import('./model-meta.mjs');
const { providerModelCacheRow } = await import('../model-recency.mjs');

const ID = 'custom-5b0f1c7e-2a63-4a39-8d4f-0c1d2e3f4a5b';
const config = (modelOverrides, extra = {}) => ({
  providers: {
    [ID]: {
      type: 'custom',
      name: 'Gateway',
      protocol: 'openai-chat',
      baseURL: 'https://gw.example.com/v1',
      enabled: true,
      schemaVersion: 2,
      auth: 'none',
      modelOverrides,
    },
  },
  ...extra,
});
const rowsFor = (cfg, route = {}) =>
  createQuickProviderRows({
    getRoute: () => route,
    displayConfig: () => cfg,
    providerModelCacheRow: (provider, model) => providerModelCacheRow(provider, model, () => false),
    providerModelsFromCacheRows: (models) => models,
    modelMetaByRoute: new Map(),
    modelMetaKey: (provider, model) => `${provider}:${model}`,
  })();
const vision = (rows, id) => rows.find((row) => row.id === id)?.supportsVision;

test('fixture: the catalog knows one vision model and one text-only model', () => {
  assert.equal(metadataFor(ID, 'vision-known-model').supportsVision, true);
  assert.equal(metadataFor(ID, 'text-known-model').supportsVision, false);
});

test('manual models on Auto follow the catalog; explicit true/false win either way', () => {
  const rows = rowsFor(
    config({
      'vision-known-model': { manual: true },
      'text-known-model': { manual: true },
      'vision-known-model-build': { manual: true },
      'vision-off': { manual: true, supportsVision: false },
      'text-on': { manual: true, supportsVision: true },
    })
  );
  assert.equal(vision(rows, 'vision-known-model'), true);
  assert.equal(vision(rows, 'text-known-model'), false);
  assert.equal(vision(rows, 'vision-known-model-build'), false);
  assert.equal(vision(rows, 'vision-off'), false);
  assert.equal(vision(rows, 'text-on'), true);
});

test('an uncached saved route on Auto follows the catalog; an explicit false beats it', () => {
  const route = { provider: ID, model: 'vision-known-model' };
  assert.equal(vision(rowsFor(config({}), route), 'vision-known-model'), true);
  assert.equal(
    vision(rowsFor(config({ 'vision-known-model': { supportsVision: false } }), route), 'vision-known-model'),
    false
  );
});
