import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Catalog + ledger must be configured before any pricing module loads.
const directory = mkdtempSync(join(tmpdir(), 'mixdog-media-usage-'));
process.env.MIXDOG_DATA_DIR = directory;
process.env.MIXDOG_USAGE_LEDGER_PATH = ':memory:';
const geminiImage = {
  litellm_provider: 'gemini',
  mode: 'image_generation',
  input_cost_per_token: 2e-6,
  output_cost_per_token: 12e-6,
  output_cost_per_image_token: 1.2e-4,
  output_cost_per_image: 0.134,
};
const litellm = {
  'gemini/gemini-3-pro-image-preview': geminiImage,
  'gemini/gemini-3-pro-image': geminiImage,
  'gemini/veo-3.1-fast-generate-preview': {
    litellm_provider: 'gemini',
    mode: 'video_generation',
    output_cost_per_second: 0.1,
    output_cost_per_second_1080p: 0.12,
  },
  'gemini/gemini-omni-flash-preview': {
    litellm_provider: 'gemini',
    mode: 'chat',
    input_cost_per_token: 1.5e-6,
    output_cost_per_token: 9e-6,
    output_cost_per_video_token: 1.75e-5,
  },
  'xai/grok-imagine-video': {
    litellm_provider: 'xai',
    mode: 'video_generation',
    output_cost_per_second: 0.05,
    output_cost_per_second_480p: 0.05,
    output_cost_per_second_720p: 0.07,
  },
  'openai/gpt-5.6-sol': {
    litellm_provider: 'openai',
    input_cost_per_token: 2e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.2e-6,
  },
};
writeFileSync(join(directory, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: litellm }));
writeFileSync(join(directory, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));

const here = (path) => new URL(path, import.meta.url).href;
const mediaError = (message, code, status) => Object.assign(new Error(message), { code, status });
const REQUEST_MODELS = { 'openai-oauth': 'gpt-5.6-sol' };
mock.module(here('./auth.mjs'), {
  namedExports: {
    resolveXaiAuth: async () => ({ baseURL: 'https://xai.invalid/v1', token: 't' }),
    resolveGeminiKey: () => 'key',
    resolveCodexAuth: async () => ({ access_token: 'token', account_id: 'account' }),
    resolveAntigravityAuth: async () => ({ token: 'token', projectId: 'projects/test' }),
  },
});
mock.module(here('./download.mjs'), {
  namedExports: {
    MAX_GENERATED_MEDIA_BYTES: 1e9,
    decodeBase64Media: (value) => Buffer.from(value, 'base64'),
    downloadPublicMedia: async () => Buffer.from('mp4'),
    downloadGeminiMedia: async () => geminiDownload(),
  },
});
let geminiDownload = async () => Buffer.from('mp4');
mock.module(here('./lanes.mjs'), {
  namedExports: {
    mediaError,
    resolveMediaRequest: async ({ lane, kind, model }) => ({
      kind,
      lane: { id: lane },
      model,
      spec: { models: [{ id: model, requestModel: REQUESTED[lane], controls: { maxReferences: 1 } }] },
    }),
  },
});
const REQUESTED = REQUEST_MODELS;
mock.module(here('./store.mjs'), { namedExports: { saveMediaAsset: () => ({ id: 'asset' }) } });
mock.module(here('./defaults.mjs'), { namedExports: { setMediaDefault: () => {} } });

const { getMediaJob, startMediaJob } = await import('./jobs.mjs');
const { recordMediaUsage } = await import('./media-usage.mjs');
const { getUsageLedger } = await import('../shared/llm/usage-ledger.mjs');
const { usageStatsSnapshot } = await import('../../session-runtime/services/usage-stats-model.mjs');

const ledger = getUsageLedger();
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
// The video adapters poll every 4-8 seconds; collapse only those waits.
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === 4000 || ms === 8000 ? 0 : ms, ...rest);
test.after(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const eventRows = () => ledger.db.prepare('SELECT * FROM events').all();

/** Run one job against a fake upstream; returns the job and the ledger rows it wrote. */
async function generate(request, upstream) {
  globalThis.fetch = async (url, init) => upstream(String(url), init) ?? json({}, 404);
  const known = new Set(eventRows().map((row) => row.id));
  const started = await startMediaJob(request);
  for (let i = 0; i < 400 && getMediaJob(started.id).status === 'running'; i++)
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  const job = getMediaJob(started.id);
  return { job, rows: eventRows().filter((row) => !known.has(row.id)) };
}

test('xai image: the billed cost is recorded as provider cost; grok-oauth keeps it as subscription', async () => {
  const body = (ticks) => ({ data: [{ b64_json: 'aW1n' }], ...(ticks ? { usage: { cost_in_usd_ticks: ticks } } : {}) });
  const api = await generate(
    { lane: 'xai', kind: 'image', model: 'grok-imagine-image-2.0', prompt: 'p', sessionId: 's-api', sourceType: 'lead' },
    () => json(body(400000000))
  );
  assert.equal(api.job.status, 'done');
  assert.equal(api.rows.length, 1);
  assert.deepEqual(
    [api.rows[0].provider, api.rows[0].model, api.rows[0].cost_usd, api.rows[0].cost_source],
    ['xai', 'grok-imagine-image-2.0', 0.04, 'provider']
  );
  assert.equal(api.rows[0].session_id, 's-api');
  assert.equal(api.rows[0].source_type, 'lead');

  const oauth = await generate({ lane: 'grok-oauth', kind: 'image', model: 'grok-imagine-image', prompt: 'p' }, () =>
    json(body(200000000))
  );
  assert.deepEqual(
    [oauth.rows[0].provider, oauth.rows[0].cost_usd, oauth.rows[0].cost_source],
    ['grok-oauth', 0.02, 'subscription']
  );

  const unreported = await generate({ lane: 'xai', kind: 'image', model: 'grok-imagine-image', prompt: 'p' }, () =>
    json(body(0))
  );
  assert.equal(unreported.rows.length, 1);
  assert.equal(unreported.rows[0].cost_usd, null);
  assert.equal(unreported.rows[0].cost_source, 'unpriced');
});

test('xai video: reported cost wins; otherwise seconds x the catalog per-second rate; failures only with reported usage', async () => {
  const upstream = (done) => (url) => {
    if (url.endsWith('/videos/generations')) return json({ request_id: 'r1' });
    return json(done);
  };
  const video = { url: 'https://cdn.invalid/v.mp4', duration: 5 };
  const reported = await generate(
    { lane: 'xai', kind: 'video', model: 'grok-imagine-video', prompt: 'p' },
    upstream({ status: 'done', video, usage: { cost_in_usd_ticks: 250000000 } })
  );
  assert.deepEqual([reported.rows[0].cost_usd, reported.rows[0].cost_source], [0.025, 'provider']);

  const estimated = await generate(
    { lane: 'grok-oauth', kind: 'video', model: 'grok-imagine-video', prompt: 'p', options: { resolution: '720p' } },
    upstream({ status: 'done', video })
  );
  assert.deepEqual(
    [estimated.rows[0].cost_usd, estimated.rows[0].cost_source, estimated.rows[0].provider],
    [0.35, 'subscription', 'grok-oauth']
  );

  const failedBilled = await generate(
    { lane: 'xai', kind: 'video', model: 'grok-imagine-video', prompt: 'p' },
    upstream({ status: 'failed', usage: { cost_in_usd_ticks: 100000000 } })
  );
  assert.equal(failedBilled.job.status, 'failed');
  assert.equal(failedBilled.rows.length, 1);
  assert.equal(failedBilled.rows[0].cost_usd, 0.01);

  const failedFree = await generate(
    { lane: 'xai', kind: 'video', model: 'grok-imagine-video', prompt: 'p' },
    upstream({ status: 'failed' })
  );
  assert.equal(failedFree.job.status, 'failed');
  assert.equal(failedFree.rows.length, 0);
});

test('openai-oauth: Responses usage prices the orchestrator model as subscription', async () => {
  const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const image = {
    type: 'response.output_item.done',
    item: { type: 'image_generation_call', result: 'aW1n' },
  };
  const completed = {
    type: 'response.completed',
    response: { usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 100 } },
  };
  const { job, rows } = await generate(
    { lane: 'openai-oauth', kind: 'image', model: 'chatgpt-image-auto', prompt: 'p', sessionId: 's-codex' },
    (url) => (url.includes('responses') ? new Response(sse([image, completed])) : undefined)
  );
  assert.equal(job.status, 'done');
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual(
    [row.provider, row.model, row.input, row.output, row.cache_read, row.cost_usd, row.cost_source, row.session_id],
    ['openai-oauth', 'chatgpt-image-auto', 800, 100, 200, 0.00264, 'subscription', 's-codex']
  );
  assert.equal(JSON.parse(row.rates).pricingModel, 'gpt-5.6-sol');

  const failed = await generate(
    { lane: 'openai-oauth', kind: 'image', model: 'chatgpt-image-auto', prompt: 'p' },
    (url) => (url.includes('responses') ? new Response(sse([{ ...completed, type: 'response.failed' }])) : undefined)
  );
  assert.equal(failed.job.status, 'failed');
  assert.equal(failed.rows.length, 1, 'a failure with reported usage is still recorded');
  const silent = await generate(
    { lane: 'openai-oauth', kind: 'image', model: 'chatgpt-image-auto', prompt: 'p' },
    (url) => (url.includes('responses') ? new Response(sse([{ type: 'response.failed', response: {} }])) : undefined)
  );
  assert.equal(silent.rows.length, 0, 'tokens are never invented for a failure');
});

const imageUsage = {
  promptTokenCount: 100,
  candidatesTokenCount: 1300,
  thoughtsTokenCount: 50,
  candidatesTokensDetails: [
    { modality: 'IMAGE', tokenCount: 1120 },
    { modality: 'TEXT', tokenCount: 180 },
  ],
};
const imagePart = { inlineData: { mimeType: 'image/png', data: 'aW1n' } };

test('gemini image: usageMetadata prices image tokens at the image-token rate; no usage falls back to per-image', async () => {
  const reported = await generate(
    { lane: 'gemini', kind: 'image', model: 'gemini-3-pro-image-preview', prompt: 'p', sessionId: 's-gem' },
    () => json({ candidates: [{ content: { parts: [imagePart] } }], usageMetadata: imageUsage })
  );
  const [row] = reported.rows;
  assert.deepEqual(
    [row.provider, row.model, row.input, row.output, row.cost_usd, row.cost_source, row.session_id],
    ['gemini', 'gemini-3-pro-image-preview', 100, 1350, 0.13736, 'catalog', 's-gem']
  );

  const unreported = await generate(
    { lane: 'gemini', kind: 'image', model: 'gemini-3-pro-image-preview', prompt: 'p' },
    () => json({ candidates: [{ content: { parts: [imagePart] } }] })
  );
  assert.deepEqual([unreported.rows[0].input, unreported.rows[0].output, unreported.rows[0].cost_usd], [0, 0, 0.134]);

  const unlisted = await generate({ lane: 'gemini', kind: 'image', model: 'unlisted-image', prompt: 'p' }, () =>
    json({ candidates: [{ content: { parts: [imagePart] } }], usageMetadata: imageUsage })
  );
  assert.equal(unlisted.rows[0].cost_usd, null);
  assert.equal(unlisted.rows[0].cost_source, 'unpriced');
  assert.equal(unlisted.rows[0].output, 1350);

  const refusal = await generate({ lane: 'gemini', kind: 'image', model: 'gemini-3-pro-image-preview', prompt: 'p' }, () =>
    json({ candidates: [{ content: { parts: [{ text: 'no' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } })
  );
  assert.equal(refusal.job.status, 'failed');
  assert.equal(refusal.rows.length, 1);
  assert.deepEqual([refusal.rows[0].input, refusal.rows[0].output], [10, 2]);

  const rejected = await generate({ lane: 'gemini', kind: 'image', model: 'gemini-3-pro-image-preview', prompt: 'p' }, () =>
    json({ error: { message: 'bad' } }, 400)
  );
  assert.equal(rejected.rows.length, 0);
});

test('antigravity-oauth: the final streamed usageMetadata is recorded as subscription usage', async () => {
  const chunk = (response) => `data: ${JSON.stringify({ response })}\n\n`;
  const { job, rows } = await generate(
    { lane: 'antigravity-oauth', kind: 'image', model: 'gemini-3-pro-image', prompt: 'p', sessionId: 's-ag' },
    (url) =>
      url.includes('streamGenerateContent')
        ? {
            ok: true,
            status: 200,
            text: async () =>
              chunk({ candidates: [{ content: { parts: [imagePart] } }], usageMetadata: { promptTokenCount: 1 } }) +
              chunk({ usageMetadata: imageUsage }),
          }
        : undefined
  );
  assert.equal(job.status, 'done');
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].provider, rows[0].model, rows[0].input, rows[0].output, rows[0].cost_usd, rows[0].cost_source],
    ['antigravity-oauth', 'gemini-3-pro-image', 100, 1350, 0.13736, 'subscription']
  );
  assert.equal(rows[0].session_id, 's-ag');
});

test('gemini video: Veo bills requested seconds at the resolution rate; omni prices video output tokens', async () => {
  const veo = await generate(
    {
      lane: 'gemini',
      kind: 'video',
      model: 'veo-3.1-fast-generate-preview',
      prompt: 'p',
      options: { resolution: '1080p', duration: 6 },
    },
    (url) => {
      if (url.endsWith(':predictLongRunning')) return json({ name: 'operations/1' });
      if (url.endsWith('operations/1'))
        return json({
          done: true,
          response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://x/v' } }] } },
        });
      return undefined;
    }
  );
  assert.equal(veo.job.status, 'done');
  assert.deepEqual(
    [veo.rows[0].input, veo.rows[0].output, veo.rows[0].cost_usd, veo.rows[0].cost_source],
    [0, 0, 0.72, 'catalog']
  );

  // A generated video whose download fails was still billed for its seconds.
  geminiDownload = async () => {
    throw new Error('download failed');
  };
  try {
    const lost = await generate(
      {
        lane: 'gemini',
        kind: 'video',
        model: 'veo-3.1-fast-generate-preview',
        prompt: 'p',
        options: { resolution: '1080p', duration: 6 },
      },
      (url) => {
        if (url.endsWith(':predictLongRunning')) return json({ name: 'operations/2' });
        if (url.endsWith('operations/2'))
          return json({
            done: true,
            response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://x/v2' } }] } },
          });
        return undefined;
      }
    );
    assert.equal(lost.job.status, 'failed');
    assert.deepEqual(
      lost.rows.map((row) => row.cost_usd),
      [0.72]
    );
  } finally {
    geminiDownload = async () => Buffer.from('mp4');
  }

  const omni = await generate(
    { lane: 'gemini', kind: 'video', model: 'gemini-omni-flash-preview', prompt: 'p', sessionId: 's-omni' },
    (url) =>
      url.endsWith('/interactions')
        ? json({
            steps: [{ type: 'model_output', content: [{ type: 'video', data: 'dmlk', mime_type: 'video/mp4' }] }],
            usage: {
              total_input_tokens: 10,
              total_output_tokens: 500,
              total_thought_tokens: 20,
              output_tokens_by_modality: [
                { modality: 'video', tokens: 480 },
                { modality: 'text', tokens: 20 },
              ],
            },
          })
        : undefined
  );
  assert.equal(omni.job.status, 'done');
  assert.deepEqual(
    [omni.rows[0].model, omni.rows[0].input, omni.rows[0].output, omni.rows[0].cost_usd, omni.rows[0].session_id],
    ['gemini-omni-flash-preview', 10, 520, 0.008775, 's-omni']
  );
});

test('a ledger failure is logged and never fails the generation', async (t) => {
  const written = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    written.push(String(chunk));
    return true;
  });
  await recordMediaUsage({ lane: 'gemini', model: 'm', usage: { images: 1 } }, () => {
    throw new Error('disk full');
  });
  assert.match(written.join(''), /\[usage-ledger\] RECORD NOT SAVED: disk full/);
});

test('a generation is recorded without a request duration, so it never reports an output speed', async () => {
  const rows = [];
  await recordMediaUsage(
    { lane: 'gemini', model: 'gemini-3-pro-image', usage: { outputTokens: 1200, images: 1 } },
    () => ({ recordQueued: async (row) => rows.push(row) })
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].output, 1200);
  assert.equal(rows[0].durationMs, 0);
});

test('media rows roll up into provider/model/day totals and per-session tokens', () => {
  const rows = eventRows();
  const stats = usageStatsSnapshot({ rollup: ledger.rollup(), now: Date.now(), source: 'all', days: null });
  assert.equal(stats.totals.turns, rows.length);
  assert.equal(
    stats.totals.tokens,
    rows.reduce((sum, row) => sum + row.input + row.output + row.cache_read + row.cache_write, 0)
  );
  const providers = new Set(stats.providers.map((provider) => provider.provider));
  for (const lane of ['xai', 'grok-oauth', 'openai-oauth', 'gemini', 'antigravity-oauth']) assert.ok(providers.has(lane), lane);
  const gemini = stats.providers.find((provider) => provider.provider === 'gemini');
  assert.ok(gemini.models.some((model) => model.model === 'veo-3.1-fast-generate-preview'));
  assert.equal(stats.daily.reduce((sum, day) => sum + day.turns, 0), rows.length);
  const sessions = new Set(rows.map((row) => row.session_id).filter(Boolean));
  assert.equal(stats.totals.sessions, sessions.size);
});
