import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codexImageRequestBody,
  codexImageRequestHeaders,
  codexImagesRequest,
  codexImagesRequestHeaders,
  generateImage,
} from './codex-image.mjs';
import { CHATGPT_USAGE_URL } from '../chatgpt-usage.mjs';
import { codexUserAgent, codexVersionHeader } from '../../agent/orchestrator/providers/codex-client-meta.mjs';
import { CODEX_RESPONSES_URL } from '../../agent/orchestrator/providers/openai-oauth.mjs';

const GENERATIONS_URL = 'https://chatgpt.com/backend-api/codex/images/generations';
const EDITS_URL = 'https://chatgpt.com/backend-api/codex/images/edits';
const AUTH = { access_token: 'token', account_id: 'acct-secret-123' };

function sse(...events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const imagesOk = () =>
  json({
    created: 1,
    background: 'transparent',
    data: [{ b64_json: Buffer.from('png-bytes').toString('base64'), generation_id: 'g1' }],
    usage: { input_tokens: 17, output_tokens: 2058, output_tokens_details: { image_tokens: 2058 } },
  });

const finalImageEvent = () => ({
  type: 'response.output_item.done',
  item: { type: 'image_generation_call', result: Buffer.from('fallback').toString('base64') },
});

/** Route a mock fetch by URL and record every call. */
function router(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route(init);
  };
  return { calls, fetchFn };
}

const deps = (fetchFn, extra = {}) => ({
  resolveAuth: async () => AUTH,
  warmVersion: async () => {},
  fetchFn,
  ...extra,
});

test('images endpoint request: gpt-image-2, auto size and quality, background only when asked', () => {
  assert.deepEqual(codexImagesRequest({ prompt: 'A fox.' }), {
    url: GENERATIONS_URL,
    body: { prompt: 'A fox.', model: 'gpt-image-2', size: 'auto', quality: 'auto' },
  });
  assert.deepEqual(
    codexImagesRequest({
      prompt: 'Add a hat.',
      options: { background: 'transparent' },
      references: [{ base64: 'Zm9v', mime: 'image/jpeg' }, { base64: 'YmFy' }],
    }),
    {
      url: EDITS_URL,
      body: {
        images: [{ image_url: 'data:image/jpeg;base64,Zm9v' }, { image_url: 'data:image/png;base64,YmFy' }],
        prompt: 'Add a hat.',
        model: 'gpt-image-2',
        size: 'auto',
        quality: 'auto',
        background: 'transparent',
      },
    }
  );
});

test('images endpoint headers carry the account and client identity without the responses beta flag', () => {
  const headers = codexImagesRequestHeaders(AUTH);
  assert.equal(headers.Authorization, 'Bearer token');
  assert.equal(headers['ChatGPT-Account-ID'], 'acct-secret-123');
  assert.equal(headers.originator, 'codex_cli_rs');
  assert.equal(headers.version, codexVersionHeader());
  assert.equal(headers['User-Agent'], codexUserAgent());
  assert.match(headers['x-client-request-id'], /^[0-9a-f]{32}$/);
  assert.equal(headers['OpenAI-Beta'], undefined);
  assert.equal(headers['x-codex-image-turn-id'], undefined);
});

test('generation goes to the images endpoint and reports gpt-image-2 with image tokens', async () => {
  const { calls, fetchFn } = router({ [GENERATIONS_URL]: imagesOk });
  const result = await generateImage(
    { model: 'gpt-6-astra', prompt: 'A fox.', options: { background: 'transparent' } },
    deps(fetchFn)
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(JSON.parse(calls[0].init.body).background, 'transparent');
  assert.equal(result.bytes.toString(), 'png-bytes');
  assert.equal(result.actualModel, 'gpt-image-2');
  assert.deepEqual(result.usage, { inputTokens: 17, outputTokens: 2058, outputImageTokens: 2058 });
});

test('reference images use the edits endpoint', async () => {
  const { calls, fetchFn } = router({ [EDITS_URL]: imagesOk });
  await generateImage(
    { model: 'm', prompt: 'Edit.', references: [{ base64: 'Zm9v', mime: 'image/png' }] },
    deps(fetchFn)
  );
  assert.deepEqual(JSON.parse(calls[0].init.body).images, [{ image_url: 'data:image/png;base64,Zm9v' }]);
});

for (const [name, unavailable] of [
  ['404', () => new Response('', { status: 404 })],
  ['405', () => new Response('', { status: 405 })],
  [
    'edge HTML 403',
    () => new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } }),
  ],
]) {
  test(`an unavailable images endpoint (${name}) falls back to the hosted responses tool`, async () => {
    const { calls, fetchFn } = router({
      [GENERATIONS_URL]: unavailable,
      [CODEX_RESPONSES_URL]: () => sse(finalImageEvent()),
    });
    const result = await generateImage(
      { model: 'gpt-6-astra', prompt: 'A fox.', options: { background: 'transparent' } },
      deps(fetchFn)
    );
    assert.deepEqual(
      calls.map((call) => call.url),
      [GENERATIONS_URL, CODEX_RESPONSES_URL]
    );
    assert.deepEqual(JSON.parse(calls[1].init.body).tools, [{ type: 'image_generation', background: 'transparent' }]);
    assert.equal(result.bytes.toString(), 'fallback');
  });
}

for (const [name, response, code] of [
  ['auth', () => json({ error: { message: 'bad token' } }, 401), 'MEDIA_AUTH_REJECTED'],
  ['JSON 403', () => json({ error: { message: 'forbidden' } }, 403), 'MEDIA_AUTH_REJECTED'],
  ['billing', () => json({ error: { message: 'insufficient credits' } }, 402), 'MEDIA_BILLING_BLOCKED'],
  ['rate limit', () => json({ error: { message: 'slow down' } }, 429), 'MEDIA_RATE_LIMITED'],
  [
    'usage limit',
    () => json({ error: { type: 'usage_limit_reached', resets_at: 1792218828 } }, 429),
    'MEDIA_USAGE_LIMIT',
  ],
]) {
  test(`a ${name} failure on the images endpoint is reported, not retried on the responses path`, async () => {
    const { calls, fetchFn } = router({ [GENERATIONS_URL]: response });
    await assert.rejects(generateImage({ model: 'm', prompt: 'A fox.' }, deps(fetchFn)), { code });
    assert.deepEqual(
      calls.map((call) => call.url),
      [GENERATIONS_URL]
    );
  });
}

test('usage limit names the reset time from the error and leaks neither body nor account id', async () => {
  const { fetchFn } = router({
    [GENERATIONS_URL]: () =>
      json(
        { error: { type: 'usage_limit_reached', message: 'raw upstream acct-secret-123', resets_at: 1792218828 } },
        429,
        { 'x-codex-active-limit': 'image_gen' }
      ),
  });
  const error = await generateImage({ model: 'm', prompt: 'A fox.' }, deps(fetchFn)).catch((err) => err);
  assert.equal(error.code, 'MEDIA_USAGE_LIMIT');
  assert.equal(error.status, 429);
  assert.equal(error.message, 'ChatGPT image: image generation usage limit reached — resets 2026-10-17 06:33 UTC');
  assert.equal(error.resetsAt, '2026-10-17T06:33:48.000Z');
  assert.doesNotMatch(error.message, /acct-secret|raw upstream/);
});

test('usage limit takes the reset from exhausted rate-limit headers', async () => {
  const { calls, fetchFn } = router({
    [GENERATIONS_URL]: () =>
      json({ error: { code: 'usage_limit_reached' } }, 429, {
        'x-codex-active-limit': 'imagegen_premium',
        'x-imagegen-premium-primary-used-percent': '100',
        'x-imagegen-premium-primary-reset-at': '1792218828',
        'x-codex-secondary-used-percent': '20',
        'x-codex-secondary-reset-at': '1792999999',
      }),
  });
  const error = await generateImage({ model: 'm', prompt: 'A fox.' }, deps(fetchFn)).catch((err) => err);
  assert.equal(error.resetsAt, '2026-10-17T06:33:48.000Z');
  assert.equal(calls.length, 1, 'no usage lookup when the headers already carry the reset');
});

test('usage limit without a reset time looks it up from the account usage summary', async () => {
  const { calls, fetchFn } = router({
    [GENERATIONS_URL]: () =>
      json({ error: { type: 'usage_limit_reached' } }, 429, { 'x-codex-active-limit': 'image_gen' }),
    [CHATGPT_USAGE_URL]: () =>
      json({
        account_id: 'acct-secret-123',
        rate_limit: { primary_window: { used_percent: 14, reset_at: 1792649592 } },
        additional_rate_limits: [
          {
            limit_name: 'image_gen',
            metered_feature: 'image_gen',
            rate_limit: {
              limit_reached: true,
              primary_window: { used_percent: 100, reset_at: 1792218828 },
              secondary_window: { used_percent: 40, reset_at: 1792900000 },
            },
          },
        ],
      }),
  });
  const error = await generateImage({ model: 'm', prompt: 'A fox.' }, deps(fetchFn)).catch((err) => err);
  assert.equal(error.code, 'MEDIA_USAGE_LIMIT');
  assert.equal(error.resetsAt, '2026-10-17T06:33:48.000Z');
  const lookup = calls[1];
  assert.equal(lookup.url, CHATGPT_USAGE_URL);
  assert.equal(lookup.init.headers.Authorization, 'Bearer token');
  assert.equal(lookup.init.headers['ChatGPT-Account-Id'], 'acct-secret-123');
  assert.doesNotMatch(error.message, /acct-secret/);
});

test('usage limit still reports clearly when the usage lookup fails', async () => {
  const { fetchFn } = router({
    [GENERATIONS_URL]: () => json({ error: { type: 'usage_limit_reached' } }, 429),
    [CHATGPT_USAGE_URL]: () => new Response('<html></html>', { status: 500 }),
  });
  await assert.rejects(generateImage({ model: 'm', prompt: 'A fox.' }, deps(fetchFn)), {
    code: 'MEDIA_USAGE_LIMIT',
    message: 'ChatGPT image: usage limit reached — try again after the usage window resets',
  });
});

test('a responses stream that ends with only a partial frame fails instead of saving a draft', async () => {
  const { fetchFn } = router({
    [GENERATIONS_URL]: () => new Response('', { status: 404 }),
    [CODEX_RESPONSES_URL]: () =>
      sse({ type: 'response.image_generation_call.partial_image', partial_image_b64: 'cGFydGlhbA==' }),
  });
  await assert.rejects(generateImage({ model: 'm', prompt: 'A fox.' }, deps(fetchFn)), { code: 'MEDIA_PARTIAL_ONLY' });
});

test('a responses stream that fails on a usage limit maps to the limit message', async () => {
  const { fetchFn } = router({
    [GENERATIONS_URL]: () => new Response('', { status: 404 }),
    [CODEX_RESPONSES_URL]: () =>
      sse({
        type: 'response.failed',
        response: { error: { code: 'usage_limit_reached', message: 'raw', resets_at: 1792218828 } },
      }),
  });
  await assert.rejects(generateImage({ model: 'm', prompt: 'A fox.' }, deps(fetchFn)), {
    code: 'MEDIA_USAGE_LIMIT',
    message: /resets 2026-10-17 06:33 UTC/,
  });
});

test('a top-level responses error event keeps its usage-limit code and reset', async () => {
  const { fetchFn } = router({
    [GENERATIONS_URL]: () => new Response('', { status: 404 }),
    [CODEX_RESPONSES_URL]: () =>
      sse({ type: 'error', code: 'usage_limit_reached', message: 'Usage limit reached', resets_at: 1792218828 }),
  });
  await assert.rejects(generateImage({ model: 'm', prompt: 'A fox.' }, deps(fetchFn)), {
    code: 'MEDIA_USAGE_LIMIT',
    message: /resets 2026-10-17 06:33 UTC/,
  });
});

test('an unknown background value is refused before authenticating', async () => {
  await assert.rejects(
    generateImage(
      { model: 'm', prompt: 'A fox.', options: { background: 'checkered' } },
      {
        resolveAuth: () => {
          throw new Error('must not authenticate');
        },
      }
    ),
    { code: 'MEDIA_OPTION_UNSUPPORTED' }
  );
});

for (const model of ['gpt-5.6-sol', 'gpt-5.4-mini', 'gpt-6-astra']) {
  test(`${model} forces the hosted image generation tool`, () => {
    const body = codexImageRequestBody({
      model,
      prompt: 'Draw a blue square.',
      options: { size: '1024x1024', quality: 'low' },
    });

    assert.equal(body.model, model);
    assert.deepEqual(body.tool_choice, { type: 'image_generation' });
    assert.deepEqual(body.tools, [
      {
        type: 'image_generation',
        size: '1024x1024',
        quality: 'low',
      },
    ]);
    assert.equal(body.input[0].content.at(-1)?.text, 'Draw a blue square.');
  });
}

test('image requests carry the same client identity as the Codex catalog transport', () => {
  const headers = codexImageRequestHeaders({ access_token: 'test-token', account_id: 'test-account' });
  assert.equal(headers.version, codexVersionHeader());
  assert.equal(headers['User-Agent'], codexUserAgent());
  assert.equal(headers['chatgpt-account-id'], 'test-account');
});

test('OAuth parses image SSE without a content type and reports the actual engine', async () => {
  let request;
  const result = await generateImage(
    { model: 'gpt-6-astra', prompt: 'Draw a circle.' },
    {
      resolveAuth: async () => ({ access_token: 'token', account_id: 'account' }),
      warmVersion: async () => {},
      fetchFn: async (url, init) => {
        if (url !== CODEX_RESPONSES_URL) return new Response('', { status: 404 });
        request = init;
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: { type: 'image_generation_call', model: 'gpt-image-2-codex', result: 'aW1hZ2U=' },
          })}\n\ndata: [DONE]\n\n`
        );
      },
    }
  );
  assert.equal(result.bytes.toString(), 'image');
  assert.equal(result.actualModel, 'gpt-image-2-codex');
  assert.deepEqual(JSON.parse(request.body).tools, [{ type: 'image_generation' }]);
  assert.equal(request.redirect, 'error');
});

test('OAuth refuses output settings that the server does not honor before authenticating', async () => {
  await assert.rejects(
    generateImage(
      {
        model: 'gpt-6-astra',
        prompt: 'Draw a circle.',
        options: { size: '1536x1024' },
      },
      {
        resolveAuth: () => {
          throw new Error('must not authenticate');
        },
      }
    ),
    { code: 'MEDIA_OPTION_UNSUPPORTED' }
  );
});
