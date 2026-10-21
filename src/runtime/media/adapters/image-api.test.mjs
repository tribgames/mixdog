// Image API lanes (OpenRouter, NanoGPT) against local fake servers that answer
// with the documented response shapes; no request leaves this machine.
//   https://openrouter.ai/docs/api/api-reference/images/generate-an-image
//   https://docs.nano-gpt.com/api-reference/image-generation
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-image-api-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

// A real 1x1 PNG, so the stored format is decided from actual bytes.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c6360000002000100ffff03000006000557bfabd400000000' +
    '49454e44ae426082',
  'hex'
);

let respond = () => ({ status: 500, body: {} });
const requests = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    const request = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    requests.push(request);
    const { status = 200, body, bytes, type = 'application/json' } = respond(request);
    res.writeHead(status, { 'content-type': type });
    res.end(bytes ?? JSON.stringify(body));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const BASES = { openrouter: `${origin}/openrouter/api/v1`, 'nano-gpt': `${origin}/nano/api/v1` };

const here = (path) => new URL(path, import.meta.url).href;
mock.module(here('../auth.mjs'), {
  namedExports: { resolveImageApiAuth: (lane) => ({ baseURL: BASES[lane], token: `${lane}-test-key` }) },
});
// The public-download SSRF guard refuses loopback; the signed-URL path reads
// the fake server directly instead.
mock.module(here('../download.mjs'), {
  namedExports: {
    MAX_GENERATED_MEDIA_BYTES: 256 * 1024 * 1024,
    decodeBase64Media: (value) => Buffer.from(value, 'base64'),
    downloadPublicMedia: async (url) => Buffer.from(await (await fetch(url)).arrayBuffer()),
  },
});
mock.module(here('../lanes.mjs'), {
  namedExports: {
    mediaError: (message, code, status) => Object.assign(new Error(message), { code, status }),
    mediaLaneAccountProvider: () => '',
    resolveMediaRequest: async ({ lane, kind, model }) => ({
      lane: { id: lane },
      kind,
      model,
      spec: { models: [{ id: model, controls: { maxReferences: 4 } }], controls: {} },
    }),
  },
});
const { generateImage } = await import('./image-api.mjs');
const jobs = await import('../jobs.mjs');
const store = await import('../store.mjs');
const { executeMediaTool } = await import('../tool.mjs');

after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const openRouterReply = (cost = 0.04) => ({
  body: {
    created: 1748372400,
    data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }],
    usage: { prompt_tokens: 12, completion_tokens: 4175, total_tokens: 4187, cost },
  },
});

test('OpenRouter: model enums and references ride the documented request; base64 bytes and cost come back', async () => {
  requests.length = 0;
  respond = () => openRouterReply();
  const result = await generateImage({
    lane: 'openrouter',
    model: 'bytedance-seed/seedream-4.5',
    prompt: 'a red panda astronaut',
    options: { aspectRatio: '16:9', resolution: '2K', quality: '' },
    references: [{ base64: 'QUJD', mime: 'image/jpeg' }],
  });
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/openrouter/api/v1/images');
  assert.equal(request.headers.authorization, 'Bearer openrouter-test-key');
  assert.deepEqual(request.body, {
    model: 'bytedance-seed/seedream-4.5',
    prompt: 'a red panda astronaut',
    n: 1,
    aspect_ratio: '16:9',
    resolution: '2K',
    input_references: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }],
  });
  assert.ok(result.bytes.equals(PNG));
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4175, costUsd: 0.04 });
});

test('NanoGPT: a signed-URL answer is downloaded; top-level cost counts only when paid in USD', async () => {
  requests.length = 0;
  let paymentSource = 'USD';
  respond = (request) =>
    request.url === '/signed/out.png'
      ? { bytes: PNG, type: 'image/png' }
      : {
          body: {
            created: 123,
            data: [{ url: `${origin}/signed/out.png` }],
            cost: 0.153,
            paymentSource,
            remainingBalance: 4.2,
          },
        };
  const usd = await generateImage({
    lane: 'nano-gpt',
    model: 'openai/gpt-image-2.5/flare/text-to-image',
    prompt: 'an espresso machine',
    options: { resolution: '1k', quality: 'high' },
  });
  assert.equal(requests[0].url, '/nano/api/v1/images');
  assert.equal(requests[0].headers.authorization, 'Bearer nano-gpt-test-key');
  assert.deepEqual(requests[0].body, {
    model: 'openai/gpt-image-2.5/flare/text-to-image',
    prompt: 'an espresso machine',
    n: 1,
    resolution: '1k',
    quality: 'high',
  });
  assert.equal(requests[1].url, '/signed/out.png');
  assert.ok(usd.bytes.equals(PNG));
  assert.deepEqual(usd.usage, { costUsd: 0.153 });

  paymentSource = 'XNO';
  const nano = await generateImage({ lane: 'nano-gpt', model: 'hidream', prompt: 'p' });
  assert.equal(nano.usage, null, 'a cost billed in XNO is not recorded as USD');
});

test('upstream failures map to media error codes without leaking raw markup', async () => {
  const cases = [
    [401, { error: { code: 401, message: 'Missing Authentication header' } }, 'MEDIA_AUTH_REJECTED'],
    [402, { error: { code: 402, message: 'Insufficient credits.' } }, 'MEDIA_BILLING_BLOCKED'],
    [429, { error: { code: 429, message: 'Rate limit exceeded' } }, 'MEDIA_RATE_LIMITED'],
    [
      400,
      {
        error: {
          message: 'model is required for /api/v1/images.',
          type: 'invalid_request_error',
          code: 'missing_model',
        },
      },
      'MEDIA_UPSTREAM_FAILED',
    ],
    [502, { error: { code: 502, message: 'Provider returned error' } }, 'MEDIA_UPSTREAM_FAILED'],
  ];
  for (const [status, body, code] of cases) {
    respond = () => ({ status, body });
    await assert.rejects(generateImage({ lane: 'openrouter', model: 'm', prompt: 'p' }), (error) => {
      assert.equal(error.code, code, `HTTP ${status}`);
      assert.equal(error.status, status);
      return true;
    });
  }
  respond = () => ({ body: { created: 1, data: [], usage: { cost: 0.01 } } });
  await assert.rejects(generateImage({ lane: 'nano-gpt', model: 'm', prompt: 'p' }), (error) => {
    assert.equal(error.code, 'MEDIA_EMPTY_RESULT');
    assert.deepEqual(error.usage, { costUsd: 0.01 }, 'a billed empty answer still reports its cost');
    return true;
  });
  respond = () => ({
    body: { created: 1, data: [{ b64_json: Buffer.from('<svg/>').toString('base64'), media_type: 'image/svg+xml' }] },
  });
  await assert.rejects(generateImage({ lane: 'openrouter', model: 'recraft/vector', prompt: 'p' }), {
    code: 'MEDIA_UPSTREAM_FAILED',
    message: /unsupported image format/,
  });
});

test('the media tool generates through the lane, uploads the reference file and writes the output path', async () => {
  requests.length = 0;
  respond = () => openRouterReply();
  const cwd = mkdtempSync(join(dataDir, 'project-'));
  writeFileSync(join(cwd, 'ref.png'), PNG);
  const lane = {
    id: 'openrouter',
    label: 'OpenRouter',
    authType: 'api-key',
    authenticated: true,
    kinds: ['image'],
    image: {
      defaultModel: 'google/gemini-3.1-flash-image',
      models: [
        {
          id: 'google/gemini-3.1-flash-image',
          label: 'Nano Banana 2',
          controls: { aspectRatio: ['1:1', '16:9'], maxReferences: 4 },
        },
      ],
      controls: {},
    },
    video: null,
  };
  const deps = {
    lanes: { listMediaLanes: async () => [lane], mediaLaneAccountProvider: () => '' },
    jobs,
    store,
    defaults: { getMediaDefault: () => null, getMediaPin: () => null },
    accounts: {},
  };
  const result = await executeMediaTool(
    {
      action: 'generate',
      kind: 'image',
      lane: 'openrouter',
      prompt: 'a lighthouse at dusk',
      path: 'out/lighthouse',
      aspect: '16:9',
      references: ['ref.png'],
    },
    { cwd, deps }
  );
  const value = JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined, value.error);
  assert.equal(value.output, join(cwd, 'out', 'lighthouse.png'));
  assert.ok(readFileSync(value.output).equals(PNG));
  assert.deepEqual(value.options, { aspectRatio: '16:9' }, 'no resolution is invented for a gateway model');
  const sent = requests.find((request) => request.url === '/openrouter/api/v1/images').body;
  assert.equal(sent.model, 'google/gemini-3.1-flash-image');
  assert.equal(sent.aspect_ratio, '16:9');
  assert.deepEqual(sent.input_references, [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
  ]);
});
