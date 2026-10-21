import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaModelLoader, fetchMediaModelRows, mediaCatalogTimeoutMs, projectMediaModels } from './catalog.mjs';
import { _normalizeCodexModel } from '../agent/orchestrator/providers/openai-codex-model.mjs';
import { catalogHttpError } from './catalog-errors.mjs';

test('live catalogs admit new compatible ids and exclude unsupported generation routes', () => {
  const openai = projectMediaModels('openai-oauth', [
    { id: 'gpt-5.6-sol' },
    { id: 'gpt-6-astra' },
    { id: 'gpt-7-mini' },
    { id: 'gpt-7-codex' },
    { id: 'gpt-7-nano' },
    { id: 'gpt-image-3' },
    _normalizeCodexModel({ slug: 'gpt-8-denied', supports_image_generation: false }),
    _normalizeCodexModel({ slug: 'gpt-8-text', supported_tools: ['web_search'] }),
    _normalizeCodexModel({ slug: 'gpt-7-mainline', supported_tools: [{ type: 'image_generation' }] }),
  ]);
  assert.deepEqual(
    openai.image.map((row) => row.id),
    ['gpt-image-2']
  );
  assert.equal(openai.image[0].requestModel, 'gpt-7-mainline');
  assert.equal(openai.image[0].controls.size, undefined);
  assert.equal(openai.image[0].controls.quality, undefined);
  assert.deepEqual(
    projectMediaModels('openai-oauth', [
      { id: 'gpt-image-2.5-flare' },
      { id: 'gpt-8-codex' },
      { id: 'gpt-8-denied', supportsImageGeneration: false },
    ]).image,
    []
  );
  assert.deepEqual(openai.video, []);

  const xai = projectMediaModels('xai', [
    { id: 'grok-imagine-image' },
    { id: 'grok-imagine-image-2.0' },
    { id: 'grok-imagine-image-2.0' },
    { id: 'grok-imagine-video' },
    { id: 'grok-imagine-video-1.5' },
    { id: 'grok-4.6' },
    { id: 'grok-imagine-image-3.0', deprecated: true },
  ]);
  assert.equal(xai.image[0].id, 'grok-imagine-image-2.0');
  assert.equal(xai.image.length, 2);
  assert.deepEqual(
    xai.video.map((row) => row.id),
    ['grok-imagine-video']
  );
  assert.deepEqual(xai.video[0].controls.resolution, ['480p', '720p']);

  const gemini = projectMediaModels('gemini', [
    {
      name: 'models/gemini-3.1-flash-lite-image',
      displayName: 'Nano Banana 2 Lite',
      supportedGenerationMethods: ['generateContent'],
    },
    { name: 'models/gemini-4-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-9-image', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-3.8-flash' },
    { name: 'models/gemini-omni-flash-preview' },
    { name: 'models/gemini-omni-1.1-flash' },
    { name: 'models/veo-3.1-generate-preview', supportedGenerationMethods: ['predictLongRunning'] },
    { name: 'models/veo-2.0-generate-001', supportedGenerationMethods: ['predictLongRunning'] },
    { name: 'models/imagen-4-generate' },
  ]);
  assert.deepEqual(
    gemini.image.map((row) => row.id),
    ['gemini-4-flash-image', 'gemini-3.1-flash-lite-image']
  );
  assert.equal(gemini.image[1].label, 'Nano Banana 2 Lite · Gemini 3.1 Flash Lite Image');
  assert.equal(gemini.video[0].id, 'gemini-omni-1.1-flash');
  assert.deepEqual(gemini.video[0].controls, { resolution: [], durations: [], maxReferences: 3 });
  assert.equal(gemini.video.length, 3);

  // The gateway catalog lists chat, IDE-internal and image ids side by side
  // without generation methods; only Nano Banana ids become image options and
  // video-input support never turns a chat model into a video generator.
  const antigravity = projectMediaModels('antigravity-oauth', [
    { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)', maxTokens: 1048576, supportsVideo: true },
    { id: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image' },
    { id: 'gemini-3.1-flash-lite-image-preview', displayName: 'Gemini 3.1 Flash Lite Image' },
    { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)', maxTokens: 250000 },
    { id: 'chat_23310', maxTokens: 32768 },
  ]);
  assert.deepEqual(
    antigravity.image.map((row) => row.id),
    ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image-preview']
  );
  assert.equal(antigravity.image[0].label, 'Nano Banana 2 · Gemini 3.1 Flash Image');
  assert.deepEqual(antigravity.video, []);
});

test('Antigravity discovery reads the gateway model map with the hub identity', async () => {
  const requests = [];
  const rows = await fetchMediaModelRows({
    lane: 'antigravity-oauth',
    auth: { token: 'access-token', projectId: 'projects/test' },
    fetchFn: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          models: {
            'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image' },
            'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', maxTokens: 1048576 },
          },
        }),
      };
    },
  });
  assert.deepEqual(rows, [
    { id: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image' },
    { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)', maxTokens: 1048576 },
  ]);
  assert.match(requests[0].url, /\/v1internal:fetchAvailableModels$/);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer access-token');
  assert.match(requests[0].init.headers['User-Agent'], /^antigravity\/hub\//);
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].init.body), { project: 'projects/test' });
});

test('discovery keeps raw media rows, follows Gemini pages and refuses credential redirects', async () => {
  const requests = [];
  const rows = [{ id: 'grok-imagine-image-2.0' }, { id: 'grok-imagine-video' }];
  assert.deepEqual(
    await fetchMediaModelRows({
      lane: 'xai',
      auth: { token: 'test-key', baseURL: 'https://api.x.ai/v1' },
      fetchFn: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, json: async () => ({ data: rows }) };
      },
    }),
    rows
  );
  assert.equal(requests[0].url, 'https://api.x.ai/v1/models');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-key');

  const gemini = await fetchMediaModelRows({
    lane: 'gemini',
    auth: { token: 'test-key' },
    fetchFn: async (url, init) => {
      requests.push({ url, init });
      const second = new URL(url).searchParams.get('pageToken') === 'next';
      return {
        ok: true,
        json: async () =>
          second
            ? { models: [{ name: 'models/gemini-omni-1.1-flash' }] }
            : { models: [{ name: 'models/gemini-3.1-flash-lite-image' }], nextPageToken: 'next' },
      };
    },
  });
  assert.equal(gemini.length, 2);
  assert.equal(requests.length, 3);
  for (const { init } of requests) {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
  }
  for (const lane of ['xai', 'gemini']) {
    await assert.rejects(
      fetchMediaModelRows({
        lane,
        auth: { token: 'test-key', baseURL: 'https://api.x.ai/v1' },
        fetchFn: async () => ({ ok: true, json: async () => ({ error: 'unavailable' }) }),
      }),
      /Invalid .*catalog response/
    );
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
      key: `${lane}-${scope}`,
      revision,
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
    cache: () => {
      throw new Error('must use the provider cache');
    },
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
  assert.match(gemini.image.find((row) => row.id.endsWith('image-preview')).label, /Preview/);
  assert.equal(new Set(gemini.image.map((row) => row.label)).size, 4);
  const grok = projectMediaModels('grok-oauth', [
    { id: 'grok-imagine-image' },
    { id: 'grok-imagine-image-quality' },
    { id: 'grok-imagine-image-2.0' },
  ]);
  assert.deepEqual(
    new Set(grok.image.map((row) => row.label)),
    new Set(['Grok Imagine Image', 'Grok Imagine Image Quality', 'Grok Imagine Image 2.0'])
  );
});

test('catalog outages expose stale state, but billing and credential rejection cannot reuse it', async () => {
  const old = [{ id: 'grok-imagine-image' }];
  for (const status of [401, 403, 429, 503]) {
    const error = catalogHttpError(
      status,
      status === 403 ? '{"error":"team secret-id has reached its spending limit"}' : ''
    );
    const load = createMediaModelLoader({
      source: async () => ({
        key: 'same-account',
        fetchModels: async () => {
          throw error;
        },
      }),
      cache: (_key, stale) => ({ loadSync: () => (stale ? old : null) }),
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

// Rows in the documented `GET /images/models` shapes:
// https://openrouter.ai/docs/api/api-reference/images/list-image-generation-models
// https://docs.nano-gpt.com/api-reference/endpoint/image-api-models
const OPENROUTER_IMAGE_ROWS = [
  {
    id: 'bytedance-seed/seedream-4.5',
    name: 'Seedream 4.5',
    description: 'A text-to-image model.',
    created: 1692901234,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
    supported_parameters: {
      resolution: { type: 'enum', values: ['1K', '2K', '4K'] },
      aspect_ratio: { type: 'enum', values: ['auto', '1:1', '16:9'] },
      seed: { type: 'boolean' },
      output_compression: { type: 'range', min: 0, max: 100 },
    },
    supports_streaming: false,
    endpoints: '/api/v1/images/models/bytedance-seed/seedream-4.5/endpoints',
  },
  {
    id: 'qwen/qwen-image-2.1-turbo',
    name: 'Qwen Image 2.1 Turbo',
    created: 1792901234,
    architecture: { input_modalities: ['text'], output_modalities: ['image'] },
    supported_parameters: { quality: { type: 'enum', values: ['auto', 'low', 'high'] } },
  },
  {
    id: 'openai/gpt-5.6-chat',
    name: 'Chat only',
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    supported_parameters: {},
  },
];
const NANO_GPT_IMAGE_ROWS = [
  {
    id: 'openai/gpt-image-2.5/flare/text-to-image',
    name: 'GPT Image 2.5 Flare',
    created: 1760000000,
    owned_by: 'openai',
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
    supported_parameters: {
      resolution: { type: 'enum', values: ['1k', '2k', '4k'], default: '1k' },
      n: { type: 'range', min: 1, max: 4, default: 1 },
      quality: { type: 'enum', values: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
      background: { type: 'enum', values: ['auto', 'opaque', 'transparent'] },
      input_references: { type: 'range', min: 0, max: 8 },
    },
    capabilities: { image_generation: true, image_to_image: true, inpainting: false, nsfw: false },
    category: 'image',
  },
  {
    id: 'upscaler/clarity',
    name: 'Clarity Upscaler',
    architecture: { input_modalities: ['image'], output_modalities: ['image'] },
    supported_parameters: {},
    capabilities: { image_generation: false, image_to_image: true },
  },
];

test('Image API catalogs keep image-output models and publish only the parameters each model advertises', () => {
  const openrouter = projectMediaModels('openrouter', OPENROUTER_IMAGE_ROWS);
  assert.deepEqual(openrouter.video, []);
  assert.deepEqual(
    openrouter.image.map((row) => [row.id, row.label]),
    [
      ['qwen/qwen-image-2.1-turbo', 'Qwen Image 2.1 Turbo'],
      ['bytedance-seed/seedream-4.5', 'Seedream 4.5'],
    ]
  );
  assert.deepEqual(openrouter.image[0].controls, { quality: ['auto', 'low', 'high'], maxReferences: 0 });
  assert.deepEqual(openrouter.image[1].controls, {
    aspectRatio: ['auto', '1:1', '16:9'],
    resolution: ['1K', '2K', '4K'],
    maxReferences: 16,
  });

  const nano = projectMediaModels('nano-gpt', NANO_GPT_IMAGE_ROWS);
  assert.deepEqual(
    nano.image.map((row) => row.id),
    ['openai/gpt-image-2.5/flare/text-to-image'],
    'a model that cannot generate from a prompt alone stays out'
  );
  assert.deepEqual(nano.image[0].controls, {
    resolution: ['1k', '2k', '4k'],
    quality: ['low', 'medium', 'high', 'xhigh', 'max'],
    background: ['auto', 'opaque', 'transparent'],
    maxReferences: 8,
  });
});

test('gateway image catalogs get the slow-gateway timeout; other catalogs keep theirs', () => {
  // api.nano-gpt.com's /models took ~44 s to answer, so the 10 s default would
  // turn a slow catalog into "no models".
  assert.equal(mediaCatalogTimeoutMs('nano-gpt'), 60_000);
  assert.equal(mediaCatalogTimeoutMs('openrouter'), 60_000);
  for (const lane of ['xai', 'grok-oauth', 'gemini', 'antigravity-oauth'])
    assert.equal(mediaCatalogTimeoutMs(lane), 10_000);
});

test('Image API discovery reads /images/models from the lane base with the lane key', async (t) => {
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    const rows = req.url.startsWith('/nano') ? NANO_GPT_IMAGE_ROWS : OPENROUTER_IMAGE_ROWS;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(req.url.startsWith('/nano') ? { object: 'list', data: rows, meta: { count: 2 } } : { data: rows })
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const openrouter = await fetchMediaModelRows({
    lane: 'openrouter',
    auth: { baseURL: `${origin}/api/v1`, token: 'or-key' },
  });
  const nano = await fetchMediaModelRows({
    lane: 'nano-gpt',
    auth: { baseURL: `${origin}/nano/api/v1`, token: 'ng-key' },
  });
  assert.deepEqual(openrouter, OPENROUTER_IMAGE_ROWS);
  assert.deepEqual(nano, NANO_GPT_IMAGE_ROWS);
  assert.deepEqual(seen, [
    { url: '/api/v1/images/models', authorization: 'Bearer or-key' },
    { url: '/nano/api/v1/images/models', authorization: 'Bearer ng-key' },
  ]);
});
