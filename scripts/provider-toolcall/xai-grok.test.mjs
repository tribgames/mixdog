import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAICompatProvider,
  _xaiResponsesFingerprintPayloadForTest,
  xaiResponsesCacheRouting,
  GrokOAuthProvider,
  _computeDelta,
  _sansInput,
  _stableStringify,
  BUILTIN_TOOLS,
  normalizeGrokToolSchemas,
} from './_shared.mjs';


// === 5. grok-oauth =========================================================
// grok-oauth has NO independent tool_call parser. GrokOAuthProvider delegates
// all request shaping AND response parsing to an inner OpenAICompatProvider
// constructed as `new OpenAICompatProvider('xai', ...)` (grok-oauth.mjs:668).
// Its tool_call extraction therefore goes through the exact
// parseToolCalls / parseResponsesToolCalls already asserted in block 1 — no
// duplicate test. (Documented as shared in the report.)

test('Grok schema flatten keeps grep pattern required', () => {
    const grep = BUILTIN_TOOLS.find((tool) => tool.name === 'grep');
    assert.deepEqual(grep?.inputSchema?.required, ['pattern']);
    assert.equal(grep?.inputSchema?.properties?.pattern?.anyOf?.[0]?.type, 'string');
    assert.equal(grep?.inputSchema?.properties?.pattern?.anyOf?.[1]?.type, 'array');
    const [normalized] = normalizeGrokToolSchemas([grep]);
    for (const key of ['pattern', 'path', 'glob']) {
        assert.equal(normalized.inputSchema.properties[key]?.type, 'string');
        assert.equal(normalized.inputSchema.properties[key]?.anyOf, undefined);
    }
    assert.equal(normalized.inputSchema.anyOf, undefined);
    assert.equal(normalized.inputSchema.oneOf, undefined);
    assert.deepEqual(normalized.inputSchema.required, ['pattern']);
});

test('Grok schema flatten promotes the first XOR required-only anyOf key', () => {
    const [normalized] = normalizeGrokToolSchemas([{
        name: 'grep',
        inputSchema: {
            type: 'object',
            properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
            anyOf: [{ required: ['pattern'] }, { required: ['glob'] }],
            additionalProperties: false,
        },
    }]);
    assert.equal(normalized.inputSchema.anyOf, undefined);
    assert.deepEqual(normalized.inputSchema.required, ['pattern']);
});

test('Grok schema flatten promotes the first XOR object-branch required key', () => {
    const [normalized] = normalizeGrokToolSchemas([{
        name: 'searchish',
        inputSchema: {
            type: 'object',
            properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
            anyOf: [
                { type: 'object', required: ['pattern'] },
                { type: 'object', required: ['glob'] },
            ],
        },
    }]);
    assert.equal(normalized.inputSchema.anyOf, undefined);
    assert.deepEqual(normalized.inputSchema.required, ['pattern']);
});

test('xAI keeps generate:false in the property guard and falls back to a full frame', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const warmupBody = { model: 'grok-4', generate: false, input: [] };
        const body = { model: 'grok-4', input: [{ role: 'user', content: 'real request' }] };
        const entry = {
            lastRequestSansInput: _stableStringify(_sansInput(warmupBody)),
            lastResponseId: 'xai-warm',
            lastRequestInput: [],
            lastResponseItems: [],
        };
        assert.equal(_sansInput(warmupBody).generate, false);
        const delta = _computeDelta({ entry, body, traceProvider: 'xai' });
        assert.equal(delta.mode, 'full');
        assert.equal(delta.reason, 'request_properties_changed');
        assert.equal(delta.frame.previous_response_id, undefined);
        assert.deepEqual(delta.frame.input, body.input);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('xai Responses cache defaults to conversation-scoped routing and traces stateless mid-turn misses', () => {
    const params = { messages: [{ role: 'system', content: 'stable system' }] };
    const first = xaiResponsesCacheRouting({ sessionId: 'session-a' }, params, [], 'grok-4.6');
    const same = xaiResponsesCacheRouting({ sessionId: 'session-a' }, params, [], 'grok-4.6');
    const other = xaiResponsesCacheRouting({ sessionId: 'session-b' }, params, [], 'grok-4.6');
    assert.equal(first.mode, 'session');
    assert.equal(first.key, same.key);
    assert.notEqual(first.key, other.key);
    assert.equal(first.prefixHash, other.prefixHash);

    const sharedA = xaiResponsesCacheRouting(
        { sessionId: 'session-a', xaiResponsesCacheScope: 'prefix' },
        params,
        [],
        'grok-4.6',
    );
    const sharedB = xaiResponsesCacheRouting(
        { sessionId: 'session-b', xaiResponsesCacheScope: 'prefix' },
        params,
        [],
        'grok-4.6',
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
