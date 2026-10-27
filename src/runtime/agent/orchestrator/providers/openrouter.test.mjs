import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'openrouter-provider-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';

const { OpenRouterProvider, openRouterCapabilityModel } = await import('./openrouter.mjs');
const { providerErrorKind, normalizeGatewayErrorDetail } = await import('./provider-error-kind.mjs');
const { isContextOverflowError } = await import('./retry-classification.mjs');
const { withUsageContext, noteAbandonedUsage } = await import('../../../shared/llm/usage-context.mjs');
const { withInclusiveUsage } = await import('./lib/inclusive-usage.mjs');
const { createAnthropicTurnState, updateTurnUsage } = await import('./anthropic-sse-turn/turn-state.mjs');
const { buildAnthropicTurnResult } = await import('./anthropic-turn-result.mjs');

const savedEnv = {};
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY']) savedEnv[key] = process.env[key];
// Anthropic SDK environment credentials must never reach OpenRouter.
process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
process.env.ANTHROPIC_AUTH_TOKEN = 'env-anthropic-token';
delete process.env.OPENROUTER_API_KEY;

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const prompt = [{ role: 'user', content: 'hi' }];
const tool = { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } };

const frame = (event) => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
const sse = (events) => new Response(events.map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } });

function messagesStream(body) {
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 14268, cache_creation_input_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 9, output_tokens: 5, cache_read_input_tokens: 14268, cost: 0.0014608 },
    },
    { type: 'message_stop' },
  ]);
}

function responsesStream(body) {
  return sse([
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        model: body.model,
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 10, output_tokens: 2, cost: 0.0001 },
      },
    },
  ]);
}

function chatStream(body) {
  return sse([
    { id: 'c1', model: body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
  ]);
}

function respond(request) {
  if (request.path.endsWith('/messages')) return messagesStream(request.body);
  if (request.path.endsWith('/responses')) return responsesStream(request.body);
  return chatStream(request.body);
}

function harness(handler = respond, config = {}) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input?.url ?? input));
    const request = {
      url: url.href,
      path: url.pathname,
      headers: new Headers(init.headers || {}),
      body: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    return handler(request, requests);
  };
  const provider = new OpenRouterProvider({
    apiKey: 'or-key',
    preconnect: false,
    fetchImpl,
    clientOptions: { fetch: fetchImpl },
    ...config,
  });
  return { provider, requests };
}

test('Claude goes to OpenRouter Messages with the OpenRouter key alone and inclusive usage with cost', async () => {
  const { provider, requests } = harness();
  const result = await provider.send(prompt, 'anthropic/claude-opus-4.8', [tool], { sessionId: 's1' });
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url, 'https://openrouter.ai/api/v1/messages');
  assert.equal(request.body.model, 'anthropic/claude-opus-4.8');
  assert.equal(request.headers.get('authorization'), 'Bearer or-key');
  assert.equal(request.headers.get('x-api-key'), null);
  assert.equal(request.headers.get('anthropic-beta'), null);
  assert.equal(request.headers.get('http-referer'), 'https://github.com/tribgames/mixdog');
  assert.equal(request.headers.get('x-openrouter-title'), 'mixdog');
  // Cache markers ride the request (OpenRouter forwards them to Anthropic).
  assert.match(JSON.stringify(request.body), /cache_control/);
  assert.equal(result.content, 'ok');
  assert.equal(result.usage.inputTokens, 9 + 14268);
  assert.equal(result.usage.cachedTokens, 14268);
  assert.equal(result.usage.promptTokens, 9 + 14268);
  assert.equal(result.usage.costUsd, 0.0014608);
});

test('the routing slug stays on the wire; capabilities come from the alias target', async () => {
  const { provider, requests } = harness();
  provider.openai._enrichedModels = [{ id: '~anthropic/claude-opus-latest', aliasTarget: 'anthropic/claude-opus-5.5' }];
  await provider.send(prompt, '~anthropic/claude-opus-latest', [tool], { effort: 'high' });
  assert.equal(requests[0].body.model, '~anthropic/claude-opus-latest');
  assert.equal(requests[0].body.thinking?.type, 'adaptive');
  assert.equal(requests[0].body.output_config?.effort, 'high');
  assert.equal(openRouterCapabilityModel('anthropic/claude-haiku-4.5:batch'), 'claude-haiku-4.5');
  assert.equal(
    openRouterCapabilityModel('~anthropic/claude-opus-latest', 'anthropic/claude-opus-5.5'),
    'claude-opus-5.5'
  );
});

test('a 401 on Messages re-reads the key and rebuilds the bearer auth', async () => {
  const { provider, requests } = harness((request, all) =>
    all.length === 1
      ? Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, { status: 401 })
      : respond(request)
  );
  process.env.OPENROUTER_API_KEY = 'or-rotated';
  try {
    await provider.send(prompt, 'anthropic/claude-sonnet-5', [tool], {});
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
  assert.deepEqual(
    requests.map((r) => r.headers.get('authorization')),
    ['Bearer or-key', 'Bearer or-rotated']
  );
  assert.ok(requests.every((r) => r.headers.get('x-api-key') === null));
});

test('the Messages engine never follows a redirect off the OpenRouter origin', async () => {
  const { provider, requests } = harness(
    () => new Response(null, { status: 307, headers: { Location: 'https://evil.example/steal' } })
  );
  await assert.rejects(provider.send(prompt, 'anthropic/claude-sonnet-5', [tool], {}), (err) => {
    // The SDK reports the refused hop as a connection error caused by the guard.
    assert.match(String(err?.cause?.message || err?.message), /refusing to follow a redirect/);
    return true;
  });
  assert.ok(requests.length >= 1);
  assert.ok(requests.every((r) => r.url.startsWith('https://openrouter.ai/')));
});

test('OpenAI GPT goes to Responses with OpenRouter reasoning semantics; auto stays on Chat', async () => {
  const { provider, requests } = harness();
  const result = await provider.send(prompt, 'openai/gpt-6.1-sol', [tool], {
    effort: 'low',
    openRouterReasoningEffort: 'high',
  });
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/responses');
  assert.deepEqual(requests[0].body.reasoning, { enabled: true, effort: 'high' });
  assert.equal(requests[0].headers.get('authorization'), 'Bearer or-key');
  assert.equal(requests[0].headers.get('x-openrouter-title'), 'mixdog');
  assert.equal(result.usage.costUsd, 0.0001);
  await provider.send(prompt, '~openai/gpt-sol-latest', [tool], { openRouterReasoningEffort: 'none' });
  assert.deepEqual(requests[1].body.reasoning, { enabled: false });
  await provider.send(prompt, 'openai/o3', [tool], {});
  assert.equal(requests[2].body.reasoning, undefined);
  await provider.send(prompt, 'openrouter/auto', [tool], { effort: 'medium' });
  assert.equal(requests[3].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.deepEqual(requests[3].body.reasoning, { enabled: true, effort: 'medium' });
});

test('a session pinned before the per-model table keeps Chat for Claude', async () => {
  const { provider, requests } = harness();
  const wireRoute = { provider: 'openrouter', model: 'anthropic/claude-opus-4.8', wire: 'chat', source: 'legacy' };
  await provider.send(prompt, 'anthropic/claude-opus-4.8', [tool], { wireRoute });
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
});

test('a per-model override in the provider config picks the wire', async () => {
  const { provider, requests } = harness(respond, { modelWires: { 'anthropic/claude-opus-4.8': 'chat' } });
  await provider.send(prompt, 'anthropic/claude-opus-4.8', [tool], {});
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
});

function failedResponse(errorType, code, message) {
  return sse([
    {
      type: 'response.failed',
      response: { id: 'resp_f', status: 'failed', error: { code, message }, error_type: errorType },
    },
  ]);
}

test('OpenRouter error_type decides the Responses failure classification', async () => {
  const auth = harness(() => failedResponse('authentication', 'server_error', 'Invalid credentials'));
  const authErr = await auth.provider.send(prompt, 'openai/gpt-6.1-sol', [tool], {}).catch((err) => err);
  assert.equal(providerErrorKind(authErr).kind, 'auth');
  assert.equal(authErr.code, 'authentication_error');
  // A deterministic refusal is not replayed as a server fault.
  assert.equal(auth.requests.length, 1);

  const overflow = harness(() => failedResponse('context_length_exceeded', 'invalid_prompt', 'too long'));
  const overflowErr = await overflow.provider.send(prompt, 'openai/gpt-6.1-sol', [tool], {}).catch((err) => err);
  assert.equal(providerErrorKind(overflowErr).kind, 'context_overflow');
  assert.equal(isContextOverflowError(overflowErr), true);
  assert.equal(overflow.requests.length, 1);
});

test('a canonical error_type outranks a conflicting native code on the HTTP path', async () => {
  const body = (error) => Response.json({ error }, { status: 400 });
  for (const [model, error] of [
    [
      'openrouter/auto',
      { code: 'invalid_prompt', message: 'too long', metadata: { error_type: 'context_length_exceeded' } },
    ],
    ['openrouter/auto', { code: 'invalid_prompt', message: 'too long', error_type: 'context_length_exceeded' }],
    [
      'anthropic/claude-opus-4.8',
      { type: 'invalid_prompt', message: 'too long', error_type: 'context_length_exceeded' },
    ],
  ]) {
    const { provider } = harness(() => body(error));
    const err = await provider.send(prompt, model, [tool], {}).catch((e) => e);
    assert.equal(providerErrorKind(err).kind, 'context_overflow', model);
    assert.equal(isContextOverflowError(err), true, model);
  }
  const direct = Object.assign(new Error('too long'), {
    status: 400,
    code: 'invalid_prompt',
    error: { code: 'invalid_prompt', error_type: 'context_length_exceeded' },
  });
  assert.equal(providerErrorKind(direct).kind, 'context_overflow');
  assert.equal(isContextOverflowError(direct), true);
});

test('OpenRouter reasoning control applies on the Messages route as on Responses', async () => {
  const model = 'anthropic/claude-opus-4.8';
  // `none` disables thinking whatever the turn effort.
  const off = harness();
  await off.provider.send(prompt, model, [tool], { effort: 'high', openRouterReasoningEffort: 'none' });
  assert.equal(off.requests[0].url, 'https://openrouter.ai/api/v1/messages');
  assert.equal(off.requests[0].body.thinking, undefined);
  assert.equal(off.requests[0].body.output_config?.effort, undefined);
  // The explicit OpenRouter effort beats the turn effort.
  const explicit = harness();
  await explicit.provider.send(prompt, model, [tool], { effort: 'high', openRouterReasoningEffort: 'low' });
  assert.equal(explicit.requests[0].body.thinking?.type, 'adaptive');
  assert.equal(explicit.requests[0].body.output_config?.effort, 'low');
  // The configured effort applies when the turn names none; the turn effort beats it.
  const configured = harness(respond, { reasoningEffort: 'low' });
  await configured.provider.send(prompt, model, [tool], {});
  assert.equal(configured.requests[0].body.output_config?.effort, 'low');
  await configured.provider.send(prompt, model, [tool], { effort: 'medium' });
  assert.equal(configured.requests[1].body.output_config?.effort, 'medium');
});

test('error_type normalization maps the documented vocabulary and leaves other details alone', () => {
  assert.deepEqual(
    normalizeGatewayErrorDetail({ code: 'server_error', message: 'm' }, { error_type: 'provider_overloaded' }),
    {
      code: 'overloaded',
      message: 'm',
      error_type: 'provider_overloaded',
      native_code: 'server_error',
    }
  );
  const plain = { code: 'server_error' };
  assert.equal(normalizeGatewayErrorDetail(plain, { error_type: 'unmapped' }), plain);
  assert.equal(normalizeGatewayErrorDetail(plain, null), plain);
  // Anthropic-skin and Chat-skin envelopes carry error_type inside the error.
  const kind = (err) => providerErrorKind(err).kind;
  assert.equal(
    kind({
      status: 400,
      error: { type: 'error', error: { type: 'invalid_request_error', error_type: 'context_length_exceeded' } },
    }),
    'context_overflow'
  );
  assert.equal(kind({ error: { code: 429, message: 'x', metadata: { error_type: 'payment_required' } } }), 'billing');
  assert.equal(kind({ status: 500, error: { type: 'api_error', error_type: 'authentication' } }), 'auth');
});

test('Messages usage keeps cost and the inclusive input on success, abandoned and failed attempts', async () => {
  const turn = createAnthropicTurnState();
  updateTurnUsage(turn.usage, { input_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 });
  updateTurnUsage(turn.usage, { output_tokens: 4, cost: '0.25' });
  assert.equal(turn.usage.costUsd, 0.25);
  const result = buildAnthropicTurnResult(
    { content: 'ok', usage: turn.usage },
    { provider: 'openrouter', useModel: 'anthropic/claude-sonnet-5', opts: {} }
  );
  assert.equal(result.usage.costUsd, 0.25);
  // An unreported or invalid cost is not a reported $0.
  const blank = createAnthropicTurnState();
  updateTurnUsage(blank.usage, { input_tokens: 1, cost: '' });
  updateTurnUsage(blank.usage, { output_tokens: 1, cost: -1 });
  assert.equal(blank.usage.costUsd, undefined);

  const identity = {};
  const failure = Object.assign(new Error('stream lost'), { partialUsage: turn.usage });
  await assert.rejects(
    withUsageContext(identity, () =>
      withInclusiveUsage(async () => {
        noteAbandonedUsage(turn.usage, 'anthropic/claude-sonnet-5');
        throw failure;
      })
    )
  );
  const [abandoned] = identity.abandonedUsage;
  assert.equal(abandoned.usage.inputTokens, 9 + 100 + 5);
  assert.equal(abandoned.usage.costUsd, 0.25);
  // The failure carries the same converted object, so it is one record.
  assert.equal(failure.partialUsage, abandoned.usage);
});

test('the catalog alias target is retained for capability lookup', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    if (url === 'https://openrouter.ai/api/v1/models') {
      return Response.json({
        data: [
          {
            id: '~anthropic/claude-opus-latest',
            alias_target: { name: 'Claude Opus 5.5', slug: 'anthropic/claude-opus-5.5' },
            context_length: 1000000,
          },
          { id: 'anthropic/claude-opus-5.5', context_length: 1000000 },
        ],
      });
    }
    return new Response('offline', { status: 503 });
  };
  try {
    const { provider } = harness();
    const models = await provider.listModels();
    const alias = models.find((m) => m.id === '~anthropic/claude-opus-latest');
    assert.equal(alias.aliasTarget, 'anthropic/claude-opus-5.5');
    assert.equal(provider.getCachedModelInfo('~anthropic/claude-opus-latest').aliasTarget, 'anthropic/claude-opus-5.5');
    assert.equal(models.find((m) => m.id === 'anthropic/claude-opus-5.5').aliasTarget, undefined);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
