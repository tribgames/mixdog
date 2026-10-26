import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-anthropic-errors-'));
const previous = {
  MIXDOG_DATA_DIR: process.env.MIXDOG_DATA_DIR,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES,
};
process.env.MIXDOG_DATA_DIR = dataDir;
// Prevent the OAuth socket prewarm from contacting a live endpoint.
process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
// Two retries = three attempts per request loop; every wait below is a
// server-declared 0ms window so nothing sleeps.
process.env.CLAUDE_CODE_MAX_RETRIES = '2';

const { AnthropicProvider } = await import('./anthropic.mjs');
const { AnthropicOAuthProvider } = await import('./anthropic-oauth.mjs');
const { applyAnthropicErrorContract, resetAtFromHeaders, retryAfterMsFromHeaders } = await import(
  './anthropic-error-contract.mjs'
);
const { clearFastModeCooldown, fastModeAvailable, fastModeDisabledReason } = await import('./anthropic-fast-mode.mjs');
const { anthropicMaxAttempts } = await import('./retry-classifier.mjs');
const { adjustMaxTokensForContextOverflow, capForNonStreaming } = await import('./anthropic-max-tokens-recovery.mjs');

const FAST_MODEL = 'claude-opus-5';
const MESSAGES = [{ role: 'user', content: 'hello' }];

test.beforeEach(() => clearFastModeCooldown());
test.after(async () => {
  clearFastModeCooldown();
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(dataDir, { recursive: true, force: true });
});

const errorBody = (type, message = 'boom') => ({ type: 'error', error: { type, message } });

// What the SDK throws for a non-2xx before `.asResponse()` resolves.
function sdkError(status, type, headers = {}, message = 'boom') {
  const body = errorBody(type, message);
  return Object.assign(new Error(`${status} ${JSON.stringify(body)}`), {
    status,
    headers: new Headers(headers),
    error: body,
  });
}

function sseReply(frames) {
  return new Response(frames.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

const okReply = () =>
  sseReply([
    {
      type: 'message_start',
      message: { id: 'msg_ok', model: FAST_MODEL, role: 'assistant', usage: { input_tokens: 1 } },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]);

const overloadReply = () => sseReply([{ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]);

function apiProvider(onCreate) {
  const calls = [];
  const provider = Object.assign(Object.create(AnthropicProvider.prototype), {
    name: 'anthropic',
    config: { apiKey: 'test-key' },
    apiKey: 'test-key',
    fastModeBetaHeaderLatched: false,
    client: {
      messages: {
        create(params) {
          calls.push({ ...params });
          const index = calls.length;
          return { asResponse: async () => onCreate(index, params) };
        },
      },
    },
  });
  return { provider, calls };
}

const sendApi = (provider, opts = {}) => provider.send(MESSAGES, FAST_MODEL, [], opts);

function oauthProvider() {
  const provider = Object.create(AnthropicOAuthProvider.prototype);
  provider.config = {};
  provider.fastModeBetaHeaderLatched = false;
  provider.ensureCalls = [];
  provider.ensureAuth = async (options) => {
    provider.ensureCalls.push(options || {});
    return { accessToken: `token-${provider.ensureCalls.length}` };
  };
  provider.scrubTokens = (text) => String(text || '');
  provider._refreshModelCache = async () => [];
  return provider;
}

function httpResponse(status, { body = '', headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: async () => body,
    json: async () => JSON.parse(body || '{}'),
  };
}

const requestResult = (response) => ({ controller: new AbortController(), cancelHandler: null, response });

const okTurn = async () => ({ model: FAST_MODEL, content: 'ok', usage: { inputTokens: 1 } });

// ── Error contract ──────────────────────────────────────────────────────────

test('the contract reads retry-after / retry-after-ms uncapped and the reset header as epoch ms', () => {
  assert.equal(retryAfterMsFromHeaders(new Headers({ 'retry-after': '3600' })), 3_600_000);
  assert.equal(retryAfterMsFromHeaders(new Headers({ 'retry-after-ms': '1500', 'retry-after': '9' })), 1500);
  assert.equal(retryAfterMsFromHeaders(new Headers({ 'anthropic-ratelimit-unified-reset': '4102444800' })), null);
  assert.equal(
    resetAtFromHeaders(new Headers({ 'anthropic-ratelimit-unified-reset': '4102444800' })),
    4_102_444_800_000
  );

  const err = applyAnthropicErrorContract(new Error('x'), {
    status: 429,
    headers: new Headers({ 'retry-after': '7200', 'anthropic-ratelimit-unified-reset': '4102444800' }),
    bodyText: JSON.stringify(errorBody('rate_limit_error')),
  });
  assert.deepEqual([err.status, err.httpStatus, err.code], [429, 429, 'rate_limit_error']);
  assert.equal(err.retryAfterMs, 7_200_000);
  assert.equal(err.resetAt, 4_102_444_800_000);
  assert.equal(err.headers.get('retry-after'), '7200');
});

test('a 413 is request_too_large while a 400 prompt-too-long keeps its own type', () => {
  const tooLarge = applyAnthropicErrorContract(new Error('x'), {
    status: 413,
    bodyText: JSON.stringify(errorBody('invalid_request_error')),
  });
  assert.equal(tooLarge.code, 'request_too_large');
  const tooLong = applyAnthropicErrorContract(new Error('x'), {
    status: 400,
    bodyText: JSON.stringify(errorBody('invalid_request_error', 'prompt is too long: 300000 tokens > 200000 maximum')),
  });
  assert.equal(tooLong.code, 'invalid_request_error');
  assert.equal(tooLong.status, 400);
});

// ── 1. initial-response failures never earn an SSE retry budget ─────────────

test('a persistent API 429 costs one request-loop budget and is not re-retried mid-stream', async () => {
  const { provider, calls } = apiProvider(() => {
    throw sdkError(429, 'rate_limit_error', { 'retry-after-ms': '0' });
  });
  await assert.rejects(sendApi(provider), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.code, 'rate_limit_error');
    assert.equal(err.initialResponseError, true);
    assert.equal(err.retryAfterMs ?? null, null, 'zero advice is no advice');
    assert.ok(err.headers instanceof Headers, 'headers are preserved');
    return true;
  });
  assert.equal(calls.length, anthropicMaxAttempts());
});

test('an API 429 carries the uncapped reset time and Retry-After', async () => {
  const resetSec = Math.floor(Date.now() / 1000) + 7200;
  const { provider } = apiProvider(() => {
    throw sdkError(429, 'rate_limit_error', {
      'retry-after': '3600',
      'x-should-retry': 'false',
      'anthropic-ratelimit-unified-reset': String(resetSec),
    });
  });
  await assert.rejects(sendApi(provider), (err) => {
    assert.equal(err.retryAfterMs, 3_600_000, 'Retry-After is never capped');
    assert.equal(err.resetAt, resetSec * 1000, 'the reset is never capped to 5 minutes');
    return true;
  });
});

test('x-should-retry:false is honored on an API initial response', async () => {
  const { provider, calls } = apiProvider(() => {
    throw sdkError(429, 'rate_limit_error', { 'x-should-retry': 'false', 'retry-after-ms': '0' });
  });
  await assert.rejects(sendApi(provider), (err) => err.status === 429 && err.initialResponseError === true);
  assert.equal(calls.length, 1);
});

test('an exhausted transient 5xx initial response is not retried again mid-stream either', async () => {
  const { provider, calls } = apiProvider(() => {
    throw sdkError(500, 'api_error', { 'retry-after-ms': '0' });
  });
  await assert.rejects(sendApi(provider), (err) => err.status === 500 && err.code === 'api_error');
  assert.equal(calls.length, anthropicMaxAttempts());
});

// ── 5. 413 versus prompt-too-long ───────────────────────────────────────────

test('API 413 and 400 prompt-too-long keep distinct codes', async () => {
  const large = apiProvider(() => {
    throw sdkError(413, 'request_too_large', {}, 'Request exceeds the maximum allowed number of bytes.');
  });
  await assert.rejects(sendApi(large.provider), (err) => err.status === 413 && err.code === 'request_too_large');
  assert.equal(large.calls.length, 1);

  const long = apiProvider(() => {
    throw sdkError(400, 'invalid_request_error', {}, 'prompt is too long: 300000 tokens > 200000 maximum');
  });
  await assert.rejects(
    sendApi(long.provider),
    (err) => err.status === 400 && err.code === 'invalid_request_error' && /prompt is too long/.test(err.message)
  );
});

test('OAuth 413 and 400 prompt-too-long keep distinct codes', async () => {
  for (const [status, type, message, code] of [
    [413, 'request_too_large', 'Request exceeds the maximum allowed number of bytes.', 'request_too_large'],
    [400, 'invalid_request_error', 'prompt is too long: 300000 tokens > 200000 maximum', 'invalid_request_error'],
  ]) {
    const provider = oauthProvider();
    await assert.rejects(
      provider.send(MESSAGES, 'claude-fable-5-1', [], {
        _doRequestFn: async () =>
          requestResult(httpResponse(status, { body: JSON.stringify(errorBody(type, message)) })),
      }),
      (err) => err.status === status && err.code === code && err.headers instanceof Headers
    );
  }
});

// ── 2. fast mode ────────────────────────────────────────────────────────────

test('a short API Retry-After keeps fast mode and waits it out', async () => {
  const { provider, calls } = apiProvider((index) => {
    if (index === 1) throw sdkError(429, 'rate_limit_error', { 'retry-after-ms': '5' });
    return okReply();
  });
  await sendApi(provider, { fast: true });
  assert.deepEqual(
    calls.map((call) => call.speed),
    ['fast', 'fast']
  );
  assert.equal(fastModeAvailable(), true);
});

test('a long API Retry-After drops fast mode and replays at standard speed without waiting', async () => {
  const { provider, calls } = apiProvider((index) => {
    if (index === 1) throw sdkError(429, 'rate_limit_error', { 'retry-after': '3600' });
    return okReply();
  });
  const startedAt = Date.now();
  await sendApi(provider, { fast: true });
  assert.ok(Date.now() - startedAt < 5_000, 'the fast pool window is not waited out');
  assert.deepEqual(
    calls.map((call) => call.speed),
    ['fast', undefined]
  );
  assert.equal(fastModeAvailable(), false);
});

test('an unrelated API failure leaves fast mode and speed alone', async () => {
  const { provider, calls } = apiProvider((index) => {
    if (index === 1) throw sdkError(500, 'api_error', { 'retry-after-ms': '0' });
    return okReply();
  });
  await sendApi(provider, { fast: true });
  assert.deepEqual(
    calls.map((call) => call.speed),
    ['fast', 'fast']
  );
  assert.equal(fastModeAvailable(), true);
});

test('"Fast mode is not enabled" is recovered at standard speed and remembered', async () => {
  const { provider, calls } = apiProvider((index) => {
    if (index === 1)
      throw sdkError(400, 'invalid_request_error', {}, 'Fast mode is not enabled for this organization.');
    return okReply();
  });
  await sendApi(provider, { fast: true });
  assert.deepEqual(
    calls.map((call) => call.speed),
    ['fast', undefined]
  );
  assert.equal(fastModeDisabledReason(), 'fast_mode_not_enabled');
  assert.equal(fastModeAvailable(), false);
});

test('OAuth "Fast mode is not enabled" replays the turn once at standard speed', async () => {
  const provider = oauthProvider();
  const bodies = [];
  await provider.send(MESSAGES, FAST_MODEL, [], {
    fast: true,
    _doRequestFn: async (_token, _signal, body) => {
      bodies.push({ ...body });
      if (body.speed === 'fast') {
        return requestResult(
          httpResponse(400, {
            body: JSON.stringify(errorBody('invalid_request_error', 'Fast mode is not enabled for this account.')),
          })
        );
      }
      return requestResult(httpResponse(200));
    },
    _parseSSEFn: okTurn,
  });
  assert.deepEqual(
    bodies.map((body) => body.speed),
    ['fast', undefined]
  );
  assert.equal(fastModeDisabledReason(), 'fast_mode_not_enabled');
});

test('OAuth fast-pool 529 with a long Retry-After replays at standard speed within the attempt', async () => {
  const provider = oauthProvider();
  const bodies = [];
  const startedAt = Date.now();
  await provider.send(MESSAGES, FAST_MODEL, [], {
    fast: true,
    _doRequestFn: async (_token, _signal, body) => {
      bodies.push({ ...body });
      if (body.speed === 'fast') return requestResult(httpResponse(529, { headers: { 'retry-after': '3600' } }));
      return requestResult(httpResponse(200));
    },
    _parseSSEFn: okTurn,
  });
  assert.ok(Date.now() - startedAt < 5_000);
  assert.deepEqual(
    bodies.map((body) => body.speed),
    ['fast', undefined]
  );
});

test('OAuth keeps speed through a retry that is not a fast-pool refusal', async () => {
  const provider = oauthProvider();
  const bodies = [];
  await provider.send(MESSAGES, FAST_MODEL, [], {
    fast: true,
    _doRequestFn: async (_token, _signal, body) => {
      bodies.push({ ...body });
      if (bodies.length === 1) return requestResult(httpResponse(503, { headers: { 'retry-after-ms': '0' } }));
      return requestResult(httpResponse(200));
    },
    _parseSSEFn: okTurn,
  });
  assert.deepEqual(
    bodies.map((body) => body.speed),
    ['fast', 'fast']
  );
});

// ── 3. non-streaming fallback auth refresh ──────────────────────────────────

async function sendWithNonStreamingFallback(provider, rejection) {
  const requests = [];
  const result = await provider.send(MESSAGES, 'claude-fable-5-1', [], {
    _doRequestFn: async (token, _signal, body) => {
      requests.push({ token, stream: body.stream });
      if (body.stream !== false) return requestResult(httpResponse(200));
      const nonStreaming = requests.filter((request) => request.stream === false).length;
      if (nonStreaming === 1) return requestResult(rejection());
      return requestResult(
        httpResponse(200, {
          body: JSON.stringify({
            id: 'msg_fallback',
            model: 'claude-fable-5-1',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'recovered answer' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        })
      );
    },
    _parseSSEFn: async (...args) => {
      args[5].sawMessageStart = true;
      args[5].emittedText = true;
      args[5].emittedTextChars = 4;
      throw Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      });
    },
    onTextReset: async () => true,
  });
  return { result, requests };
}

test('the non-streaming fallback refreshes and replays once on a 401', async () => {
  const provider = oauthProvider();
  const { result, requests } = await sendWithNonStreamingFallback(provider, () =>
    httpResponse(401, { body: JSON.stringify(errorBody('authentication_error')) })
  );
  assert.equal(result.content, 'recovered answer');
  assert.deepEqual(provider.ensureCalls.slice(-1), [{ forceRefresh: true, reason: '401' }]);
  assert.equal(requests.filter((request) => request.stream === false).length, 2);
  assert.equal(requests.at(-1).token, 'token-2');
});

test('the non-streaming fallback refreshes on the exact revoked-token 403 only', async () => {
  const revoked = oauthProvider();
  const { result } = await sendWithNonStreamingFallback(revoked, () =>
    httpResponse(403, { body: JSON.stringify(errorBody('permission_error', 'OAuth token has been revoked.')) })
  );
  assert.equal(result.content, 'recovered answer');
  assert.deepEqual(revoked.ensureCalls.slice(-1), [{ forceRefresh: true, reason: '403' }]);

  const ordinary = oauthProvider();
  await assert.rejects(
    sendWithNonStreamingFallback(ordinary, () =>
      httpResponse(403, { body: JSON.stringify(errorBody('permission_error', 'Not allowed for this organization.')) })
    ),
    (err) => err.status === 403 && err.code === 'permission_error' && /Not allowed/.test(err.message)
  );
  assert.equal(
    ordinary.ensureCalls.some((options) => options.forceRefresh),
    false
  );
});

// ── 4. overload fallback ────────────────────────────────────────────────────

const overloadedSseError = () =>
  Object.assign(new Error('Anthropic OAuth SSE error overloaded_error: Overloaded'), {
    name: 'AnthropicSseError',
    code: 'overloaded_error',
    httpStatus: 529,
    status: 529,
    providerWireError: true,
  });

test('OAuth SSE overloads count toward the fallback limit and announce the model switch', async () => {
  const provider = oauthProvider();
  const stages = [];
  const models = [];
  let parses = 0;
  const result = await provider.send(MESSAGES, 'claude-fable-5-1', [], {
    fallbackModel: 'claude-sonnet-4-6',
    _doRequestFn: async (_token, _signal, body) => {
      models.push(body.model);
      return requestResult(httpResponse(200));
    },
    _parseSSEFn: async () => {
      parses += 1;
      if (parses <= 3) throw overloadedSseError();
      return { model: 'claude-sonnet-4-6', content: 'from fallback', usage: { inputTokens: 1 } };
    },
    onStageChange: (stage, detail) => stages.push({ stage, message: detail?.message ?? null }),
  });
  assert.equal(result.content, 'from fallback');
  assert.deepEqual(models, ['claude-fable-5-1', 'claude-fable-5-1', 'claude-fable-5-1', 'claude-sonnet-4-6']);
  assert.ok(stages.some((entry) => entry.stage === 'reconnecting' && /overloaded/.test(entry.message || '')));
});

test('a request-loop 529 and SSE overloads share one counter', async () => {
  const provider = oauthProvider();
  const models = [];
  let requests = 0;
  let parses = 0;
  const result = await provider.send(MESSAGES, 'claude-fable-5-1', [], {
    fallbackModel: 'claude-sonnet-4-6',
    _doRequestFn: async (_token, _signal, body) => {
      models.push(body.model);
      requests += 1;
      if (requests === 1) return requestResult(httpResponse(529, { headers: { 'retry-after-ms': '0' } }));
      return requestResult(httpResponse(200));
    },
    _parseSSEFn: async () => {
      parses += 1;
      if (parses <= 2) throw overloadedSseError();
      return { model: 'claude-sonnet-4-6', content: 'from fallback', usage: { inputTokens: 1 } };
    },
  });
  assert.equal(result.content, 'from fallback');
  // 529 (1) + SSE overload (2) + SSE overload (3) → the third trips the fallback.
  assert.deepEqual(models, ['claude-fable-5-1', 'claude-fable-5-1', 'claude-fable-5-1', 'claude-sonnet-4-6']);
});

test('API-key SSE overloads trip the fallback model and announce it', async () => {
  const stages = [];
  const { provider, calls } = apiProvider((index) => (index <= 3 ? overloadReply() : okReply()));
  const result = await sendApi(provider, {
    fallbackModel: 'claude-sonnet-4-6',
    onStageChange: (stage, detail) => stages.push({ stage, message: detail?.message ?? null }),
  });
  assert.equal(result.content, 'ok');
  assert.deepEqual(
    calls.map((call) => call.model),
    [FAST_MODEL, FAST_MODEL, FAST_MODEL, 'claude-sonnet-4-6']
  );
  assert.ok(stages.some((entry) => entry.stage === 'reconnecting' && /overloaded/.test(entry.message || '')));
});

// The fallback hand-off logs the trigger on stderr and announces the switch
// with the exact display labels (OAuth: catalog display names).
async function captureStderr(run) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    return { value: await run(), lines };
  } finally {
    process.stderr.write = write;
  }
}

test('the fallback hand-off logs the trigger and announces exact labels on both providers', async () => {
  const { _displayModel } = await import('./anthropic-model-resolve.mjs');
  const apiStages = [];
  const { provider: api, calls } = apiProvider((index) => (index <= 3 ? overloadReply() : okReply()));
  const apiRun = await captureStderr(() =>
    sendApi(api, {
      fallbackModel: 'claude-sonnet-4-6',
      onStageChange: (stage, detail) => apiStages.push({ stage, detail }),
    })
  );
  assert.equal(apiRun.value.content, 'ok');
  assert.equal(calls.length, 4);
  assert.deepEqual(
    apiStages.filter((entry) => /continuing on/.test(entry.detail?.message || '')),
    [{ stage: 'reconnecting', detail: { message: `${FAST_MODEL} is overloaded — continuing on claude-sonnet-4-6` } }]
  );
  assert.equal(apiRun.lines.filter((line) => /^\[anthropic\] .*claude-sonnet-4-6/.test(line)).length, 1);

  const oauth = oauthProvider();
  const oauthStages = [];
  let parses = 0;
  const oauthRun = await captureStderr(() =>
    oauth.send(MESSAGES, 'claude-fable-5-1', [], {
      fallbackModel: 'claude-sonnet-4-6',
      _doRequestFn: async () => requestResult(httpResponse(200)),
      _parseSSEFn: async () => {
        parses += 1;
        if (parses <= 3) throw overloadedSseError();
        return { model: 'claude-sonnet-4-6', content: 'from fallback', usage: { inputTokens: 1 } };
      },
      onStageChange: (stage, detail) => oauthStages.push({ stage, detail }),
    })
  );
  assert.equal(oauthRun.value.content, 'from fallback');
  assert.deepEqual(
    oauthStages.filter((entry) => /continuing on/.test(entry.detail?.message || '')),
    [
      {
        stage: 'reconnecting',
        detail: {
          message: `${_displayModel('claude-fable-5-1')} is overloaded — continuing on ${_displayModel('claude-sonnet-4-6')}`,
        },
      },
    ]
  );
  assert.equal(oauthRun.lines.filter((line) => /^\[anthropic-oauth\] .*claude-sonnet-4-6/.test(line)).length, 1);
});

test('an OAuth streamed turn offers the body tool names and tags its mid-stream retries', async () => {
  const provider = oauthProvider();
  const seenNames = [];
  let parses = 0;
  const result = await provider.send(
    MESSAGES,
    'claude-fable-5-1',
    [
      { name: 'read', description: 'r', inputSchema: { type: 'object', properties: {} } },
      { name: 'grep', description: 'g', inputSchema: { type: 'object', properties: {} } },
    ],
    {
      _doRequestFn: async () => requestResult(httpResponse(200)),
      _parseSSEFn: async (...args) => {
        parses += 1;
        seenNames.push([...args[7]].sort());
        if (parses === 1) {
          args[5].sawMessageStart = true;
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
        return { model: 'claude-fable-5-1', content: 'ok', usage: { inputTokens: 1 } };
      },
    }
  );
  assert.equal(result.content, 'ok');
  assert.deepEqual(seenNames.at(-1), ['grep', 'read']);
  assert.equal(result.__midstreamRetries, parses - 1);
  assert.equal(Object.keys(result).includes('__midstreamRetries'), false);
});

test('the overload fallback is a single hop', async () => {
  const { provider, calls } = apiProvider(() => overloadReply());
  await assert.rejects(
    sendApi(provider, { fallbackModel: 'claude-sonnet-4-6' }),
    (err) => err.status === 529 && err.code === 'overloaded_error'
  );
  // 3 on the original model, then 4 on the fallback (no second hop).
  assert.deepEqual(
    calls.map((call) => call.model),
    [
      FAST_MODEL,
      FAST_MODEL,
      FAST_MODEL,
      'claude-sonnet-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-6',
    ]
  );
});

// ── Retry-policy rules ──────────────────────────────────────────────────────

const overflowMessage = (input, max, limit) =>
  `input length and \`max_tokens\` exceed context limit: ${input} + ${max} > ${limit}`;

test('max_tokens is shrunk to the room the context has left, with the reference floor and buffer', () => {
  const body = { max_tokens: 20_000, thinking: { type: 'enabled', budget_tokens: 5_000 } };
  assert.equal(adjustMaxTokensForContextOverflow(body, 400, overflowMessage(188_059, 20_000, 200_000)), true);
  assert.equal(body.max_tokens, 10_941);
  const tiny = { max_tokens: 20_000 };
  assert.equal(adjustMaxTokensForContextOverflow(tiny, 400, overflowMessage(198_000, 20_000, 200_000)), false);
  assert.equal(tiny.max_tokens, 20_000, 'less than the 3000 floor available: the error surfaces');
  assert.equal(adjustMaxTokensForContextOverflow({}, 429, overflowMessage(1, 2, 3)), false);
});

test('the non-streaming replay caps max_tokens at 64000 and keeps the thinking budget below it', () => {
  const capped = capForNonStreaming({ max_tokens: 128_000, thinking: { type: 'enabled', budget_tokens: 100_000 } });
  assert.equal(capped.max_tokens, 64_000);
  assert.equal(capped.thinking.budget_tokens, 63_999);
  assert.equal(capForNonStreaming({ max_tokens: 8_000 }).max_tokens, 8_000);
});

test('an API max_tokens context overflow 400 is replayed once with a smaller max_tokens', async () => {
  const { provider, calls } = apiProvider((index) => {
    if (index === 1) {
      throw sdkError(400, 'invalid_request_error', {}, overflowMessage(188_059, 20_000, 200_000));
    }
    return okReply();
  });
  await sendApi(provider);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].max_tokens, 10_941);
});

test('an OAuth max_tokens context overflow 400 is replayed once with a smaller max_tokens', async () => {
  const provider = oauthProvider();
  const bodies = [];
  await provider.send(MESSAGES, 'claude-fable-5-1', [], {
    _doRequestFn: async (_token, _signal, body) => {
      bodies.push(body.max_tokens);
      if (bodies.length === 1) {
        return requestResult(
          httpResponse(400, {
            body: JSON.stringify(errorBody('invalid_request_error', overflowMessage(188_059, 20_000, 200_000))),
          })
        );
      }
      return requestResult(httpResponse(200));
    },
    _parseSSEFn: okTurn,
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1], 10_941);
});

test('OAuth 429s follow the plan: Max/Pro fail fast, Enterprise retries like an API key', async () => {
  for (const [subscriptionType, requests] of [
    ['max', 1],
    ['enterprise', 2],
  ]) {
    const provider = oauthProvider();
    provider.credentials = { subscriptionType };
    let count = 0;
    const run = provider.send(MESSAGES, 'claude-fable-5-1', [], {
      _doRequestFn: async () => {
        count += 1;
        if (count === 1) {
          return requestResult(httpResponse(429, { headers: { 'retry-after-ms': '0' }, body: '{}' }));
        }
        return requestResult(httpResponse(200));
      },
      _parseSSEFn: okTurn,
    });
    if (requests === 1) await assert.rejects(run, (err) => err.status === 429);
    else await run;
    assert.equal(count, requests, subscriptionType);
  }
});

test('a streaming 404 from a gateway is replayed once non-streaming', async () => {
  const calls = [];
  const provider = apiProvider(() => okReply()).provider;
  provider.client = {
    messages: {
      create(params) {
        calls.push(params.stream);
        if (params.stream === false) {
          return Promise.resolve({
            id: 'msg_ns',
            model: FAST_MODEL,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'via non-streaming' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }
        return {
          asResponse: async () => {
            throw sdkError(404, 'not_found_error');
          },
        };
      },
    },
  };
  const result = await sendApi(provider);
  assert.equal(result.content, 'via non-streaming');
  assert.deepEqual(calls, [true, false]);
});

test('repeated API-key Opus overloads without a fallback model stop at three', async () => {
  const { provider, calls } = apiProvider(() => overloadReply());
  await assert.rejects(sendApi(provider), (err) => err.status === 529 && err.repeated529 === true);
  assert.equal(calls.length, 3);
});
test('request-loop 529s: API-key Opus without a fallback stops at three (stopAfterRepeated529)', async () => {
  const { provider, calls } = apiProvider(() => {
    throw sdkError(529, 'overloaded_error', { 'retry-after-ms': '0' });
  });
  await assert.rejects(sendApi(provider), (err) => err.repeated529 === true && err.status === 529);
  assert.equal(calls.length, 3);
});

test('request-loop 529s: a configured fallback model wins over the repeated-529 stop', async () => {
  const { provider, calls } = apiProvider((index) => {
    if (index <= 3) throw sdkError(529, 'overloaded_error', { 'retry-after-ms': '0' });
    return okReply();
  });
  const result = await sendApi(provider, { fallbackModel: 'claude-sonnet-4-6' });
  assert.equal(result.content, 'ok');
  assert.equal(calls.at(-1).model, 'claude-sonnet-4-6');
});

test('request-loop 529s: non-Opus models are not cut short by the repeated-529 rule', async () => {
  const { provider } = apiProvider(() => {
    throw sdkError(529, 'overloaded_error', { 'retry-after-ms': '0' });
  });
  await assert.rejects(
    provider.send(MESSAGES, 'claude-sonnet-4-6', [], {}),
    (err) => err.repeated529 !== true && err.status === 529
  );
});
