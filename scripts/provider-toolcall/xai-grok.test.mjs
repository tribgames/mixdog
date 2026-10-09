import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _xaiResponsesFingerprintPayloadForTest,
  xaiResponsesCacheRouting,
  GrokOAuthProvider,
  BUILTIN_TOOLS,
  normalizeGrokToolSchemas,
} from './_shared.mjs';

// grok-oauth has no independent tool_call parser: GrokOAuthProvider delegates
// request shaping and response parsing to an inner OpenAICompatProvider('xai'),
// so its tool_call extraction is covered by openai-compat.test.mjs.

test('Grok schema flatten keeps grep pattern required', () => {
  const grep = BUILTIN_TOOLS.find((tool) => tool.name === 'grep');
  assert.deepEqual(grep?.inputSchema?.required, ['pattern']);
  assert.equal(grep?.inputSchema?.properties?.pattern?.anyOf?.[0]?.type, 'string');
  assert.equal(grep?.inputSchema?.properties?.pattern?.anyOf?.[1]?.type, 'array');
  const [normalized] = normalizeGrokToolSchemas([grep]);
  for (const key of ['pattern', 'path']) {
    assert.equal(normalized.inputSchema.properties[key]?.type, 'array');
    assert.equal(normalized.inputSchema.properties[key]?.items?.type, 'string');
    assert.equal(normalized.inputSchema.properties[key]?.anyOf, undefined);
  }
  assert.equal(normalized.inputSchema.properties.glob?.type, 'string');
  assert.equal(normalized.inputSchema.anyOf, undefined);
  assert.equal(normalized.inputSchema.oneOf, undefined);
  assert.deepEqual(normalized.inputSchema.required, ['pattern']);
});

test('Grok schema flatten promotes the first XOR required-only anyOf key', () => {
  const [normalized] = normalizeGrokToolSchemas([
    {
      name: 'grep',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
        anyOf: [{ required: ['pattern'] }, { required: ['glob'] }],
        additionalProperties: false,
      },
    },
  ]);
  assert.equal(normalized.inputSchema.anyOf, undefined);
  assert.deepEqual(normalized.inputSchema.required, ['pattern']);
});

test('Grok schema flatten promotes the first XOR object-branch required key', () => {
  const [normalized] = normalizeGrokToolSchemas([
    {
      name: 'searchish',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
        anyOf: [
          { type: 'object', required: ['pattern'] },
          { type: 'object', required: ['glob'] },
        ],
      },
    },
  ]);
  assert.equal(normalized.inputSchema.anyOf, undefined);
  assert.deepEqual(normalized.inputSchema.required, ['pattern']);
});

test('xai Responses cache defaults to one stable key per session and preserves explicit none and prefix scopes', () => {
  const params = { messages: [{ role: 'system', content: 'stable system' }] };
  const first = xaiResponsesCacheRouting({ sessionId: 'session-a' }, params, [], 'grok-4.6');
  const same = xaiResponsesCacheRouting({ sessionId: 'session-a' }, params, [], 'grok-4.6');
  const other = xaiResponsesCacheRouting({ sessionId: 'session-b' }, params, [], 'grok-4.6');
  assert.equal(first.mode, 'session');
  assert.ok(first.key);
  assert.equal(first.key, same.key);
  assert.notEqual(other.key, first.key);
  assert.equal(first.prefixHash, other.prefixHash);

  // A session-less one-shot call has no conversation to pin.
  const sessionless = xaiResponsesCacheRouting({}, params, [], 'grok-4.6');
  assert.equal(sessionless.mode, 'none');
  assert.equal(sessionless.key, null);
  const optedOut = xaiResponsesCacheRouting(
    { sessionId: 'session-a', xaiResponsesCacheScope: 'none' },
    params,
    [],
    'grok-4.6'
  );
  assert.equal(optedOut.mode, 'none');
  assert.equal(optedOut.key, null);

  const sessionA = xaiResponsesCacheRouting(
    { sessionId: 'session-a', xaiResponsesCacheScope: 'session' },
    params,
    [],
    'grok-4.6'
  );
  const sessionAgain = xaiResponsesCacheRouting(
    { sessionId: 'session-a', xaiResponsesCacheScope: 'session' },
    params,
    [],
    'grok-4.6'
  );
  const sessionB = xaiResponsesCacheRouting(
    { sessionId: 'session-b', xaiResponsesCacheScope: 'session' },
    params,
    [],
    'grok-4.6'
  );
  assert.equal(sessionA.mode, 'session');
  assert.equal(sessionA.key, sessionAgain.key);
  assert.notEqual(sessionA.key, sessionB.key);

  const sharedA = xaiResponsesCacheRouting(
    { sessionId: 'session-a', xaiResponsesCacheScope: 'prefix' },
    params,
    [],
    'grok-4.6'
  );
  const sharedB = xaiResponsesCacheRouting(
    { sessionId: 'session-b', xaiResponsesCacheScope: 'prefix' },
    params,
    [],
    'grok-4.6'
  );
  assert.equal(sharedA.mode, 'prefix');
  assert.equal(sharedA.key, sharedB.key);

  const payload = _xaiResponsesFingerprintPayloadForTest({
    model: 'grok-4.6',
    opts: {
      sessionId: 'session-a',
      providerState: {
        xaiResponses: { store: false, seenMessageCount: 6 },
      },
    },
    params: {
      input: [{ role: 'user', content: 'next' }],
      prompt_cache_key: first.key,
      store: false,
    },
    rawTools: [],
    response: {
      model: 'grok-4.6-build',
      usage: {
        input_tokens: 7_324,
        input_tokens_details: { cached_tokens: 128 },
      },
    },
    cacheRouting: first,
    previousResponseId: null,
    inputStartIndex: 0,
    continuationResetReason: null,
    transport: 'http',
    cacheLane: null,
  });
  assert.equal(payload.previous_response_used, false);
  assert.equal(payload.stateless_continuation_used, true);
  assert.equal(payload.continuation_used, true);
  assert.equal(payload.mid_turn_cold, true);
});

test('grok-oauth: every OAuth model is pinned to the CLI proxy over HTTP/SSE', () => {
  const prevOaiTransport = process.env.MIXDOG_OAI_TRANSPORT;
  const prevResponsesTransport = process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT;
  const prevGrokTransport = process.env.MIXDOG_GROK_OAUTH_TRANSPORT;
  try {
    process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
    delete process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT;
    delete process.env.MIXDOG_GROK_OAUTH_TRANSPORT;
    const provider = new GrokOAuthProvider({ preconnect: false });

    for (const model of ['grok-build-0.1', 'grok-build', 'grok-4.5']) {
      const inner = provider._ensureInner(`tok-${model}`, model);
      assert.equal(inner.config.responsesTransport, 'http');
      assert.equal(inner.baseURL, 'https://cli-chat-proxy.grok.com/v1');
    }

    // OAuth routing is a security boundary: even explicit WS settings
    // cannot send the session bearer to the fixed api.x.ai WS endpoint.
    process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT = 'websocket';
    const pinnedProvider = new GrokOAuthProvider({ preconnect: false, responsesTransport: 'websocket' });
    const pinned = pinnedProvider._ensureInner('tok-explicit', 'grok-4.5');
    assert.equal(pinned.config.responsesTransport, 'http');
    assert.equal(pinned.baseURL, 'https://cli-chat-proxy.grok.com/v1');
  } finally {
    if (prevOaiTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
    else process.env.MIXDOG_OAI_TRANSPORT = prevOaiTransport;
    if (prevResponsesTransport == null) delete process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT;
    else process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT = prevResponsesTransport;
    if (prevGrokTransport == null) delete process.env.MIXDOG_GROK_OAUTH_TRANSPORT;
    else process.env.MIXDOG_GROK_OAUTH_TRANSPORT = prevGrokTransport;
  }
});
