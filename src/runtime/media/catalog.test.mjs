import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaModelLoader, fetchMediaModelRows, projectMediaModels } from './catalog.mjs';
import { _normalizeCodexModel } from '../agent/orchestrator/providers/openai-codex-model.mjs';
import { catalogHttpError } from './catalog-errors.mjs';

test('live catalogs admit new compatible ids and exclude unsupported generation routes', () => {
  const openai = projectMediaModels('openai-oauth', [
    { id: 'gpt-5.6-sol' }, { id: 'gpt-6-astra' }, { id: 'gpt-7-mini' },
    { id: 'gpt-7-codex' }, { id: 'gpt-7-nano' }, { id: 'gpt-image-3' },
    _normalizeCodexModel({ slug: 'gpt-8-denied', supports_image_generation: false }),
    _normalizeCodexModel({ slug: 'gpt-8-text', supported_tools: ['web_search'] }),
    _normalizeCodexModel({ slug: 'gpt-7-mainline', supported_tools: [{ type: 'image_generation' }] }),
  ]);
  assert.deepEqual(openai.image.map((row) => row.id), ['chatgpt-image-auto']);
  assert.equal(openai.image[0].requestModel, 'gpt-7-mainline');
  assert.equal(openai.image[0].controls.size, undefined);
  assert.equal(openai.image[0].controls.quality, undefined);
  assert.deepEqual(projectMediaModels('openai-oauth', [
    { id: 'gpt-image-2.5-flare' }, { id: 'gpt-8-codex' },
    { id: 'gpt-8-denied', supportsImageGeneration: false },
  ]).image, []);
  assert.deepEqual(openai.video, []);

  const xai = projectMediaModels('xai', [
    { id: 'grok-imagine-image' }, { id: 'grok-imagine-image-2.0' },
    { id: 'grok-imagine-image-2.0' }, { id: 'grok-imagine-video' },
    { id: 'grok-imagine-video-1.5' }, { id: 'grok-4.6' },
    { id: 'grok-imagine-image-3.0', deprecated: true },
  ]);
  assert.equal(xai.image[0].id, 'grok-imagine-image-2.0');
  assert.equal(xai.image.length, 2);
  assert.deepEqual(xai.video.map((row) => row.id), ['grok-imagine-video']);
  assert.deepEqual(xai.video[0].controls.resolution, ['480p', '720p']);

  const gemini = projectMediaModels('gemini', [
    { name: 'models/gemini-3.1-flash-lite-image', displayName: 'Nano Banana 2 Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-4-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-9-image', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-3.8-flash' },
    { name: 'models/gemini-omni-flash-preview' },
    { name: 'models/gemini-omni-1.1-flash' },
    { name: 'models/veo-3.1-generate-preview', supportedGenerationMethods: ['predictLongRunning'] },
    { name: 'models/veo-2.0-generate-001', supportedGenerationMethods: ['predictLongRunning'] },
    { name: 'models/imagen-4-generate' },
  ]);
  assert.deepEqual(gemini.image.map((row) => row.id), ['gemini-4-flash-image', 'gemini-3.1-flash-lite-image']);
  assert.equal(gemini.image[1].label, 'Nano Banana 2 Lite · Gemini 3.1 Flash Lite Image');
  assert.equal(gemini.video[0].id, 'gemini-omni-1.1-flash');
  assert.deepEqual(gemini.video[0].controls, { resolution: [], durations: [], maxReferences: 3 });
  assert.equal(gemini.video.length, 3);
});

test('discovery keeps raw media rows, follows Gemini pages and refuses credential redirects', async () => {
  const requests = [];
  const rows = [{ id: 'grok-imagine-image-2.0' }, { id: 'grok-imagine-video' }];
  assert.deepEqual(await fetchMediaModelRows({
    lane: 'xai', auth: { token: 'test-key', baseURL: 'https://api.x.ai/v1' },
    fetchFn: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ data: rows }) };
    },
  }), rows);
  assert.equal(requests[0].url, 'https://api.x.ai/v1/models');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-key');

  const gemini = await fetchMediaModelRows({
    lane: 'gemini', auth: { token: 'test-key' },
    fetchFn: async (url, init) => {
      requests.push({ url, init });
      const second = new URL(url).searchParams.get('pageToken') === 'next';
      return { ok: true, json: async () => second
        ? { models: [{ name: 'models/gemini-omni-1.1-flash' }] }
        : { models: [{ name: 'models/gemini-3.1-flash-lite-image' }], nextPageToken: 'next' } };
    },
  });
  assert.equal(gemini.length, 2);
  assert.equal(requests.length, 3);
  for (const { init } of requests) {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
  }
  for (const lane of ['xai', 'gemini']) {
    await assert.rejects(fetchMediaModelRows({
      lane, auth: { token: 'test-key', baseURL: 'https://api.x.ai/v1' },
      fetchFn: async () => ({ ok: true, json: async () => ({ error: 'unavailable' }) }),
    }), /Invalid .*catalog response/);
  }
});

test('catalog caching joins concurrent reads, refreshes expired/invalidated rows and isolates credentials', async () => {
  let clock = 0;
  let revision = 0;
  let scope = 'account-a';
  let calls = 0;
  let models = [{ id: 'grok-imagine-image' }];
  let failure = false;
  const disk = new Map();
  const load = createMediaModelLoader({
    now: () => clock,
    source: async (lane) => ({
      key: `${lane}-${scope}`, revision,
      async fetchModels() {
        calls += 1;
        await Promise.resolve();
        if (failure) throw new Error('offline');
        return models;
      },
    }),
    cache: (key, stale) => ({
      loadSync: () => {
        const saved = disk.get(key);
        return saved && (stale || clock - saved.at < 1000) ? saved.models : null;
      },
      save: (value) => disk.set(key, { models: value, at: clock }),
    }),
  });
  const initial = await Promise.all([load('xai'), load('xai'), load('xai')]);
  assert.equal(calls, 1);
  assert.deepEqual(initial[0], models);
  await load('xai');
  assert.equal(calls, 1);

  models = [{ id: 'grok-imagine-image-2.0' }];
  clock = 1001;
  assert.deepEqual(await load('xai'), models);
  assert.equal(calls, 2);
  revision += 1;
  models = [];
  assert.deepEqual(await load('xai'), [], 'successful empty catalogs remove retired ids');
  assert.equal(calls, 3);

  revision += 1;
  failure = true;
  assert.deepEqual(await load('xai'), [], 'an outage retains only the last successful result');
  assert.equal(calls, 4);
  await load('xai');
  assert.equal(calls, 4, 'offline retries are throttled');
  scope = 'account-b';
  await assert.rejects(load('xai'), /offline/, 'another account cannot inherit cached availability');
  await assert.rejects(load('grok-oauth'), /offline/, 'OAuth cannot inherit the API-key catalog');
  scope = 'account-a';
  failure = false;
  clock += 60_001;
  models = [{ id: 'grok-imagine-image-3.0' }];
  assert.deepEqual(await load('xai'), models);
});

test('already-cached provider catalogs have no second Studio TTL', async () => {
  let models = [{ id: 'gpt-6-astra' }];
  const load = createMediaModelLoader({
    source: async () => ({ key: 'openai-oauth', cache: false, fetchModels: async () => models }),
    cache: () => { throw new Error('must use the provider cache'); },
  });
  assert.deepEqual(await load('openai-oauth'), models);
  models = [{ id: 'gpt-7-mainline' }];
  assert.deepEqual(await load('openai-oauth'), models);
});

test('image tiers and preview releases stay distinguishable without treating Lite as the mainline default', () => {
  const gemini = projectMediaModels('gemini', [
    { id: 'gemini-3.1-flash-lite-image' },
    { id: 'gemini-3.1-flash-image-preview', displayName: 'Nano Banana 2', created: 999 },
    { id: 'gemini-3.1-flash-image', displayName: 'Nano Banana 2' },
    { id: 'gemini-3-pro-image-preview', displayName: 'Nano Banana Pro' },
  ]);
  assert.equal(gemini.image[0].id, 'gemini-3.1-flash-image');
  assert.match(gemini.image.find(row => row.id.endsWith('image-preview')).label, /Preview/);
  assert.equal(new Set(gemini.image.map(row => row.label)).size, 4);
  const grok = projectMediaModels('grok-oauth', [
    { id: 'grok-imagine-image' }, { id: 'grok-imagine-image-quality' }, { id: 'grok-imagine-image-2.0' },
  ]);
  assert.deepEqual(new Set(grok.image.map(row => row.label)), new Set([
    'Grok Imagine Image', 'Grok Imagine Image Quality', 'Grok Imagine Image 2.0',
  ]));
});

test('catalog outages expose stale state, but billing and credential rejection cannot reuse it', async () => {
  const old = [{ id: 'grok-imagine-image' }];
  for (const status of [401, 403, 429, 503]) {
    const error = catalogHttpError(status, status === 403 ? '{"error":"team secret-id has reached its spending limit"}' : '');
    const load = createMediaModelLoader({
      source: async () => ({ key: 'same-account', fetchModels: async () => { throw error; } }),
      cache: (_key, stale) => ({ loadSync: () => stale ? old : null }),
    });
    if (status === 401 || status === 403) await assert.rejects(load('xai'), { code: error.code });
    else {
      const rows = await load('xai');
      assert.deepEqual(rows, old);
      assert.match(rows.catalogWarning, /last successful/);
    }
    assert.doesNotMatch(error.message, /secret-id/);
  }
});
