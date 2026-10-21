// The Studio's bounded lane listing through the real session surface: the
// session-api passthrough over the runtime media API over the lane catalog.
// Every fetch is answered in-process, so no request leaves this test.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMediaApi } from '../../../session-runtime/media-api.mjs';
import { createSessionMediaApi } from './media.mjs';

// GET /images/models as documented (OpenRouter Image API model listing).
const IMAGE_MODELS = {
  data: [
    {
      id: 'qwen/qwen-image-2.1-turbo',
      name: 'Qwen Image 2.1 Turbo',
      architecture: { input_modalities: ['text'], output_modalities: ['image'] },
      supported_parameters: {},
    },
  ],
};

test('listMediaLanes forwards budgetMs: a slow gateway catalog answers pending, then lands', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-session-media-'));
  const keys = [
    'MIXDOG_DATA_DIR',
    'MIXDOG_SKIP_USER_DATA_BACKUP',
    'OPENAI_OAUTH_CREDENTIALS_PATH',
    'OPENROUTER_API_KEY',
    'XAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const realFetch = globalThis.fetch;
  let release;
  const catalogAnswered = new Promise((resolve) => {
    release = resolve;
  });
  const catalogCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target !== 'https://openrouter.ai/api/v1/images/models') {
      return new Response('{"error":"offline test"}', { status: 503 });
    }
    catalogCalls.push(init.headers?.Authorization);
    await catalogAnswered;
    return Response.json(IMAGE_MODELS);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    release();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.MIXDOG_DATA_DIR = dir;
  process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
  process.env.OPENAI_OAUTH_CREDENTIALS_PATH = join(dir, 'absent-openai.json');
  process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
  for (const key of ['XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) delete process.env[key];

  const session = createSessionMediaApi({ runtime: createMediaApi() });
  const openRouter = (rows) => rows.find((row) => row.id === 'openrouter');

  const started = Date.now();
  const pending = openRouter(await session.listMediaLanes({ budgetMs: 300 }));
  assert.ok(Date.now() - started < 5_000, 'the budget bounds the listing instead of waiting on the slow catalog');
  assert.equal(pending.authenticated, true);
  assert.equal(pending.catalogPending, true);
  assert.deepEqual(pending.kinds, []);

  // The re-poll joins the request already running; the catalog then lands.
  const again = session.listMediaLanes({ budgetMs: 5_000 });
  release();
  const ready = openRouter(await again);
  assert.equal(ready.catalogPending, undefined);
  assert.deepEqual(
    ready.image.models.map((model) => model.id),
    ['qwen/qwen-image-2.1-turbo']
  );
  assert.equal(catalogCalls.length, 1, 'one catalog request served both listings');
});
