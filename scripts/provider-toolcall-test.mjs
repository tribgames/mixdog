#!/usr/bin/env node
// Regression tests pinning the cross-provider "native tool_call extraction"
// contract: when a provider's native parser is fed a well-formed tool_call
// payload, it MUST surface the call in our canonical toolCalls shape
// ({ id, name, arguments }). Synthetic inputs fed directly to the exported parser, asserting the
// resulting outcome. No network, no model. Each provider also gets one
// negative case (no native tool_call → undefined / empty).
//
// Parser entry points (file:line at authoring time) and sharing notes are
// documented inline per provider block below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';

import {
    OpenAICompatProvider,
    _toResponsesToolsForTest,
    _toXaiResponsesInputForTest,
    parseToolCalls as compatParseToolCalls,
    parseResponsesToolCalls as compatParseResponsesToolCalls,
} from '../src/runtime/agent/orchestrator/providers/openai-compat.mjs';
import {
    GrokOAuthProvider,
} from '../src/runtime/agent/orchestrator/providers/grok-oauth.mjs';
import {
    consumeCompatResponsesStream,
    isInvalidToolArgsMarker,
} from '../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';
import {
    consumeCompatChatCompletionStream,
} from '../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';
import {
    _computeDelta,
    _buildResponseCreateFrame,
    _sansInput,
    _stableStringify,
} from '../src/runtime/agent/orchestrator/providers/openai-ws-delta.mjs';
import {
    _cacheObservationForTest,
    _cacheContinuityResetReasonForTest,
    sendViaWebSocket,
} from '../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import {
    _withCodexWsClientMetadata,
} from '../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import {
    _captureTurnStateFromEvent,
} from '../src/runtime/agent/orchestrator/providers/openai-ws-stream.mjs';
import {
    createGeminiTextLeakGuard,
    parseToolCalls as geminiParseToolCalls,
} from '../src/runtime/agent/orchestrator/providers/gemini.mjs';
import {
    _resolveGeminiCacheUsage,
} from '../src/runtime/agent/orchestrator/providers/gemini-cache.mjs';
import { parseSSEStream as anthropicParseSSEStream } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { _buildRequestBodyForCacheSmoke } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { _test as _anthropicApiKeyTest } from '../src/runtime/agent/orchestrator/providers/anthropic.mjs';
import { _toAnthropicMessagesForTest } from '../src/runtime/agent/orchestrator/providers/anthropic.mjs';
import { _test as _anthropicOAuthTest } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import {
    EFFORT_BETA_HEADER,
    LEGACY_EFFORT_BUDGET,
    modelSupportsEffort,
    modelSupportsMaxEffort,
    normalizeAnthropicEffortInput,
    shouldIncludeEffortBeta,
} from '../src/runtime/agent/orchestrator/providers/anthropic-effort.mjs';
import { buildAnthropicBetaHeaders } from '../src/runtime/agent/orchestrator/providers/anthropic-betas.mjs';
import { PATCH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { sendViaHttpSse } from '../src/runtime/agent/orchestrator/providers/openai-oauth-http-sse.mjs';
import { buildRequestBody as buildOpenAIOAuthRequestBody } from '../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { _convertMessagesToResponsesInputForTest } from '../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { OpenAIDirectProvider } from '../src/runtime/agent/orchestrator/providers/openai-ws.mjs';

// --- Helpers ---------------------------------------------------------------

test('OpenAI API-key request keeps public defaults without network under every transport mode', async (t) => {
    const priorTransport = process.env.MIXDOG_OAI_TRANSPORT;
    t.after(() => {
        if (priorTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = priorTransport;
    });
    const provider = new OpenAIDirectProvider({ apiKey: 'fixture-openai-key' });
    for (const mode of ['auto', 'ws-full', 'ws-delta', 'http-sse']) {
        process.env.MIXDOG_OAI_TRANSPORT = mode;
        const calls = [];
        let captured = null;
        const result = await provider.send(
            [{ role: 'user', content: 'fixture' }],
            'gpt-5.4',
            [],
            {
                sessionId: `direct-request-defaults-${mode}`,
                _fetchFn: async () => { throw new Error('global fetch seam must not run'); },
                _sendViaWebSocketFn: async (request) => {
                    calls.push('ws');
                    captured = request;
                    return { content: 'ws-ok', toolCalls: [] };
                },
                _sendViaHttpSseFn: async (request) => {
                    calls.push('http');
                    captured = request;
                    return { content: 'http-ok', toolCalls: [] };
                },
            },
        );
        assert.deepEqual(calls, mode === 'http-sse' ? ['http'] : ['ws'], mode);
        assert.equal(result.content, mode === 'http-sse' ? 'http-ok' : 'ws-ok');
        assert.equal(captured.auth.type, 'openai-direct');
        assert.equal(captured.auth.apiKey, 'fixture-openai-key');
        if (mode !== 'http-sse') assert.equal(captured.traceProvider, 'openai-direct');
        assert.equal(captured.body.store, true);
        assert.equal(captured.body.prompt_cache_retention, '24h');
        assert.equal(captured.body.stream, true);
    }
});

function directHandshakeError(status) {
    return Object.assign(new Error(`handshake ${status}`), { httpStatus: status });
}

function directWsEntry() {
    return { socket: { close() {} }, ephemeral: true };
}

test('OpenAI API-key unsupported handshake 403/404/429 falls back once without nested WS retries', async (t) => {
    const priorTransport = process.env.MIXDOG_OAI_TRANSPORT;
    process.env.MIXDOG_OAI_TRANSPORT = 'auto';
    t.after(() => {
        if (priorTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = priorTransport;
    });
    for (const status of [403, 404, 429]) {
        const provider = new OpenAIDirectProvider({ apiKey: 'fixture-openai-key' });
        let acquires = 0;
        let httpCalls = 0;
        const result = await provider.send([], 'gpt-5.4', [], {
            _fetchFn: async () => { throw new Error('global fetch seam must not run'); },
            _webSocketTestSeams: {
                // Neither null nor an inverted caller policy may override the
                // direct provider's mandatory handshake policy.
                handshakeErrorPolicy: status === 403
                    ? null
                    : () => ({ retry: true, httpFallback: false }),
                _acquireWithRetryFn: async () => {
                    acquires += 1;
                    throw directHandshakeError(status);
                },
                _sleepFn: async () => {},
                _sendSpanTraceFn: () => {},
                _agentTraceFn: () => {},
            },
            _sendViaHttpSseFn: async () => {
                httpCalls += 1;
                return { content: `http-${status}`, toolCalls: [] };
            },
        });
        assert.equal(result.content, `http-${status}`);
        assert.equal(acquires, 1, `handshake ${status} must not retry WS`);
        assert.equal(httpCalls, 1, `handshake ${status} gets one HTTP fallback`);
    }
});

test('OpenAI API-key every application 4xx and exposed output never replay or fall back', async (t) => {
    const priorTransport = process.env.MIXDOG_OAI_TRANSPORT;
    process.env.MIXDOG_OAI_TRANSPORT = 'auto';
    t.after(() => {
        if (priorTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = priorTransport;
    });
    const cases = [
        ...[400, 401, 402, 403, 404, 409, 418, 422, 429, 451, 499]
            .map((status) => ({ status, exposed: null })),
        { status: 500, exposed: 'text' },
        { status: 500, exposed: 'tool' },
    ];
    for (const { status, exposed } of cases) {
        const provider = new OpenAIDirectProvider({ apiKey: 'fixture-openai-key' });
        let acquires = 0;
        let streams = 0;
        let httpCalls = 0;
        let reloads = 0;
        let visibleTextDeltas = 0;
        let dispatchedToolCalls = 0;
        provider.reloadApiKey = () => {
            reloads += 1;
            return 'replacement-key';
        };
        await assert.rejects(provider.send([], 'gpt-5.4', [], {
            onTextDelta: () => { visibleTextDeltas += 1; },
            onToolCall: () => { dispatchedToolCalls += 1; },
            _fetchFn: async () => { throw new Error('global fetch seam must not run'); },
            _webSocketTestSeams: {
                _acquireWithRetryFn: async () => {
                    acquires += 1;
                    return { entry: directWsEntry(), reused: false };
                },
                _sendFrameFn: async () => {},
                _streamFn: async ({ state, onTextDelta, onToolCall }) => {
                    streams += 1;
                    if (exposed === 'text') {
                        onTextDelta?.('visible-once');
                        state.emittedText = true;
                    }
                    if (exposed === 'tool') {
                        onToolCall?.({ id: 'tool-once', name: 'read', arguments: {} });
                        state.emittedToolCall = true;
                    }
                    throw Object.assign(new Error(`application ${status} ${exposed || ''}`), { httpStatus: status });
                },
                _sleepFn: async () => {},
                _sendSpanTraceFn: () => {},
                _agentTraceFn: () => {},
            },
            _sendViaHttpSseFn: async () => {
                httpCalls += 1;
                throw new Error('application/visible output must not reach HTTP');
            },
        }), new RegExp(`application ${status}`));
        assert.equal(acquires, 1);
        assert.equal(streams, 1);
        assert.equal(httpCalls, 0);
        assert.equal(reloads, 0);
        assert.equal(visibleTextDeltas, exposed === 'text' ? 1 : 0);
        assert.equal(dispatchedToolCalls, exposed === 'tool' ? 1 : 0);
    }
});

test('Anthropic API-key gates deferred beta to requests that carry deferred tools', async () => {
    const provider = Object.create((await import('../src/runtime/agent/orchestrator/providers/anthropic.mjs')).AnthropicProvider.prototype);
    provider.name = 'anthropic';
    provider.config = {};
    provider.fastModeBetaHeaderLatched = false;
    const calls = [];
    provider.client = { messages: { create(params, options) {
        calls.push({ params, options });
        return { asResponse: async () => ({
            ...anthropicSseResponse([
                { type: 'message_start', message: { model: params.model, usage: { input_tokens: 1 } } },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
                { type: 'message_stop' },
            ]),
            ok: true,
            status: 200,
            headers: new Map(),
        }) };
    } } };

    await provider._doSend([{ role: 'user', content: 'plain' }], 'claude-sonnet-4-6', [], {});
    assert.doesNotMatch(calls[0].options.headers['anthropic-beta'], /advanced-tool-use/);

    const active = [{ name: 'load_tool', description: 'load', inputSchema: { type: 'object', properties: {} } }];
    const deferred = { name: 'mcp__demo__ping', description: 'ping', inputSchema: { type: 'object', properties: {} } };
    await provider._doSend([{ role: 'user', content: 'load' }], 'claude-sonnet-4-6', active, {
        session: {
            deferredNativeTools: true,
            deferredDiscoveredTools: [deferred.name],
            deferredToolCatalog: [...active, deferred],
        },
    });
    assert.match(calls[1].options.headers['anthropic-beta'], /advanced-tool-use/);
    assert.equal(calls[1].params.tools.find((tool) => tool.name === deferred.name)?.defer_loading, true);
});

test('native deferred history normalizes per provider without leaking OpenAI variants to xAI', () => {
    const nativePayload = {
        provider: 'openai-oauth',
        toolReferences: ['mcp__demo__ping'],
        openaiTools: [{
            type: 'function',
            name: 'mcp__demo__ping',
            defer_loading: true,
            parameters: { type: 'object', properties: {} },
        }],
    };
    const history = [
        { role: 'user', content: 'load it' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'load-1', name: 'load_tool', arguments: { names: ['mcp__demo__ping'] }, nativeType: 'tool_search_call' }],
        },
        { role: 'tool', toolCallId: 'load-1', content: 'Loaded', nativeToolSearch: nativePayload },
    ];
    const openai = _convertMessagesToResponsesInputForTest(history);
    assert.equal(openai[1].type, 'tool_search_call');
    assert.equal(openai[2].type, 'tool_search_output');
    assert.equal(openai[2].tools[0].name, 'mcp__demo__ping');

    const xai = _toXaiResponsesInputForTest(history, {
        xaiResponses: { previousResponseId: 'resp-1', seenMessageCount: 0, model: 'grok-4' },
    }, { model: 'grok-4' }).input;
    assert.equal(xai.some((item) => item.type === 'tool_search_call' || item.type === 'tool_search_output'), false);
    assert.equal(xai[1].type, 'function_call');
    assert.equal(xai[2].type, 'function_call_output');
});

test('Anthropic native deferred result retains tool_reference history and defer_loading declarations', () => {
    const base = [{ name: 'load_tool', description: 'loader', inputSchema: { type: 'object', properties: {} } }];
    const deferred = { name: 'mcp__demo__ping', description: 'ping', inputSchema: { type: 'object', properties: {} } };
    const session = {
        deferredNativeTools: true,
        deferredToolCatalog: [...base, deferred],
    };
    const firstBody = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'find ping' }],
        'claude-sonnet-4-6',
        base,
        { session },
    );
    assert.equal(firstBody.tools.some((tool) => tool.name === 'mcp__demo__ping'), false);
    assert.deepEqual(_anthropicApiKeyTest.deferredAnthropicTools(base, [], { session }), []);
    const history = [
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'load-a1', name: 'load_tool', arguments: { names: ['mcp__demo__ping'] } }],
        },
        {
            role: 'tool',
            toolCallId: 'load-a1',
            content: 'Loaded',
            nativeToolSearch: {
                provider: 'anthropic-oauth',
                toolReferences: ['mcp__demo__ping'],
                openaiTools: [],
            },
        },
    ];
    const body = _buildRequestBodyForCacheSmoke(history, 'claude-sonnet-4-6', base, { session });
    const result = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === 'tool_result');
    assert.deepEqual(result.content, [{ type: 'tool_reference', tool_name: 'mcp__demo__ping' }]);
    assert.equal(body.tools.find((tool) => tool.name === 'mcp__demo__ping')?.defer_loading, true);
    const apiKeyHistory = history.map((message) => (
        message.nativeToolSearch
            ? { ...message, nativeToolSearch: { ...message.nativeToolSearch, provider: 'anthropic' } }
            : message
    ));
    const apiKeyDiscovered = _anthropicApiKeyTest.deferredAnthropicTools(base, apiKeyHistory, { session });
    assert.equal(apiKeyDiscovered.find((tool) => tool.name === 'mcp__demo__ping')?.deferLoading, true);
    session.deferredDiscoveredTools = ['mcp__demo__ping'];
    const compacted = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'continue after compact' }],
        'claude-sonnet-4-6',
        base,
        { session },
    );
    assert.equal(compacted.tools.find((tool) => tool.name === 'mcp__demo__ping')?.defer_loading, true);
    const apiKeyCompacted = _anthropicApiKeyTest.deferredAnthropicTools(base, [], { session });
    assert.equal(apiKeyCompacted.find((tool) => tool.name === 'mcp__demo__ping')?.deferLoading, true);
});

test('Anthropic API-key and OAuth preserve root properties across compound schemas', () => {
    const properties = {
        pattern: { type: 'string' },
        path: { type: 'string' },
    };
    const branches = [
            { required: ['pattern'] },
            { required: ['path'] },
    ];
    for (const compoundKey of ['oneOf', 'anyOf', 'allOf']) {
        const schema = { type: 'object', properties, [compoundKey]: branches };
        const expected = { type: 'object', properties };
        const apiKey = _anthropicApiKeyTest.sanitizeInputSchema(schema, 'grep');
        const oauth = _anthropicOAuthTest.sanitizeInputSchema(schema, 'grep');

        assert.deepEqual(apiKey, expected, `API-key ${compoundKey}`);
        assert.deepEqual(oauth, expected, `OAuth ${compoundKey}`);
        assert.deepEqual(apiKey, oauth, `${compoundKey} parity`);
    }
});

test('OpenAI native provider-tag switches keep tool_search call/output paired', () => {
    const history = [
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'native-pair', name: 'load_tool', arguments: {}, nativeType: 'tool_search_call' }],
        },
        {
            role: 'tool',
            toolCallId: 'native-pair',
            content: 'Loaded',
            nativeToolSearch: {
                provider: 'openai',
                toolReferences: ['read'],
                openaiTools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }],
            },
        },
    ];
    const oauth = _convertMessagesToResponsesInputForTest(history, { nativeToolSearchProvider: 'openai-oauth' });
    assert.deepEqual(oauth.map((item) => item.type), ['tool_search_call', 'tool_search_output']);
    history[1].nativeToolSearch.provider = 'openai-oauth';
    const direct = _convertMessagesToResponsesInputForTest(history, { nativeToolSearchProvider: 'openai' });
    assert.deepEqual(direct.map((item) => item.type), ['tool_search_call', 'tool_search_output']);
});

test('Anthropic native provider-tag switches preserve tool_reference and loaded schema bidirectionally', () => {
    const base = [{ name: 'load_tool', description: 'loader', inputSchema: { type: 'object', properties: {} } }];
    const deferred = { name: 'mcp__demo__ping', description: 'ping', inputSchema: { type: 'object', properties: {} } };
    const session = {
        deferredNativeTools: true,
        deferredToolCatalog: [...base, deferred],
    };
    const history = (provider) => [
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'anthropic-family-pair', name: 'load_tool', arguments: { names: ['mcp__demo__ping'] } }],
        },
        {
            role: 'tool',
            toolCallId: 'anthropic-family-pair',
            content: 'Loaded deferred tools: mcp__demo__ping',
            nativeToolSearch: {
                provider,
                toolReferences: ['mcp__demo__ping'],
                openaiTools: [],
            },
        },
    ];
    const apiKeyToOauth = _buildRequestBodyForCacheSmoke(
        history('anthropic'),
        'claude-sonnet-4-6',
        base,
        { session },
    );
    const oauthResult = apiKeyToOauth.messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === 'tool_result');
    assert.deepEqual(oauthResult.content, [{ type: 'tool_reference', tool_name: 'mcp__demo__ping' }]);
    assert.equal(apiKeyToOauth.tools.find((tool) => tool.name === 'mcp__demo__ping')?.defer_loading, true);

    const oauthHistory = history('anthropic-oauth');
    const oauthToApiKeyMessages = _toAnthropicMessagesForTest(oauthHistory);
    const apiKeyResult = oauthToApiKeyMessages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === 'tool_result');
    assert.deepEqual(apiKeyResult.content, [{ type: 'tool_reference', tool_name: 'mcp__demo__ping' }]);
    const apiKeyTools = _anthropicApiKeyTest.deferredAnthropicTools(base, oauthHistory, { session });
    assert.equal(apiKeyTools.find((tool) => tool.name === 'mcp__demo__ping')?.deferLoading, true);
});

// Wraps an array of Anthropic SSE event objects in a minimal Response-like
// shape exposing the single `body.getReader()` API that parseSSEStream uses.
// Each event becomes a `data: <json>` SSE frame, preceded by its `event:` line.
function anthropicSseResponse(events) {
    const encoder = new TextEncoder();
    const frames = events.map((e) => {
        const type = e.type || 'message';
        return `event: ${type}\ndata: ${JSON.stringify(e)}\n\n`;
    });
    const chunks = frames.map((f) => encoder.encode(f));
    let i = 0;
    return {
        body: {
            getReader() {
                return {
                    read() {
                        if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] });
                        return Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}

test('anthropic SSE exposes refusal stop details and category metadata', async () => {
    const result = await anthropicParseSSEStream(
        anthropicSseResponse([
            { type: 'message_start', message: { model: 'claude-fable-5', usage: { input_tokens: 1 } } },
            {
                type: 'message_delta',
                delta: {
                    stop_reason: 'refusal',
                    stop_details: { classifier: 'safety' },
                    category: 'policy',
                },
                usage: { output_tokens: 0 },
            },
            { type: 'message_stop' },
        ]),
        null, () => {}, () => {}, () => {}, {}, null,
    );

    assert.equal(result.stopReason, 'refusal');
    assert.deepEqual(result.stopDetails, { classifier: 'safety', category: 'policy' });
    assert.equal(result.content, '');
});

function compatResponsesEventStream(events) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
        },
    };
}

// Minimal 200-OK Response-like shape for the HTTP/SSE Responses path: frames
// each event as `event:<type>\ndata:<json>\n\n`, delivered synchronously so the
// semantic-idle watchdog never arms during the test.
function httpSseResponse(events) {
    const encoder = new TextEncoder();
    const chunks = events.map((e) => encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    let i = 0;
    return {
        status: 200,
        ok: true,
        headers: new Map(),
        body: {
            getReader() {
                return {
                    read() {
                        return i < chunks.length
                            ? Promise.resolve({ done: false, value: chunks[i++] })
                            : Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}

// === 1. openai-compat ======================================================
// Chat path:      parseToolCalls(choice, label)         openai-compat.mjs:957
// Responses path: parseResponsesToolCalls(response,...) openai-compat.mjs:972
// Both exported (added `export` keyword only).

test('openai-compat (chat): native tool_calls → canonical toolCalls', () => {
    const choice = {
        message: {
            tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'grep', arguments: '{"pattern":"x"}' },
            }],
        },
        finish_reason: 'tool_calls',
    };
    const out = compatParseToolCalls(choice, 'test');
    assert.deepEqual(out, [{ id: 'call_1', name: 'grep', arguments: { pattern: 'x' } }]);
});

test('openai-compat (chat): no tool_calls → undefined', () => {
    assert.equal(compatParseToolCalls({ message: { content: 'hi' }, finish_reason: 'stop' }, 'test'), undefined);
    assert.equal(compatParseToolCalls({ message: { tool_calls: [] } }, 'test'), undefined);
});

test('openai-compat (responses): native function_call → canonical toolCalls', () => {
    const response = {
        status: 'completed',
        output: [{
            type: 'function_call',
            call_id: 'fc_1',
            name: 'read',
            arguments: '{"path":"a"}',
        }],
    };
    const out = compatParseResponsesToolCalls(response, 'test');
    assert.deepEqual(out, [{ id: 'fc_1', name: 'read', arguments: { path: 'a' } }]);
});

test('openai-compat (responses): no function_call → undefined', () => {
    assert.equal(compatParseResponsesToolCalls({ status: 'completed', output: [] }, 'test'), undefined);
    assert.equal(compatParseResponsesToolCalls({ output: [{ type: 'message', content: [] }] }, 'test'), undefined);
});

// Native convergence: a completed function tool_call whose arguments JSON is
// malformed must NOT make the provider layer throw or swallow to {}. The parse
// failure rides through on the call's `arguments` slot as an invalid-args
// marker so the dispatch loop can return an is_error tool_result and let the
// model self-correct in the same turn.
test('openai-compat (chat): malformed tool_calls args → invalid-args marker (provider does not throw)', () => {
    const choice = {
        message: {
            tool_calls: [{
                id: 'call_bad',
                type: 'function',
                function: { name: 'grep', arguments: '{"pattern": dispatchAiWrapped}' },
            }],
        },
        finish_reason: 'tool_calls',
    };
    const out = compatParseToolCalls(choice, 'test');
    assert.equal(Array.isArray(out), true);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'call_bad');
    assert.equal(out[0].name, 'grep');
    assert.equal(isInvalidToolArgsMarker(out[0].arguments), true);
});

test('openai-compat (responses): malformed function_call args → invalid-args marker (no throw)', () => {
    const response = {
        status: 'completed',
        output: [{
            type: 'function_call',
            call_id: 'fc_bad',
            name: 'read',
            arguments: '{path:}',
        }],
    };
    const out = compatParseResponsesToolCalls(response, 'test');
    assert.equal(Array.isArray(out), true);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'fc_bad');
    assert.equal(out[0].name, 'read');
    assert.equal(isInvalidToolArgsMarker(out[0].arguments), true);
});

test('openai-compat/xai Responses stream: response.completed salvages deferred function_call id/name', async () => {
    const captured = [];
    const out = await consumeCompatResponsesStream(compatResponsesEventStream([
        { type: 'response.created', response: { id: 'resp_1', model: 'grok' } },
        {
            type: 'response.function_call_arguments.done',
            item_id: 'fc_item_1',
            arguments: '{"path":"a"}',
        },
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                model: 'grok',
                status: 'completed',
                output: [{
                    type: 'function_call',
                    id: 'fc_item_1',
                    call_id: 'fc_1',
                    name: 'read',
                    arguments: '{"path":"a"}',
                }],
            },
        },
    ]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onToolCall: (call) => captured.push(call),
    });
    assert.deepEqual(out.toolCalls, [{ id: 'fc_1', name: 'read', arguments: { path: 'a' } }]);
    assert.deepEqual(captured, [{ id: 'fc_1', name: 'read', arguments: { path: 'a' } }]);
});

// Missing-terminal + partial-tool gate (shared tool-stream-state.mjs tracker):
// a Responses stream that streams a CUSTOM tool call's input then truncates
// before response.output_item.done / response.completed. The call never lands
// in pendingCalls or toolCalls, so the truncation error must be gated as
// pendingToolUse via the shared active tool-item tracker (activeToolItems),
// NOT accepted as a text-only partial-final that would drop the in-flight tool.
test('openai-compat/xai Responses stream: mid custom-tool-input truncation is gated pendingToolUse via shared tracker', async () => {
    const rejected = await consumeCompatResponsesStream(compatResponsesEventStream([
        { type: 'response.created', response: { id: 'resp_ct', model: 'grok' } },
        { type: 'response.output_text.delta', delta: 'partial ' },
        { type: 'response.output_item.added', item: { type: 'custom_tool_call', id: 'ct_item_1' } },
        { type: 'response.custom_tool_call_input.delta', item_id: 'ct_item_1', delta: '{"x":' },
        // stream truncates here: no output_item.done, no response.completed.
    ]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onTextDelta: () => {},
    }).then(() => null, (e) => e);
    assert.ok(rejected, 'expected the truncated stream to reject');
    assert.equal(rejected.streamStalled, true);
    // The in-flight custom tool must gate partial-final success even though it
    // never reached pendingCalls/toolCalls — the active tracker carries it.
    assert.equal(rejected.pendingToolUse, true);
    assert.equal(rejected.partialContent, 'partial ');
});

// Precision half of the same tracker: once the tool call fully COMPLETES
// (output_item.done clears the active item) and text keeps streaming, a later
// truncation is a plain text-only partial — the tracker having been cleared is
// what lets pendingToolUse fall back to the real emit/pending state.
test('openai-compat/xai Responses stream: completed tool then trailing-text truncation clears active tracker', async () => {
    let emitted = 0;
    const rejected = await consumeCompatResponsesStream(compatResponsesEventStream([
        { type: 'response.created', response: { id: 'resp_done', model: 'grok' } },
        { type: 'response.output_item.added', item: { type: 'custom_tool_call', id: 'ct_done_1' } },
        { type: 'response.custom_tool_call_input.delta', item_id: 'ct_done_1', delta: '{"x":1}' },
        { type: 'response.output_item.done', item: { type: 'custom_tool_call', id: 'ct_done_1', name: 'load_tool', input: '{"x":1}' } },
        { type: 'response.output_text.delta', delta: 'after tool ' },
        // truncates before response.completed.
    ]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onTextDelta: () => {},
        onToolCall: () => { emitted += 1; },
    }).then(() => null, (e) => e);
    assert.ok(rejected, 'expected the truncated stream to reject');
    assert.equal(rejected.streamStalled, true);
    // A tool WAS emitted this turn, so the turn is still unsafe/tool-bearing —
    // pendingToolUse stays true off the emit state, not a stale active latch.
    assert.ok(emitted >= 1);
    assert.equal(rejected.pendingToolUse, true);
});

// Reviewer fix: function output_item.done must delete the pendingCalls itemId
// before recomputing toolInFlight — otherwise a fully-completed function call
// keeps pendingCalls.size > 0 forever, and a later max-output cutoff on trailing
// text is misclassified as a truncated tool-in-flight stall instead of a clean
// length completion.
test('openai-compat/xai Responses stream: completed function call clears pendingCalls so max-output cutoff is clean length', async () => {
    const out = await consumeCompatResponsesStream(compatResponsesEventStream([
        { type: 'response.created', response: { id: 'resp_len', model: 'grok' } },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fi_len', name: 'read', call_id: 'fc_len' } },
        { type: 'response.function_call_arguments.done', item_id: 'fi_len', arguments: '{"path":"a"}' },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fi_len', call_id: 'fc_len', name: 'read', arguments: '{"path":"a"}' } },
        { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    ]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
    });
    // The completed call drained pendingCalls + the active tracker, so the
    // max-output cutoff is a clean length truncation (no in-flight-tool stall).
    assert.equal(out.stopReason, 'length');
    assert.deepEqual(out.toolCalls, [{ id: 'fc_len', name: 'read', arguments: { path: 'a' } }]);
});

// Reviewer fix (HTTP/SSE): a max_output_tokens cutoff while a function call is
// still in flight (added + partial args, no output_item.done) must NOT mark a
// clean length completion — the tool arguments were truncated. Mirror compat:
// throw a stream-stalled pendingToolUse error so the loop gates/retries.
test('openai-oauth HTTP/SSE Responses: max-output cutoff with function call in flight → stream-stalled pendingToolUse', async () => {
    const rejected = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'k' },
        body: { model: 'gpt', tools: [] },
        useModel: 'gpt',
        fetchFn: async () => httpSseResponse([
            { type: 'response.created', response: { id: 'r', model: 'gpt' } },
            { type: 'response.output_item.added', item: { type: 'function_call', id: 'fi_1', name: 'read', call_id: 'fc_1' } },
            { type: 'response.function_call_arguments.delta', item_id: 'fi_1', delta: '{"path":' },
            { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
        ]),
    }).then(() => null, (e) => e);
    assert.ok(rejected, 'expected the truncated-tool cutoff to reject');
    assert.equal(rejected.streamStalled, true);
    assert.equal(rejected.pendingToolUse, true);
});

// Reviewer fix (HTTP/SSE): function output_item.done must delete pendingCalls[id]
// before recomputing _toolInFlight — otherwise the completed call keeps
// pendingCalls.size > 0 and a later max-output cutoff is misread as a truncated
// tool. A fully-completed call before the cutoff must be a clean length result.
test('openai-oauth HTTP/SSE Responses: completed function call clears pendingCalls so max-output cutoff is clean length', async () => {
    const out = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'k' },
        body: { model: 'gpt', tools: [] },
        useModel: 'gpt',
        fetchFn: async () => httpSseResponse([
            { type: 'response.created', response: { id: 'r', model: 'gpt' } },
            { type: 'response.output_item.added', item: { type: 'function_call', id: 'fi_1', name: 'read', call_id: 'fc_1' } },
            { type: 'response.function_call_arguments.done', item_id: 'fi_1', arguments: '{"path":"a"}' },
            { type: 'response.output_item.done', item: { type: 'function_call', id: 'fi_1', call_id: 'fc_1', name: 'read', arguments: '{"path":"a"}' } },
            { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
        ]),
    });
    assert.equal(out.stopReason, 'length');
    assert.deepEqual(out.toolCalls, [{ id: 'fc_1', name: 'read', arguments: { path: 'a' } }]);
});

test('openai-compat/xai Responses: freeform apply_patch downgrades to function schema', () => {
    const tools = _toResponsesToolsForTest(PATCH_TOOL_DEFS);
    const patch = tools.find((tool) => tool.name === 'apply_patch');
    assert.equal(patch.type, 'function');
    assert.equal(patch.format, undefined);
    assert.equal(patch.parameters?.properties?.patch?.type, 'string');
    assert.deepEqual(patch.parameters?.required, ['patch']);
});

test('openai-compat/xai Responses: load_tool downgrades from tool_search to function schema', () => {
    const loadTool = {
        name: 'load_tool',
        description: 'load tools',
        inputSchema: {
            type: 'object',
            properties: { names: { type: 'array', items: { type: 'string' } } },
        },
    };
    const [xaiTool] = _toResponsesToolsForTest([loadTool], { provider: 'xai' });
    assert.equal(xaiTool.type, 'function');
    assert.equal(xaiTool.name, 'load_tool');
    assert.equal(xaiTool.execution, undefined);
    assert.equal(xaiTool.parameters, loadTool.inputSchema);

    const [openaiTool] = _toResponsesToolsForTest([loadTool], { provider: 'openai' });
    assert.equal(openaiTool.type, 'tool_search');
    assert.equal(openaiTool.execution, 'client');
    assert.equal(openaiTool.name, undefined);
});

test('openai-compat/xai Responses: load_tool history replays as function_call', () => {
    const { input } = _toXaiResponsesInputForTest([
        { role: 'user', content: 'load a tool' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_load_1', name: 'load_tool', arguments: { names: ['read'] }, nativeType: 'tool_search_call' }],
        },
        {
            role: 'tool',
            toolCallId: 'call_load_1',
            content: '{}',
            nativeToolSearch: { openaiTools: [{ name: 'read' }] },
        },
    ], {
        xaiResponses: {
            previousResponseId: 'resp_same',
            seenMessageCount: 0,
            model: 'grok-4.5',
        },
    }, { model: 'grok-4.5' });
    assert.equal(input.some((item) => item.type === 'tool_search_call'), false);
    assert.equal(input.some((item) => item.type === 'tool_search_output'), false);
    const call = input.find((item) => item.type === 'function_call' && item.name === 'load_tool');
    assert.equal(call.call_id, 'call_load_1');
    assert.deepEqual(JSON.parse(call.arguments), { names: ['read'] });
    assert.equal(input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_load_1'), true);
});

test('openai-compat/xai Responses: model switch drops prior tool transcript history', () => {
    const { input, previousResponseId, continuationResetReason } = _toXaiResponsesInputForTest([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'before switch' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_load_1', name: 'load_tool', arguments: { names: ['read'] }, nativeType: 'tool_search_call' }],
        },
        { role: 'tool', toolCallId: 'call_load_1', content: '{"loaded":["read"]}' },
        { role: 'user', content: 'after switch' },
    ], {
        xaiResponses: {
            previousResponseId: 'resp_old',
            seenMessageCount: 4,
            model: 'grok-4.20',
        },
    }, { model: 'grok-4.5' });
    assert.equal(previousResponseId, null);
    assert.equal(continuationResetReason, 'model_changed');
    const serialized = JSON.stringify(input);
    assert.equal(serialized.includes('tool_search'), false);
    assert.equal(serialized.includes('function_call'), false);
    assert.equal(serialized.includes('function_call_output'), false);
    assert.deepEqual(input.map((item) => item.role), ['system', 'user', 'user']);
});

test('openai-compat/xai Responses: first Grok request after provider switch drops prior tool transcript history', () => {
    const { input, previousResponseId, continuationResetReason } = _toXaiResponsesInputForTest([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'before switch' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_patch_1', name: 'apply_patch', arguments: { patch: '*** Begin Patch\n*** End Patch\n' } }],
        },
        { role: 'tool', toolCallId: 'call_patch_1', content: 'OK' },
        { role: 'user', content: 'after switch' },
    ], {}, { model: 'grok-4.5' });
    assert.equal(previousResponseId, null);
    assert.equal(continuationResetReason, null);
    const serialized = JSON.stringify(input);
    assert.equal(serialized.includes('function_call'), false);
    assert.equal(serialized.includes('function_call_output'), false);
    assert.deepEqual(input.map((item) => item.role), ['system', 'user', 'user']);
});

test('openai-oauth Responses: load_tool uses native tool_search history', () => {
    const loadTool = {
        name: 'load_tool',
        description: 'load tools',
        inputSchema: {
            type: 'object',
            properties: { names: { type: 'array', items: { type: 'string' } } },
        },
    };
    const body = buildOpenAIOAuthRequestBody([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'load a tool' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_load_1', name: 'tool_search', arguments: { names: ['read'] }, nativeType: 'tool_search_call' }],
        },
        {
            role: 'tool',
            toolCallId: 'call_load_1',
            content: 'Loaded deferred tools: read',
            nativeToolSearch: {
                provider: 'openai-oauth',
                toolReferences: ['read'],
                openaiTools: [{
                    type: 'function',
                    name: 'read',
                    description: 'read',
                    defer_loading: true,
                    parameters: { type: 'object', properties: {} },
                }],
            },
        },
    ], 'gpt-5.5', [loadTool], {});
    assert.equal(JSON.stringify(body).includes('tool_search'), true);
    assert.deepEqual(body.tools, [{
        type: 'tool_search',
        execution: 'client',
        description: loadTool.description,
        parameters: loadTool.inputSchema,
    }]);
    const call = body.input.find((item) => item.type === 'tool_search_call');
    assert.deepEqual(call, {
        type: 'tool_search_call',
        call_id: 'call_load_1',
        execution: 'client',
        arguments: { names: ['read'] },
    });
    const output = body.input.find((item) => item.type === 'tool_search_output' && item.call_id === 'call_load_1');
    assert.deepEqual(output, {
        type: 'tool_search_output',
        call_id: 'call_load_1',
        status: 'completed',
        execution: 'client',
        tools: [{
            type: 'function',
            name: 'read',
            description: 'read',
            defer_loading: true,
            parameters: { type: 'object', properties: {} },
        }],
    });
});

test('openai-compat/xai Responses: custom_tool_call history replays as function_call', () => {
    const rawPatch = '*** Begin Patch\n*** Add File: xai-history.txt\n+ok\n*** End Patch\n';
    const { input } = _toXaiResponsesInputForTest([
        { role: 'user', content: 'patch please' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_patch_1', name: 'apply_patch', arguments: { patch: rawPatch }, nativeType: 'custom_tool_call' }],
        },
        { role: 'tool', toolCallId: 'call_patch_1', content: 'OK' },
    ], {
        xaiResponses: {
            previousResponseId: 'resp_same',
            seenMessageCount: 0,
            model: 'grok-composer-2.5-fast',
        },
    }, { model: 'grok-composer-2.5-fast' });
    assert.equal(input.some((item) => item.type === 'custom_tool_call'), false);
    assert.equal(input.some((item) => item.type === 'custom_tool_call_output'), false);
    const call = input.find((item) => item.type === 'function_call' && item.name === 'apply_patch');
    assert.equal(call.call_id, 'call_patch_1');
    assert.deepEqual(JSON.parse(call.arguments), { patch: rawPatch });
    const output = input.find((item) => item.type === 'function_call_output');
    assert.equal(output.call_id, 'call_patch_1');
    assert.equal(output.output, 'OK');
});

// === 2. gemini =============================================================
// parseToolCalls(parts)   gemini.mjs:946  (exported — `export` keyword only).
// id is a content hash → assert the `gemini_` prefix, not the exact value.

test('gemini: native functionCall parts → canonical toolCalls (hashed id)', () => {
    const parts = [{ functionCall: { name: 'read', args: { path: 'a' } } }];
    const out = geminiParseToolCalls(parts);
    assert.equal(Array.isArray(out), true);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'read');
    assert.deepEqual(out[0].arguments, { path: 'a' });
    assert.match(out[0].id, /^gemini_/);
});

test('gemini: no functionCall parts → undefined', () => {
    assert.equal(geminiParseToolCalls([{ text: 'hello' }]), undefined);
    assert.equal(geminiParseToolCalls([]), undefined);
});

test('gemini leak guard: leaked <invoke> in part.text for known tool → recovered, no leak', () => {
    const leaked = 'Sure.\n<function_calls>\n<invoke name="read">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</function_calls>';
    const texts = [];
    const captured = [];
    const guard = createGeminiTextLeakGuard({
        knownToolNames: LEAK_TOOLS,
        onTextDelta: (t) => texts.push(t),
        onToolCall: (c) => captured.push(c),
    });
    guard.feedText(leaked);
    guard.finalize();
    const content = guard.scrubAssistantText(leaked);
    const emitted = texts.join('');
    assert.equal(/<invoke|<function_calls|<parameter/.test(emitted), false);
    assert.equal(/<invoke|<function_calls|<parameter/.test(content), false);
    assert.ok(emitted.includes('Sure.'));
    assert.ok(content.includes('Sure.'));
    const leakedCalls = guard.getLeakedToolCalls();
    assert.equal(leakedCalls.length, 1);
    assert.equal(leakedCalls[0].name, 'read');
    assert.deepEqual(leakedCalls[0].arguments, { path: 'a.txt' });
    assert.match(leakedCalls[0].id, /^gemini_leaked_/);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'read');
});

test('gemini leak guard: unknown tool name → text flushed, no synthetic call', () => {
    const leaked = '<function_calls>\n<invoke name="nonexistent_tool">\n<parameter name="x">1</parameter>\n</invoke>\n</function_calls>';
    const captured = [];
    const guard = createGeminiTextLeakGuard({
        knownToolNames: LEAK_TOOLS,
        onToolCall: (c) => captured.push(c),
    });
    guard.feedText(leaked);
    guard.finalize();
    const content = guard.scrubAssistantText(leaked);
    assert.equal(guard.getLeakedToolCalls().length, 0);
    assert.equal(captured.length, 0);
    assert.ok(content.includes('nonexistent_tool'));
});

test('gemini cache usage: official cached token fields are subsets of prompt tokens', () => {
    const direct = _resolveGeminiCacheUsage({
        usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 400 },
    });
    assert.deepEqual({
        inputTokens: direct.inputTokens,
        reportedCachedTokens: direct.reportedCachedTokens,
        cachedTokens: direct.cachedTokens,
        cacheTokenSource: direct.cacheTokenSource,
    }, {
        inputTokens: 1000,
        reportedCachedTokens: 400,
        cachedTokens: 400,
        cacheTokenSource: 'usage_metadata',
    });

    const sdkAlias = _resolveGeminiCacheUsage({
        usageMetadata: { prompt_token_count: 1200, total_cached_tokens: 500 },
    });
    assert.equal(sdkAlias.inputTokens, 1200);
    assert.equal(sdkAlias.reportedCachedTokens, 500);
    assert.equal(sdkAlias.cachedTokens, 500);
    assert.notEqual(sdkAlias.inputTokens, 0, 'snake_case SDK aliases must remain visible to provider return usage');
});

test('gemini cache usage: clamps over-reported cache and falls back only for attached cachedContent', () => {
    const clamped = _resolveGeminiCacheUsage({
        usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 150 },
    });
    assert.equal(clamped.cachedTokens, 100);

    const fallback = _resolveGeminiCacheUsage({
        usageMetadata: { promptTokenCount: 1000 },
        cachedContent: 'cachedContents/abc',
        providerState: { gemini: { cacheTokenSize: 250 } },
    });
    assert.equal(fallback.cachedTokens, 250);
    assert.equal(fallback.cacheTokenSource, 'cache_create_fallback');

    const noFallbackWithoutAttachment = _resolveGeminiCacheUsage({
        usageMetadata: { promptTokenCount: 1000 },
        providerState: { gemini: { cacheTokenSize: 250 } },
    });
    assert.equal(noFallbackWithoutAttachment.cachedTokens, 0);
    assert.equal(noFallbackWithoutAttachment.cacheTokenSource, 'none');
});

// === 3. anthropic / anthropic-oauth ========================================
// tool_use block parser lives in anthropic-oauth.mjs:936 parseSSEStream
// (content_block_start/delta/stop → toolCalls.push). anthropic.mjs has NO
// independent tool_use parser: it imports and reuses the SAME parseSSEStream
// from anthropic-oauth.mjs (anthropic.mjs:12). So a single test covers both
// providers — shared parser, no duplicate test needed.

test('anthropic(-oauth): streamed tool_use block → canonical toolCalls', async () => {
    const events = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(events),
        null,            // signal
        () => {},        // abortStream
        () => {},        // onStreamDelta
        (call) => captured.push(call), // onToolCall
        {},              // state
        null,            // onTextDelta
    );
    assert.deepEqual(result.toolCalls, [{ id: 'toolu_1', name: 'shell', arguments: { command: 'ls' } }]);
    // Eager dispatch fired the same call exactly once.
    assert.deepEqual(captured, [{ id: 'toolu_1', name: 'shell', arguments: { command: 'ls' } }]);
});

test('anthropic(-oauth): malformed streamed tool_use args → invalid-args marker, not {} dispatch', async () => {
    const events = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_bad', name: 'shell' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command": dispatchAiWrapped}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(events),
        null,
        () => {},
        () => {},
        (call) => captured.push(call),
        {},
        null,
    );
    assert.equal(isInvalidToolArgsMarker(result.toolCalls[0].arguments), true);
    assert.equal(result.toolCalls[0].arguments.__rawArguments, '{"command": dispatchAiWrapped}');
    assert.equal(isInvalidToolArgsMarker(captured[0].arguments), true);
});

test('anthropic(-oauth): text-only stream → no toolCalls', async () => {
    const events = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(events),
        null, () => {}, () => {}, () => {}, {}, null,
    );
    assert.equal(result.toolCalls, undefined);
    assert.equal(result.content, 'hello');
});

test('anthropic(-oauth): thinking + signature deltas → ordered thinkingBlocks before tool_use', async () => {
    const events = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'step ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'one' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'shell' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(events),
        null, () => {}, () => {}, () => {}, {}, null,
    );
    assert.equal(result.hasThinkingContent, true);
    assert.deepEqual(result.thinkingBlocks, [
        { type: 'thinking', thinking: 'step one', signature: 'sig123' },
    ]);
    assert.deepEqual(result.toolCalls, [{ id: 'toolu_9', name: 'shell', arguments: { command: 'ls' } }]);
});

test('anthropic(-oauth): signature-only block (display omitted) → empty thinking kept with signature', async () => {
    const events = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sigABC' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(events),
        null, () => {}, () => {}, () => {}, {}, null,
    );
    assert.deepEqual(result.thinkingBlocks, [
        { type: 'thinking', thinking: '', signature: 'sigABC' },
    ]);
});

test('anthropic(-oauth): redacted_thinking round-trips exactly as {type,data} (no extra fields)', async () => {
    const events = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED_PAYLOAD' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(events),
        null, () => {}, () => {}, () => {}, {}, null,
    );
    assert.deepEqual(result.thinkingBlocks, [
        { type: 'redacted_thinking', data: 'ENCRYPTED_PAYLOAD' },
    ]);
});

test('anthropic API-key and OAuth lower plain signed thinkingBlocks before text without tool calls', () => {
    const thinkingBlocks = [
        { type: 'thinking', thinking: 'resume state', signature: 'sig-recovery-1' },
        { type: 'redacted_thinking', data: 'ENCRYPTED_RECOVERY_STATE' },
    ];
    const history = [
        { role: 'user', content: 'write the answer' },
        { role: 'assistant', content: 'partial answer', thinkingBlocks },
        { role: 'user', content: 'resume directly' },
    ];
    const expectedAssistantContent = [
        ...thinkingBlocks,
        { type: 'text', text: 'partial answer' },
    ];

    const apiKeyMessages = _toAnthropicMessagesForTest(history);
    const oauthMessages = _buildRequestBodyForCacheSmoke(
        history,
        'claude-sonnet-4-6',
        [],
        {},
    ).messages;

    for (const lowered of [apiKeyMessages, oauthMessages]) {
        const assistant = lowered.find((message) => message.role === 'assistant');
        assert.ok(assistant, 'plain recovery assistant turn must survive lowering');
        assert.deepEqual(assistant.content, expectedAssistantContent);
        assert.equal(assistant.content.some((block) => block.type === 'tool_use'), false);
    }
});

test('anthropic effort: legacy claude-3-7-sonnet gets NO adaptive thinking / effort beta', () => {
    const model = 'claude-3-7-sonnet-20250219';
    assert.equal(modelSupportsEffort(model), false);
    const body = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'hi' }],
        model,
        [],
        { effort: 'high' },
    );
    assert.equal(body.output_config, undefined);
    // Legacy path uses the budget_tokens shape, never thinking:adaptive.
    assert.notEqual(body.thinking?.type, 'adaptive');
    assert.equal(shouldIncludeEffortBeta(model, { effort: 'high' }), false);
});

// --- Leaked tool-call recovery (shared parseSSEStream guard) ----------------
// The model sometimes emits a tool call as plain text tags inside text_delta
// instead of a native tool_use block. The guard (8th arg = known tool names)
// suppresses the tags from the visible stream, removes them from content, and
// synthesizes/dispatches a real tool call. anthropic.mjs reuses this SAME
// parseSSEStream, so both providers are covered by one guard.
const LEAK_TOOLS = new Set(['shell', 'read']);

function textDeltaEvents(chunks, stopReason = 'end_turn') {
    return [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        ...chunks.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
}

test('anthropic(-oauth) leak guard: leaked <function_calls>/<invoke> for known tool → recovered, no leak', async () => {
    const leaked = 'Sure.\n<function_calls>\n<invoke name="shell">\n<parameter name="command">ls -la</parameter>\n</invoke>\n</function_calls>';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([leaked])),
        null, () => {}, () => {},
        (call) => captured.push(call),
        {},
        (t) => texts.push(t),
        LEAK_TOOLS,
    );
    const emitted = texts.join('');
    // Tags never reached the visible stream nor the returned content.
    assert.equal(/<invoke|<function_calls|<parameter/.test(emitted), false);
    assert.equal(/<invoke|<function_calls|<parameter/.test(result.content), false);
    assert.ok(emitted.includes('Sure.'));
    assert.ok(result.content.includes('Sure.'));
    // A real, dispatched tool call was synthesized.
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'shell');
    assert.deepEqual(result.toolCalls[0].arguments, { command: 'ls -la' });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'shell');
    assert.deepEqual(captured[0].arguments, { command: 'ls -la' });
});

test('anthropic(-oauth) leak guard: tags split across two text_delta chunks still detected', async () => {
    const a = '<invoke name="sh';
    const b = 'ell">\n<parameter name="command">pwd</parameter>\n</invoke>';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([a, b])),
        null, () => {}, () => {},
        (call) => captured.push(call),
        {},
        (t) => texts.push(t),
        LEAK_TOOLS,
    );
    assert.equal(/<invoke|<parameter/.test(texts.join('')), false);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'shell');
    assert.deepEqual(result.toolCalls[0].arguments, { command: 'pwd' });
    assert.deepEqual(captured[0].arguments, { command: 'pwd' });
});

test('anthropic(-oauth) leak guard: unknown tool name → text flushed, no synthetic call', async () => {
    const leaked = '<function_calls>\n<invoke name="nonexistent_tool">\n<parameter name="x">1</parameter>\n</invoke>\n</function_calls>';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([leaked])),
        null, () => {}, () => {},
        (call) => captured.push(call),
        {},
        (t) => texts.push(t),
        LEAK_TOOLS,
    );
    // Not a known tool: nothing recovered, and the text is preserved (never lost).
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('nonexistent_tool'));
    assert.ok(result.content.includes('nonexistent_tool'));
});

test('anthropic(-oauth) leak guard: benign prose <function> mention preserved, not swallowed', async () => {
    const prose = 'Use the <function> keyword in JavaScript to declare a function.';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([prose])),
        null, () => {}, () => {},
        (call) => captured.push(call),
        {},
        (t) => texts.push(t),
        LEAK_TOOLS,
    );
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.equal(texts.join(''), prose);
    assert.equal(result.content, prose);
});

// === 4. openai-oauth / openai-oauth-ws =====================================
// openai-oauth (HTTP/SSE) and openai-oauth-ws (WebSocket) both consume the
// Responses event stream inside large stateful stream loops, NOT a standalone
// parser. The HTTP path's handleEvent is a private closure inside
// sendViaHttpSse (openai-oauth.mjs:1038) and cannot be exported without
// extracting it (forbidden: no logic change). The WS path's _streamResponse
// (openai-oauth-ws.mjs:1190) IS exported but requires a live `entry.socket`
// EventEmitter and resolves only on response.completed — driving it needs a
// full fake-socket test rig, well beyond "inject synthetic input to a parser".
//
// Their canonical Responses function_call shape (call_id/name/arguments) and
// custom_tool_call handling are the SAME wire contract already asserted via
// openai-compat's parseResponsesToolCalls above, and the shared
// customToolCallFromResponseItem helper (custom-tool-wire.mjs) is imported by
// all three. We add a focused unit test for that shared custom-tool helper so
// the OAuth custom_tool_call extraction path has explicit coverage; the
// function_call path is covered by the openai-compat Responses test.

import { customToolCallFromResponseItem } from '../src/runtime/agent/orchestrator/providers/custom-tool-wire.mjs';
import { parseToolSearchArgs } from '../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import { _warmupContinuityTraceForTest } from '../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';

test('openai-oauth-ws (warmup continuity): warmup id anchors first real; first-3 misses counted', () => {
    const t = _warmupContinuityTraceForTest({
        warmupUsed: true, warmupResponseId: 'resp_w', priorEntryResponseId: 'resp_w',
        sentPrevResponseId: null, earlyCacheMisses: [false, 'warm_session_zero_cached_tokens', false, true],
    });
    assert.equal(t.warmup_chain_continuous, true);
    assert.equal(t.warmup_first_real_prev_id, 'resp_w');
    assert.deepEqual(t.early_cache_misses, [false, 'warm_session_zero_cached_tokens', false]);
    assert.equal(t.early_cache_miss_count, 1);
    assert.equal(_warmupContinuityTraceForTest({ warmupUsed: true, warmupResponseId: 'a', priorEntryResponseId: 'b' }).warmup_chain_continuous, false);
});

test('openai-oauth (shared custom-tool-wire): custom_tool_call item → canonical call', () => {
    const item = { type: 'custom_tool_call', call_id: 'ctc_1', name: 'apply_patch', input: '*** patch ***' };
    const call = customToolCallFromResponseItem(item);
    assert.equal(call.id, 'ctc_1');
    assert.equal(call.name, 'apply_patch');
    assert.deepEqual(call.arguments, { patch: '*** patch ***' });
    assert.equal(call.nativeType, 'custom_tool_call');
});

test('openai-oauth (shared custom-tool-wire): non custom_tool_call → null', () => {
    assert.equal(customToolCallFromResponseItem({ type: 'function_call' }), null);
    assert.equal(customToolCallFromResponseItem(null), null);
});

// WS tool_search_call.arguments parse policy (parseToolSearchArgs, module-scope
// export of openai-oauth-ws.mjs). Native convergence: malformed non-empty JSON
// becomes an invalid-args marker so the dispatch loop blocks execution and
// returns an is_error tool_result — NOT a silent {} that would dispatch
// tool_search with empty arguments. Empty/whitespace/object inputs keep their
// prior, correct behavior.
test('openai-oauth-ws (tool_search): malformed args string → invalid-args marker (not {})', () => {
    const out = parseToolSearchArgs('{"query": dispatchAiWrapped}');
    assert.equal(isInvalidToolArgsMarker(out), true);
    assert.equal(out.__invalidToolArgs, true);
    assert.equal(out.__rawArguments, '{"query": dispatchAiWrapped}');
    assert.equal(typeof out.__parseError, 'string');
    assert.ok(out.__parseError.length > 0);
});

test('openai-oauth-ws (tool_search): valid args / object / empty preserved', () => {
    // valid JSON string → parsed object
    assert.deepEqual(parseToolSearchArgs('{"query":"x"}'), { query: 'x' });
    // already an object → passthrough
    const obj = { query: 'y' };
    assert.equal(parseToolSearchArgs(obj), obj);
    // empty / whitespace / null / non-string → {} (no args, not a marker)
    assert.deepEqual(parseToolSearchArgs(''), {});
    assert.deepEqual(parseToolSearchArgs('   '), {});
    assert.deepEqual(parseToolSearchArgs(null), {});
    assert.deepEqual(parseToolSearchArgs(undefined), {});
    assert.equal(isInvalidToolArgsMarker(parseToolSearchArgs('')), false);
});

// === 5. grok-oauth =========================================================
// grok-oauth has NO independent tool_call parser. GrokOAuthProvider delegates
// all request shaping AND response parsing to an inner OpenAICompatProvider
// constructed as `new OpenAICompatProvider('xai', ...)` (grok-oauth.mjs:668).
// Its tool_call extraction therefore goes through the exact
// parseToolCalls / parseResponsesToolCalls already asserted in block 1 — no
// duplicate test. (Documented as shared in the report.)

// === 6. OpenAI leaked tool-call recovery ===================================
// The model sometimes emits a tool call as PLAIN TEXT (XML `<invoke>` family
// or gpt-oss harmony `<|channel|>...to=functions.NAME...<|call|>`) inside a
// text delta instead of a native structured tool_call. The stream guards
// suppress the tags from the visible stream, synthesize a native-shaped call
// (`call_leaked_*` id), and dispatch it via the same onToolCall path.
const OAI_LEAK_TOOLS = new Set(['shell', 'read']);

function chatCompletionStream(contentChunks) {
    // Each chunk is an assistant text delta; ends with a stop finish_reason.
    const events = contentChunks.map((text) => ({
        choices: [{ delta: { content: text } }],
    }));
    events.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 1 } });
    return compatResponsesEventStream(events);
}

function responsesTextStream(textChunks) {
    const events = textChunks.map((delta) => ({ type: 'response.output_text.delta', delta }));
    events.push({ type: 'response.completed', response: { id: 'r1', model: 'gpt', status: 'completed', output: [] } });
    return compatResponsesEventStream(events);
}

test('openai-compat (chat) leak guard: leaked <invoke> for known tool → recovered, no leak', async () => {
    const leaked = 'Sure.\n<function_calls>\n<invoke name="shell">\n<parameter name="command">ls -la</parameter>\n</invoke>\n</function_calls>';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream([leaked]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    const emitted = texts.join('');
    assert.equal(/<invoke|<function_calls|<parameter/.test(emitted), false);
    assert.equal(/<invoke|<function_calls|<parameter/.test(out.content), false);
    assert.ok(emitted.includes('Sure.'));
    assert.ok(out.content.includes('Sure.'));
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'shell');
    assert.deepEqual(out.toolCalls[0].arguments, { command: 'ls -la' });
    assert.match(out.toolCalls[0].id, /^call_leaked_/);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'shell');
    assert.deepEqual(captured[0].arguments, { command: 'ls -la' });
});

test('openai-compat (chat) leak guard: leaked harmony <|channel|>...<|call|> for known tool → recovered', async () => {
    const leaked = '<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"path":"a.txt"}<|call|>';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream(['ok ', leaked]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(/<\|channel\|>|to=functions|<\|call\|>/.test(texts.join('')), false);
    assert.equal(/<\|channel\|>|<\|call\|>/.test(out.content), false);
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'read');
    assert.deepEqual(out.toolCalls[0].arguments, { path: 'a.txt' });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'read');
});

test('openai-compat (chat) leak guard: XML tags split across two content deltas still detected', async () => {
    const a = '<invoke name="sh';
    const b = 'ell">\n<parameter name="command">pwd</parameter>\n</invoke>';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream([a, b]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(/<invoke|<parameter/.test(texts.join('')), false);
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'shell');
    assert.deepEqual(out.toolCalls[0].arguments, { command: 'pwd' });
    assert.deepEqual(captured[0].arguments, { command: 'pwd' });
});

test('openai-compat (chat) leak guard: unknown tool → text preserved, no synthetic call', async () => {
    const leaked = '<function_calls>\n<invoke name="nonexistent_tool">\n<parameter name="x">1</parameter>\n</invoke>\n</function_calls>';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream([leaked]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(out.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('nonexistent_tool'));
    assert.ok(out.content.includes('nonexistent_tool'));
});

test('openai-compat (chat) leak guard: benign prose preserved, native tool_calls path intact', async () => {
    const prose = 'Use the <function> keyword in JavaScript.';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream([prose]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(out.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.equal(texts.join(''), prose);
    assert.equal(out.content, prose);
});

test('openai-compat (chat) leak guard: native structured tool_calls still work with guard enabled', async () => {
    const captured = [];
    const events = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 1 } },
    ];
    const out = await consumeCompatChatCompletionStream(compatResponsesEventStream(events), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: () => {},
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.deepEqual(out.toolCalls, [{ id: 'call_1', name: 'read', arguments: { path: 'x' } }]);
    assert.deepEqual(captured, [{ id: 'call_1', name: 'read', arguments: { path: 'x' } }]);
});

test('openai-compat (responses) leak guard: leaked <invoke> in output_text.delta → recovered', async () => {
    const leaked = 'Working.\n<invoke name="shell">\n<parameter name="command">whoami</parameter>\n</invoke>';
    const texts = [];
    const captured = [];
    const out = await consumeCompatResponsesStream(responsesTextStream([leaked]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(/<invoke|<parameter/.test(texts.join('')), false);
    assert.equal(/<invoke|<parameter/.test(out.content), false);
    assert.ok(out.content.includes('Working.'));
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'shell');
    assert.deepEqual(out.toolCalls[0].arguments, { command: 'whoami' });
    assert.match(out.toolCalls[0].id, /^call_leaked_/);
    assert.equal(captured.length, 1);
});

test('openai-compat (responses) leak guard: harmony syntax split across two deltas → recovered', async () => {
    const a = '<|channel|>commentary to=functions.read <|message|>{"path":';
    const b = '"b.txt"}<|call|>';
    const captured = [];
    const out = await consumeCompatResponsesStream(responsesTextStream([a, b]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onToolCall: (call) => captured.push(call),
        onTextDelta: () => {},
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'read');
    assert.deepEqual(out.toolCalls[0].arguments, { path: 'b.txt' });
    assert.equal(captured.length, 1);
});

test('openai-compat (responses) leak guard: benign prose preserved, no synthetic call', async () => {
    const prose = 'Just some prose about functions and channels.';
    const captured = [];
    const out = await consumeCompatResponsesStream(responsesTextStream([prose]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onToolCall: (call) => captured.push(call),
        onTextDelta: () => {},
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(out.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(out.content.includes('Just some prose'));
});

// === 7. Reviewer fixes: fence gating, cross-path dedupe, bare-antml ========

// --- Fix 1: code-fence / inline-code gating (Anthropic path) ---------------
// A complete <invoke> written inside a ```code fence``` or inline `code` span
// is a documentation example, not a real call: it must stream as visible text
// and NOT dispatch. The control (same tag OUTSIDE a fence) still recovers.
test('anthropic leak guard (fence): <invoke> inside a fenced code block → emitted as text, NOT dispatched', async () => {
    const fenced = 'Example:\n```\n<invoke name="read"><parameter name="path">a</parameter></invoke>\n```\ndone';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([fenced])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('<invoke name="read">'));
    assert.ok(result.content.includes('<invoke name="read">'));
});

test('anthropic leak guard (fence): fence OPENS in one delta and CLOSES in a later one, tag between → NOT dispatched', async () => {
    const chunks = ['Here is an example:\n```json\n', '<invoke name="read"><parameter name="path">a</parameter></invoke>\n', '```\nEnd.'];
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents(chunks)),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('<invoke name="read">'));
});

test('anthropic leak guard (fence): <invoke> inside an inline `code` span → NOT dispatched', async () => {
    const inline = 'Call it like `<invoke name="read"><parameter name="path">a</parameter></invoke>` in the docs.';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([inline])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('<invoke name="read">'));
});

test('anthropic leak guard (fence CONTROL): same <invoke> OUTSIDE any fence → still recovered/dispatched', async () => {
    const outside = 'Sure.\n<invoke name="read"><parameter name="path">a</parameter></invoke>';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([outside])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    assert.equal(/<invoke|<parameter/.test(texts.join('')), false);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'read');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'a' });
    assert.equal(captured.length, 1);
});

// --- Fix 1: harmony example inside a fence (OpenAI chat path) → NOT dispatched
test('openai-compat (chat) leak guard (fence): harmony example inside a ```fence``` → emitted as text, NOT dispatched', async () => {
    const fenced = 'Doc:\n```\n<|channel|>commentary to=functions.read <|message|>{"path":"a"}<|call|>\n```\n';
    const texts = [];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(chatCompletionStream([fenced]), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: (t) => texts.push(t),
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(out.toolCalls, undefined);
    assert.equal(captured.length, 0);
    assert.ok(texts.join('').includes('to=functions.read'));
});

// --- Fix 2: duplicate dispatch (text-leaked + identical native) → ONE fire --
test('anthropic leak guard (dedupe): text-leaked call + identical native tool_use → onToolCall fires ONCE', async () => {
    const leaked = '<invoke name="shell"><parameter name="command">ls</parameter></invoke>';
    const events = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: leaked } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(events),
        null, () => {}, () => {}, (c) => captured.push(c), {}, () => {}, LEAK_TOOLS,
    );
    // Exactly one dispatch for the identical (name,args) fingerprint.
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'shell');
    assert.deepEqual(captured[0].arguments, { command: 'ls' });
    // ...and the RETURNED array carries exactly one — else the loop would
    // execute the side-effecting tool twice (Fix 2 array side).
    assert.equal(result.toolCalls.length, 1);
});

test('openai-compat (chat) leak guard (dedupe): text-leaked call + identical native tool_calls → onToolCall fires ONCE', async () => {
    const leaked = '<invoke name="read"><parameter name="path">a</parameter></invoke>';
    const events = [
        { choices: [{ delta: { content: leaked } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 1 } },
    ];
    const captured = [];
    const out = await consumeCompatChatCompletionStream(compatResponsesEventStream(events), {
        label: 'test',
        parseToolCalls: compatParseToolCalls,
        onToolCall: (call) => captured.push(call),
        onTextDelta: () => {},
        knownToolNames: OAI_LEAK_TOOLS,
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'read');
    assert.deepEqual(captured[0].arguments, { path: 'a' });
    // The RETURNED array is deduped too (Fix 2 array side): the agent loop
    // executes returned toolCalls, so a synthetic+native duplicate here would
    // run the side-effecting tool twice. Exactly one must survive.
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'read');
});

// --- Fix 3: bare `antml:invoke` in prose (no `<`) → streamed, not held ------
test('anthropic leak guard (bare-antml): literal "antml:invoke" in prose → streamed promptly, no dispatch', async () => {
    const prose = 'The tag antml:invoke is used internally; here we just mention it in a sentence.';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([prose])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    assert.equal(result.toolCalls, undefined);
    assert.equal(captured.length, 0);
    // Streamed promptly (not held to final) and content intact.
    assert.equal(texts.join(''), prose);
    assert.equal(result.content, prose);
});

test('anthropic leak guard (bare-antml CONTROL): <invoke> bracket form still recovers', async () => {
    const leaked = 'ok\n<invoke name="read"><parameter name="path">z</parameter></invoke>';
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([leaked])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, () => {}, LEAK_TOOLS,
    );
    assert.equal(result.toolCalls.length, 1);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'read');
    assert.deepEqual(captured[0].arguments, { path: 'z' });
});

// --- Reviewer Medium: suppressed call args must NOT poison fence state -------
// A recovered/suppressed leaked call whose args contain an unmatched backtick
// must not leave the markdown fence "open" and wrongly suppress a LATER real
// leaked call as if it were inside a code span.
test('anthropic leak guard (fence): unmatched backtick inside a suppressed call\'s args does not swallow a later real call', async () => {
    // First leaked call carries a lone backtick in its arg value; second is a
    // clean leaked call that MUST still be recovered.
    const first = '<invoke name="read"><parameter name="path">a`b</parameter></invoke>';
    const between = ' some visible prose ';
    const second = '<invoke name="shell"><parameter name="command">ls</parameter></invoke>';
    const texts = [];
    const captured = [];
    const result = await anthropicParseSSEStream(
        anthropicSseResponse(textDeltaEvents([first + between + second])),
        null, () => {}, () => {}, (c) => captured.push(c), {}, (t) => texts.push(t), LEAK_TOOLS,
    );
    // BOTH leaked calls recovered — the stray backtick in call #1's args did
    // not open a fence that suppressed call #2.
    assert.equal(captured.length, 2);
    assert.equal(result.toolCalls.length, 2);
    assert.deepEqual(captured.map((c) => c.name), ['read', 'shell']);
    // The in-between prose streamed; the tag/arg text did not leak.
    assert.equal(texts.join('').includes('some visible prose'), true);
    assert.equal(texts.join('').includes('<invoke'), false);
    assert.equal(texts.join('').includes('`'), false);
});

// === 8. Anthropic effort (output_config vs legacy thinking budget) ==========

test('anthropic effort: sonnet-4-6 uses output_config + effort beta, not thinking', () => {
    const model = 'claude-sonnet-4-6';
    const body = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'hi' }],
        model,
        [],
        { effort: 'high' },
    );
    assert.deepEqual(body.output_config, { effort: 'high' });
    // Adaptive-thinking models also carry thinking:{type:'adaptive'} — the
    // legacy budget_tokens shape 400s on these models.
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal(shouldIncludeEffortBeta(model, { effort: 'high' }), true);
    const beta = buildAnthropicBetaHeaders({ effort: true });
    assert.ok(beta.includes(EFFORT_BETA_HEADER));
});

test('anthropic-oauth: foreign native references normalize to ordinary tool_result after provider switches', () => {
    const body = _buildRequestBodyForCacheSmoke(
        [
            { role: 'user', content: 'load a tool' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'toolu_load_1', name: 'load_tool', arguments: { names: ['read'] } }],
            },
            {
                role: 'tool',
                toolCallId: 'toolu_load_1',
                content: '{"loaded":["read"]}',
                nativeToolSearch: { provider: 'openai-oauth', toolReferences: ['read'] },
            },
        ],
        'claude-opus-4-8',
        [],
        { effort: 'high' },
    );
    const serialized = JSON.stringify(body.messages);
    assert.equal(serialized.includes('tool_reference'), false);
    const toolResult = body.messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block?.type === 'tool_result' && block.tool_use_id === 'toolu_load_1');
    assert.ok(toolResult);
    assert.equal(toolResult.content, '{"loaded":["read"]}');
});

test('anthropic effort: legacy sonnet-4-5 maps effort to thinking budget', () => {
    const model = 'claude-sonnet-4-5-20250514';
    const body = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'hi' }],
        model,
        [],
        { effort: 'medium' },
    );
    assert.equal(body.output_config, undefined);
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: LEGACY_EFFORT_BUDGET.medium });
    assert.equal(modelSupportsEffort(model), false);
});

test('anthropic effort: xhigh on opus-4-8 is a first-class level (not downgraded to max)', () => {
    // Opus 4.8 supports xhigh (modelSupportsXhighEffort), so xhigh is kept
    // verbatim as a first-class effort level — matching codex's ReasoningEffort
    // enum which lists xhigh between high and max. Only models WITHOUT xhigh
    // support clamp it down to high.
    const model = 'claude-opus-4-8';
    assert.equal(modelSupportsMaxEffort(model), true);
    assert.equal(normalizeAnthropicEffortInput('xhigh', model), 'xhigh');
    const body = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'hi' }],
        model,
        [],
        { effort: 'xhigh' },
    );
    assert.deepEqual(body.output_config, { effort: 'xhigh' });
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
});

test('anthropic effort: explicit thinkingBudgetTokens wins over effort', () => {
    const model = 'claude-sonnet-4-6';
    const body = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'hi' }],
        model,
        [],
        { effort: 'low', thinkingBudgetTokens: 2048 },
    );
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2048 });
    assert.equal(body.output_config, undefined);
    assert.equal(shouldIncludeEffortBeta(model, { effort: 'low', thinkingBudgetTokens: 2048 }), false);
});
// === 9. OpenAI OAuth WS cache tracing ======================================

test('openai oauth ws delta: default delta safely falls back on request-property mismatch', () => {
    const body = { model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: 'hi' }] };
    const delta = _computeDelta({
        entry: {
            lastRequestSansInput: '{}',
            lastResponseId: 'resp_prev',
            lastRequestInput: body.input,
            lastResponseItems: [],
        },
        body,
    });
    assert.equal(delta.mode, 'full');
    assert.equal(delta.reason, 'request_properties_changed');
    assert.equal(delta.frame.previous_response_id, undefined);
});

test('openai oauth ws delta: ws-delta mode uses previous_response_id without turn-state, keeps safe fallback', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const body = {
            model: 'gpt-5.5',
            input: [
                { type: 'message', role: 'user', content: 'prev' },
                { type: 'message', role: 'user', content: 'next' },
            ],
        };
        const entry = {
            lastRequestSansInput: '{"model":"gpt-5.5"}',
            lastResponseId: 'resp_prev',
            lastRequestInput: [body.input[0]],
            lastResponseItems: [],
            // NOTE: no turnState — ws-delta (refs) mode must still emit a delta.
        };

        const refs = _computeDelta({ entry, body });
        assert.equal(refs.mode, 'delta');
        assert.equal(refs.frame.previous_response_id, 'resp_prev');
        assert.deepEqual(refs.frame.input, [body.input[1]]);

        // Safe fallback preserved: a changed request property breaks the prefix
        // and retreats to a full frame even in ws-delta mode.
        const changed = _computeDelta({ entry, body: { ...body, model: 'gpt-5.6' } });
        assert.equal(changed.mode, 'full');
        assert.equal(changed.reason, 'request_properties_changed');
        assert.equal(changed.frame.previous_response_id, undefined);

        const noAnchor = _computeDelta({ entry: { ...entry, lastResponseId: null }, body });
        assert.equal(noAnchor.mode, 'full');
        assert.equal(noAnchor.reason, 'no_anchor');
        assert.equal(noAnchor.frame.previous_response_id, undefined);

        const prefixMismatch = _computeDelta({
            entry: { ...entry, lastRequestInput: [{ type: 'message', role: 'user', content: 'other' }] },
            body,
        });
        assert.equal(prefixMismatch.mode, 'full');
        assert.equal(prefixMismatch.reason, 'input_prefix_mismatch');
        assert.equal(prefixMismatch.frame.previous_response_id, undefined);

        const responseMismatch = _computeDelta({
            entry: {
                ...entry,
                lastRequestInput: [body.input[0]],
                lastResponseItems: [{
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'tool',
                    arguments: '{"api_key":"provider-function-secret","nested":{"z":2,"a":1}}',
                }],
            },
            body: {
                ...body,
                input: [
                    body.input[0],
                    {
                        type: 'function_call',
                        call_id: 'call_other',
                        name: 'tool',
                        arguments: '{"nested":{"a":1,"z":2},"api_key":"replayed-function-secret"}',
                    },
                    body.input[1],
                ],
            },
        });
        assert.equal(responseMismatch.mode, 'full');
        assert.equal(responseMismatch.reason, 'response_output_mismatch:function_call');
        assert.equal(responseMismatch.frame.previous_response_id, undefined);
        const mismatch = responseMismatch.responseOutputMismatch;
        assert.deepEqual({
            expectedType: mismatch.response_output_mismatch_expected_type,
            actualType: mismatch.response_output_mismatch_actual_type,
            expectedCount: mismatch.response_output_mismatch_expected_response_item_count,
            actualCount: mismatch.response_output_mismatch_actual_replayed_input_item_count,
        }, {
            expectedType: 'function_call',
            actualType: 'function_call',
            expectedCount: 1,
            actualCount: 2,
        });
        assert.match(mismatch.response_output_mismatch_expected_hash, /^[a-f0-9]{64}$/);
        assert.match(mismatch.response_output_mismatch_actual_hash, /^[a-f0-9]{64}$/);
        const traceSafe = JSON.stringify(mismatch);
        assert.equal(traceSafe.includes('call_other'), false);
        assert.equal(traceSafe.includes('provider-function-secret'), false);
        assert.equal(traceSafe.includes('replayed-function-secret'), false);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('openai oauth ws delta: message mismatch diagnostics hash normalized content without tracing it', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const prior = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] };
        const expected = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'provider secret' }] };
        const actual = { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'replayed secret' }] };
        const delta = _computeDelta({
            entry: {
                lastRequestSansInput: '{"model":"gpt-5.5"}',
                lastResponseId: 'resp_prev',
                lastRequestInput: [prior],
                lastResponseItems: [expected],
            },
            body: { model: 'gpt-5.5', input: [prior, actual] },
        });
        const mismatch = delta.responseOutputMismatch;
        assert.equal(delta.reason, 'response_output_mismatch:message');
        assert.equal(mismatch.response_output_mismatch_expected_type, 'message');
        assert.equal(mismatch.response_output_mismatch_actual_type, 'message');
        assert.notEqual(mismatch.response_output_mismatch_expected_hash, mismatch.response_output_mismatch_actual_hash);
        const traceSafe = JSON.stringify(mismatch);
        assert.equal(traceSafe.includes('provider secret'), false);
        assert.equal(traceSafe.includes('replayed secret'), false);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('openai oauth ws delta: diagnostic hashes normalize equivalent message and function-call forms', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const prior = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] };
        const mismatch = (expected, actual) => _computeDelta({
            entry: {
                lastRequestSansInput: '{"model":"gpt-5.5"}',
                lastResponseId: 'resp_prev',
                lastRequestInput: [prior],
                lastResponseItems: [expected],
            },
            body: { model: 'gpt-5.5', input: [prior, actual] },
        }).responseOutputMismatch;
        const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'same sensitive message' }] };
        const messageExpected = mismatch(message, {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'different message' }],
        });
        const messageActual = mismatch({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'different message' }],
        }, {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'input_text', text: 'same sensitive message' }],
        });
        assert.equal(
            messageExpected.response_output_mismatch_expected_hash,
            messageActual.response_output_mismatch_actual_hash,
        );

        const functionExpected = (argumentsValue) => mismatch({
            type: 'function_call',
            call_id: 'call_same',
            name: 'tool',
            arguments: argumentsValue,
        }, {
            type: 'function_call',
            call_id: 'call_different',
            name: 'tool',
            arguments: '{"ignored":"replayed-function-secret"}',
        });
        assert.equal(
            functionExpected('{"api_key":"function-secret","nested":{"z":2,"a":1}}').response_output_mismatch_expected_hash,
            functionExpected('{"nested":{"a":1,"z":2},"api_key":"function-secret"}').response_output_mismatch_expected_hash,
        );
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('openai oauth ws delta: mismatch diagnostics reach transport and cache_break without sensitive values', async () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const rows = [];
        const prior = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] };
        const cases = [{
            expected: {
                type: 'function_call',
                call_id: 'call_expected',
                name: 'tool',
                arguments: '{"api_key":"provider-function-secret","nested":{"z":2,"a":1}}',
            },
            actual: {
                type: 'function_call',
                call_id: 'call_actual',
                name: 'tool',
                arguments: '{"nested":{"a":1,"z":2},"api_key":"replayed-function-secret"}',
            },
        }, {
            expected: {
                type: 'custom_tool_call',
                call_id: 'custom_expected',
                name: 'apply_patch',
                input: 'provider-custom-input-secret',
            },
            actual: {
                type: 'custom_tool_call',
                call_id: 'custom_actual',
                name: 'apply_patch',
                input: 'replayed-custom-input-secret',
            },
        }];
        for (const { expected, actual } of cases) {
            const body = { model: 'gpt-5.5', input: [prior, actual] };
            const entry = {
                socket: { close() {} },
                lastRequestSansInput: _stableStringify(_sansInput(body)),
                lastResponseId: 'resp_prev',
                lastRequestInput: [prior],
                lastResponseItems: [expected],
            };
            const expectedDiagnostics = _computeDelta({ entry, body }).responseOutputMismatch;
            await sendViaWebSocket({
                auth: { type: 'xai', access_token: 'test-token' },
                body,
                poolKey: `mismatch-trace-${expected.type}`,
                cacheKey: 'mismatch-trace-test',
                iteration: 1,
                useModel: 'gpt-5.5',
                traceProvider: 'xai',
                _acquireWithRetryFn: async () => ({ entry, reused: false }),
                _sendFrameFn: async () => {},
                _streamFn: async () => ({
                    content: 'ok',
                    model: 'gpt-5.5',
                    toolCalls: [],
                    usage: {},
                    responseId: 'resp_next',
                    responseItems: [],
                    closeSocket: true,
                }),
                _agentTraceFn: (row) => rows.push(row),
            });
            const emitted = rows.filter((row) => row.payload?.response_output_mismatch_expected_type === expected.type);
            assert.deepEqual(emitted.map((row) => row.kind).sort(), ['cache_break', 'transport']);
            for (const row of emitted) assert.deepEqual(
                Object.fromEntries(Object.keys(expectedDiagnostics).map((key) => [key, row.payload[key]])),
                expectedDiagnostics,
            );
        }
        const traceText = JSON.stringify(rows);
        for (const secret of [
            'provider-function-secret',
            'replayed-function-secret',
            'provider-custom-input-secret',
            'replayed-custom-input-secret',
        ]) assert.equal(traceText.includes(secret), false);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('openai oauth ws delta: warmup generate:false does not force request_properties_changed', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const warmupBody = { model: 'gpt-5.5', generate: false, input: [{ type: 'message', role: 'user', content: 'prev' }] };
        const body = { model: 'gpt-5.5', input: [warmupBody.input[0], { type: 'message', role: 'user', content: 'next' }] };
        const entry = {
            lastRequestSansInput: _stableStringify(_sansInput(warmupBody)),
            lastResponseId: 'resp_warm',
            lastRequestInput: [warmupBody.input[0]],
            lastResponseItems: [],
        };
        assert.equal(_sansInput(warmupBody).generate, undefined);      // warmup marker normalized out
        const delta = _computeDelta({ entry, body });
        assert.equal(delta.mode, 'delta');
        assert.deepEqual(delta.frame.input, [body.input[1]]);
        // Non-warmup generate difference still breaks the delta.
        const genEntry = { ...entry, lastRequestSansInput: _stableStringify(_sansInput({ ...warmupBody, generate: true })) };
        const genChanged = _computeDelta({ entry: genEntry, body });
        assert.equal(genChanged.mode, 'full');
        assert.equal(genChanged.reason, 'request_properties_changed');
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('openai oauth ws delta: native tool_search output replays with canonical fields', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const baseTools = [{
            type: 'tool_search',
            execution: 'client',
            description: 'load tools',
            parameters: { type: 'object', properties: {} },
        }];
        const output = {
            type: 'tool_search_output',
            call_id: 'call_load_1',
            status: 'completed',
            execution: 'client',
            tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }],
        };
        const body = {
            model: 'gpt-5.5',
            instructions: 'sys',
            tools: baseTools,
            prompt_cache_key: 'cache-key',
            input: [
                { type: 'message', role: 'user', content: 'load read' },
                { type: 'tool_search_call', call_id: 'call_load_1', execution: 'client', arguments: { names: ['read'] } },
                output,
                { type: 'message', role: 'user', content: 'use read' },
            ],
        };
        const delta = _computeDelta({
            entry: {
                lastRequestSansInput: _stableStringify(_sansInput(body)),
                lastResponseId: 'resp_prev',
                lastRequestInput: [body.input[0]],
                lastResponseItems: [body.input[1]],
            },
            body,
        });
        assert.equal(delta.mode, 'delta');
        assert.equal(delta.frame.prompt_cache_key, 'cache-key');
        assert.deepEqual(delta.frame.tools, baseTools);
        assert.equal(delta.frame.instructions, 'sys');
        assert.deepEqual(delta.frame.input, [output, body.input[3]]);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('canonical frame: full-frame builder leads with type and preserves codex body key order', () => {
    const body = {
        model: 'gpt-5.5',
        instructions: 'sys',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning: { effort: 'medium' },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: 'k',
        text: { verbosity: 'low' },
    };
    const frame = _buildResponseCreateFrame(body);
    assert.deepEqual(Object.keys(frame), ['type', ...Object.keys(body)]);
    assert.equal(frame.type, 'response.create');
    // A full-frame build is byte-identical to the legacy spread form.
    assert.equal(JSON.stringify(frame), JSON.stringify({ type: 'response.create', ...body }));
    assert.equal(frame.previous_response_id, undefined);
});

test('canonical frame: delta insert keeps key order and chained instructions, overrides input', () => {
    const body = {
        model: 'gpt-5.5',
        instructions: 'sys',
        input: [{ a: 1 }, { b: 2 }],
        tool_choice: 'auto',
        text: { verbosity: 'low' },
    };
    const delta = _buildResponseCreateFrame(body, { previousResponseId: 'resp_prev', inputOverride: [{ b: 2 }] });
    assert.deepEqual(Object.keys(delta), ['type', 'model', 'instructions', 'previous_response_id', 'input', 'tool_choice', 'text']);
    assert.equal(delta.instructions, 'sys');
    assert.equal(delta.previous_response_id, 'resp_prev');
    assert.deepEqual(delta.input, [{ b: 2 }]);
    // Empty instructions is also dropped in delta mode (server resolves via prev id).
    const noInstr = _buildResponseCreateFrame({ ...body, instructions: '' }, { previousResponseId: 'resp_prev', inputOverride: [] });
    assert.deepEqual(Object.keys(noInstr), ['type', 'model', 'previous_response_id', 'input', 'tool_choice', 'text']);
});

test('openai oauth ws cache observation detects warm zero and partial retreats', () => {
    const zero = _cacheObservationForTest({
        entry: { promptCacheMaxCachedTokens: 47_616 },
        result: { usage: { inputTokens: 59_000, promptTokens: 59_000, cachedTokens: 0 } },
    });
    assert.equal(zero.actualMiss, true);
    assert.equal(zero.missReason, 'warm_session_zero_cached_tokens');
    assert.equal(zero.uncachedTokens, 59_000);

    const partial = _cacheObservationForTest({
        entry: { promptCacheMaxCachedTokens: 101_888 },
        result: { usage: { inputTokens: 102_456, promptTokens: 102_456, cachedTokens: 60_928 } },
    });
    assert.equal(partial.actualMiss, true);
    assert.equal(partial.missReason, 'warm_session_cached_tokens_dropped');
    assert.equal(partial.cachedTokens % 512, 0);

    const healthy = _cacheObservationForTest({
        entry: { promptCacheMaxCachedTokens: 101_888 },
        result: { usage: { inputTokens: 106_468, promptTokens: 106_468, cachedTokens: 103_424 } },
    });
    assert.equal(healthy.actualMiss, false);
    assert.equal(healthy.missReason, null);

    const compacted = _cacheObservationForTest({
        entry: { promptCacheMaxCachedTokens: 255_488 },
        result: { usage: { inputTokens: 21_066, promptTokens: 21_066, cachedTokens: 8_704 } },
        continuityResetReason: 'input_prefix_mismatch',
    });
    assert.equal(compacted.actualMiss, false, 'intentional prompt rewrite must reset the old high-water');
    assert.equal(compacted.wasWarm, false);

    const previousInput = [{ type: 'message', role: 'user', content: 'old long transcript' }];
    const rewrittenBody = { model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: 'compact summary' }] };
    assert.equal(_cacheContinuityResetReasonForTest({
        mode: 'full',
        deltaReason: 'full_default',
        entry: {
            lastResponseId: 'resp_old',
            lastRequestSansInput: _stableStringify(_sansInput(rewrittenBody)),
            lastRequestInput: previousInput,
        },
        body: rewrittenBody,
    }), 'input_prefix_mismatch', 'ws-full must detect prompt rewrites hidden by full_default');
});

// === 10. OpenAI transport-policy switch (MIXDOG_OAI_TRANSPORT) ==============
// One clean knob selects among ws-full | ws-delta | http-sse | auto. The
// resolver is a pure function over an injected env, and the delta gate
// (_computeDelta) + transport dispatch both read it, so these unit tests pin
// the resolution and the delta branching without any network.
import {
    resolveOpenAiTransportPolicy,
    _normalizeTransportMode,
} from '../src/runtime/agent/orchestrator/providers/openai-transport-policy.mjs';
import {
    resolveResponsesTransportPolicy,
    RESPONSES_TRANSPORT_CAPABILITIES,
    _gateTransportMode,
    FULL_RESPONSES_TRANSPORT_CAPS,
} from '../src/runtime/agent/orchestrator/providers/openai-transport-policy.mjs';

test('transport policy: default (no env) is auto WS-first / refs continuation ON / HTTP fallback ON', () => {
    const p = resolveOpenAiTransportPolicy({});
    assert.equal(p.mode, 'auto');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, true);
    assert.deepEqual(p.delta, { force: false, refs: true, optIn: true });
});

test('transport policy: default ignores the legacy MIXDOG_OAI_WS_DELTA env', () => {
    // Legacy compatibility removed: delta is selected solely via ws-delta mode.
    assert.deepEqual(resolveOpenAiTransportPolicy({ MIXDOG_OAI_WS_DELTA: '1' }).delta, { force: false, refs: true, optIn: true });
    assert.deepEqual(resolveOpenAiTransportPolicy({ MIXDOG_OAI_WS_DELTA: 'force' }).delta, { force: false, refs: true, optIn: true });
    assert.deepEqual(resolveOpenAiTransportPolicy({ MIXDOG_OAI_WS_DELTA: 'refs' }).delta, { force: false, refs: true, optIn: true });
});

test('transport policy: ws-full forces full frames', () => {
    const p = resolveOpenAiTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'ws-full' });
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, false);
    assert.equal(p.delta.optIn, false);
});

test('transport policy: ws-delta selects refs-compatible delta (no turn-state demand)', () => {
    const p = resolveOpenAiTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'ws-delta' });
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, false);
    assert.deepEqual(p.delta, { force: false, refs: true, optIn: true });
});

test('transport policy: http-sse forces the HTTP transport with delta OFF', () => {
    const p = resolveOpenAiTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'http-sse' });
    assert.equal(p.transport, 'http');
    assert.equal(p.allowHttpFallback, false);
    assert.equal(p.delta.optIn, false);
});

test('transport policy: unknown MIXDOG_OAI_TRANSPORT falls back to default auto', () => {
    const p = resolveOpenAiTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'quantum' });
    assert.equal(p.mode, 'auto');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, true);
});

test('response frame builder can omit transport-only stream/background for codex warmup parity', () => {
    const body = { model: 'gpt-5.5', input: [{ a: 1 }, { b: 2 }], stream: true, background: false, text: { verbosity: 'low' } };
    const full = _buildResponseCreateFrame(body, { omitTransportFields: true });
    assert.equal('stream' in full || 'background' in full, false);
    const d = _buildResponseCreateFrame(body, { previousResponseId: 'resp_prev', inputOverride: [{ b: 2 }], omitTransportFields: true });
    assert.deepEqual([d.previous_response_id, d.input, 'stream' in d], ['resp_prev', [{ b: 2 }], false]);
});

test('transport policy: mode token aliases normalize', () => {
    assert.equal(_normalizeTransportMode('WS_FULL'), 'ws-full');
    assert.equal(_normalizeTransportMode('  ws delta '), 'ws-delta');
    assert.equal(_normalizeTransportMode('http/sse'), 'http-sse');
    assert.equal(_normalizeTransportMode('sse'), 'http-sse');
    assert.equal(_normalizeTransportMode('auto'), 'auto');
    assert.equal(_normalizeTransportMode('official'), null);
    assert.equal(_normalizeTransportMode(''), null);
    assert.equal(_normalizeTransportMode('bogus'), null);
});

test('transport policy: ws-delta drives _computeDelta to emit a delta frame', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const body = {
            model: 'gpt-5.5',
            input: [
                { type: 'message', role: 'user', content: 'prev' },
                { type: 'message', role: 'user', content: 'next' },
            ],
        };
        const entry = {
            lastRequestSansInput: '{"model":"gpt-5.5"}',
            lastResponseId: 'resp_prev',
            lastRequestInput: [body.input[0]],
            lastResponseItems: [],
            // no turnState — refs mode must still delta
        };
        const delta = _computeDelta({ entry, body });
        assert.equal(delta.mode, 'delta');
        assert.equal(delta.frame.previous_response_id, 'resp_prev');
        assert.deepEqual(delta.frame.input, [body.input[1]]);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('transport policy: ws-full forces _computeDelta to full (delta OFF)', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-full';
        const body = { model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: 'hi' }] };
        const delta = _computeDelta({
            entry: {
                lastRequestSansInput: '{"model":"gpt-5.5"}',
                lastResponseId: 'resp_prev',
                lastRequestInput: body.input,
                lastResponseItems: [],
            },
            body,
        });
        assert.equal(delta.mode, 'full');
        assert.equal(delta.reason, 'full_default');
        assert.equal(delta.frame.previous_response_id, undefined);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

// === 10b. Shared Responses transport policy (capability gating) ============
// resolveResponsesTransportPolicy generalizes the OpenAI switch across every
// Responses backend. Full-capability providers (OpenAI OAuth/direct) resolve
// byte-identically to resolveOpenAiTransportPolicy; xAI/Grok also carry WS
// delta capability, so default/ws-delta drive the OFFICIAL xAI continuation
// (previous_response_id + incremental input) rather than collapsing to
// 'ws-full'.

test('responses transport policy: full caps === legacy OpenAI resolver (byte-identical)', () => {
    for (const env of [
        {},
        { MIXDOG_OAI_TRANSPORT: 'ws-delta' },
        { MIXDOG_OAI_TRANSPORT: 'ws-full' },
        { MIXDOG_OAI_TRANSPORT: 'http-sse' },
        { MIXDOG_OAI_TRANSPORT: 'quantum' },
    ]) {
        const legacy = resolveOpenAiTransportPolicy(env);
        const shared = resolveResponsesTransportPolicy(env, RESPONSES_TRANSPORT_CAPABILITIES['openai-oauth']);
        assert.equal(shared.mode, legacy.mode);
        assert.equal(shared.transport, legacy.transport);
        assert.equal(shared.allowHttpFallback, legacy.allowHttpFallback);
        assert.deepEqual(shared.delta, legacy.delta);
    }
});

test('responses transport policy: openai direct caps match oauth (both full)', () => {
    const env = { MIXDOG_OAI_TRANSPORT: 'ws-delta' };
    const direct = resolveResponsesTransportPolicy(env, RESPONSES_TRANSPORT_CAPABILITIES.openai);
    assert.equal(direct.transport, 'ws');
    assert.deepEqual(direct.delta, { force: false, refs: true, optIn: true });
});

test('responses transport policy: xai auto is WS-first with HTTP fallback', () => {
    const p = resolveResponsesTransportPolicy({}, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(p.mode, 'auto');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, true);
    assert.deepEqual(p.delta, { force: false, refs: true, optIn: true });
});

test('responses transport policy: explicit auto is WS-first with HTTP fallback', () => {
    const p = resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'auto' }, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(p.mode, 'auto');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, true);
    assert.deepEqual(p.delta, { force: false, refs: true, optIn: true });
});

test('responses transport policy: xai ws-delta drives official continuation (refs delta ON)', () => {
    const p = resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'ws-delta' }, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(p.requestedMode, 'ws-delta');
    assert.equal(p.mode, 'ws-delta');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, false);
    // Official xAI continuation: previous_response_id + incremental input, no
    // Codex turn-state — refs delta ON.
    assert.deepEqual(p.delta, { force: false, refs: true, optIn: true });
});

test('responses transport policy: xai ws-full → WS, http-sse → HTTP', () => {
    const wsFull = resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'ws-full' }, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(wsFull.transport, 'ws');
    assert.equal(wsFull.allowHttpFallback, false);
    const http = resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'http-sse' }, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(http.transport, 'http');
    assert.equal(http.allowHttpFallback, false);
});

test('openai-compat/xai: HTTP pin uses only the injected preconnect seam', async () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    const prevFetch = globalThis.fetch;
    let outboundFetchAttempts = 0;
    let injectedPreconnectCalls = 0;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        globalThis.fetch = async () => {
            outboundFetchAttempts += 1;
            throw new Error('provider transport test attempted outbound fetch');
        };

        // Resolve the actual imported binding and inspect _doSend before
        // invoking any outbound-capable provider path. AST traversal naturally
        // excludes comments/strings and catches direct, aliased, parenthesized,
        // optional, or assigned references.
        const compatSource = readFileSync(
            new URL('../src/runtime/agent/orchestrator/providers/openai-compat.mjs', import.meta.url),
            'utf8',
        );
        const compatAst = parse(compatSource, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            locations: true,
            ranges: true,
        });
        const preconnectImport = compatAst.body
            .filter(node => node.type === 'ImportDeclaration')
            .flatMap(node => node.specifiers)
            .find(specifier =>
                specifier.type === 'ImportSpecifier'
                && specifier.imported.name === 'preconnect',
            );
        assert.ok(preconnectImport, 'shared preconnect import binding must be resolvable');
        const scopeManager = analyze(compatAst, { ecmaVersion: 2022, sourceType: 'module' });
        const moduleScope = scopeManager.scopes.find(scope => scope.type === 'module');
        const preconnectBinding = moduleScope?.set.get(preconnectImport.local.name);
        assert.ok(preconnectBinding, 'shared preconnect source binding must be resolvable');

        const providerClass = compatAst.body
            .map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
            .find(node =>
                node?.type === 'ClassDeclaration'
                && node.id?.name === 'OpenAICompatProvider',
            );
        assert.ok(providerClass, 'OpenAICompatProvider class must be resolvable');
        const doSendMethod = providerClass.body.body.find(node =>
            node.type === 'MethodDefinition'
            && node.key?.type === 'Identifier'
            && node.key.name === '_doSend',
        );
        assert.ok(doSendMethod, 'OpenAICompatProvider._doSend must be resolvable');

        let callsInjectedInstanceMember = false;
        const visit = node => {
            if (!node || typeof node !== 'object') return;
            if (
                node.type === 'CallExpression'
                && node.callee?.type === 'MemberExpression'
                && node.callee.object?.type === 'ThisExpression'
                && node.callee.computed === false
                && node.callee.property?.name === '_preconnectFn'
            ) {
                callsInjectedInstanceMember = true;
            }
            for (const [key, value] of Object.entries(node)) {
                if (key === 'start' || key === 'end') continue;
                if (Array.isArray(value)) value.forEach(visit);
                else if (value && typeof value === 'object') visit(value);
            }
        };
        visit(doSendMethod.value.body);
        const importedBindingReferences = preconnectBinding.references.filter(reference =>
            reference.identifier.start >= doSendMethod.value.body.start
            && reference.identifier.end <= doSendMethod.value.body.end,
        );
        assert.equal(
            importedBindingReferences.length,
            0,
            '_doSend must not reference the shared preconnect import binding',
        );
        assert.equal(
            callsInjectedInstanceMember,
            true,
            '_doSend must call the instance preconnect seam',
        );

        const provider = new OpenAICompatProvider('xai', {
            apiKey: 'xai-test',
            responsesTransport: 'http',
            preconnect: true,
            preconnectFn: () => {
                injectedPreconnectCalls += 1;
            },
        });
        let httpCalled = false;
        provider._doSendXaiResponses = async () => {
            httpCalled = true;
            return { content: 'ok' };
        };
        provider._doSendXaiResponsesWebSocket = async () => {
            throw new Error('explicit HTTP transport should not use WS');
        };
        const result = await provider._doSend([{ role: 'user', content: 'hi' }], 'grok-build', [], {});
        assert.equal(result.content, 'ok');
        assert.equal(httpCalled, true);
        assert.equal(injectedPreconnectCalls, 1, 'only the injected preconnect seam must run');
        assert.equal(outboundFetchAttempts, 0, 'stubbed provider test must remain network hermetic');
    } finally {
        globalThis.fetch = prevFetch;
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('grok-oauth: all Grok models inherit global transport; explicit setting is the escape hatch', () => {
    const prevOaiTransport = process.env.MIXDOG_OAI_TRANSPORT;
    const prevResponsesTransport = process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT;
    const prevGrokTransport = process.env.MIXDOG_GROK_OAUTH_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        delete process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT;
        delete process.env.MIXDOG_GROK_OAUTH_TRANSPORT;
        const provider = new GrokOAuthProvider({});

        const apiInner = provider._ensureInner('tok', 'grok-build-0.1');
        assert.equal(apiInner.config.responsesTransport, undefined);

        // No Grok-specific override: proxy-only grok-build now inherits the
        // shared switch too (WS→api.x.ai), no implicit HTTP pin.
        const proxyInner = provider._ensureInner('tok', 'grok-build');
        assert.equal(proxyInner.config.responsesTransport, undefined);

        // Escape hatch: an explicit Grok-specific http setting pins proxy-only
        // models back onto the Grok CLI proxy over HTTP.
        process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT = 'http';
        const pinnedProvider = new GrokOAuthProvider({});
        const pinnedProxy = pinnedProvider._ensureInner('tok', 'grok-build');
        assert.equal(pinnedProxy.config.responsesTransport, 'http');
        const pinnedApi = pinnedProvider._ensureInner('tok2', 'grok-build-0.1');
        assert.equal(pinnedApi.config.responsesTransport, 'http');
    } finally {
        if (prevOaiTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevOaiTransport;
        if (prevResponsesTransport == null) delete process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT;
        else process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT = prevResponsesTransport;
        if (prevGrokTransport == null) delete process.env.MIXDOG_GROK_OAUTH_TRANSPORT;
        else process.env.MIXDOG_GROK_OAUTH_TRANSPORT = prevGrokTransport;
    }
});

test('responses transport policy: _gateTransportMode down-shifts per capability', () => {
    // delta unsupported → ws-delta collapses to ws-full; others pass through.
    const noDelta = { ws: true, http: true, delta: false };
    assert.equal(_gateTransportMode('auto', noDelta), 'ws-full');
    assert.equal(_gateTransportMode('ws-delta', noDelta), 'ws-full');
    assert.equal(_gateTransportMode('ws-full', noDelta), 'ws-full');
    assert.equal(_gateTransportMode('http-sse', noDelta), 'http-sse');
    // WS unsupported → WS modes prefer HTTP.
    const httpOnly = { ws: false, http: true, delta: false };
    assert.equal(_gateTransportMode('auto', httpOnly), 'http-sse');
    assert.equal(_gateTransportMode('ws-full', httpOnly), 'http-sse');
    assert.equal(_gateTransportMode('ws-delta', httpOnly), 'http-sse');
    // HTTP unsupported → http-sse prefers full-frame WS.
    const wsOnly = { ws: true, http: false, delta: true };
    assert.equal(_gateTransportMode('http-sse', wsOnly), 'ws-full');
    // full caps pass everything through unchanged.
    for (const m of ['auto', 'ws-full', 'ws-delta', 'http-sse']) {
        assert.equal(_gateTransportMode(m, FULL_RESPONSES_TRANSPORT_CAPS), m);
    }
});

// === 11. Codex x-codex-turn-state parity =================================
// Server-issued sticky-routing token. codex-rs stores it in a per-turn
// `OnceLock<String>` (client.rs:277-285): captured ONCE at turn start from the
// `x-codex-turn-state` RESPONSE header, replayed unchanged on every request
// within that turn, never fabricated, and dropped between turns (a fresh
// ModelClientSession/OnceLock per turn). These tests pin that exact contract
// against our pooled-socket emulation (capture + first-use/turn-id attribution
// + per-turn drop guard).
test('codex turn-state: captures server response header once, never synthesizes', () => {
    const entry = {};
    // No header on the event → nothing captured (never fabricated).
    _captureTurnStateFromEvent(entry, { type: 'response.created', headers: {} });
    assert.equal(entry.turnState, undefined);
    // Server issues the token on a response header → captured.
    _captureTurnStateFromEvent(entry, { type: 'response.created', headers: { 'x-codex-turn-state': 'tok-1' } });
    assert.equal(entry.turnState, 'tok-1');
    // OnceLock semantics: a later server token in the same turn does NOT overwrite.
    _captureTurnStateFromEvent(entry, { headers: { 'x-codex-turn-state': 'tok-2' } });
    assert.equal(entry.turnState, 'tok-1');
});

test('codex turn-state: captures from nested response/metadata header shapes', () => {
    const fromResponse = {};
    _captureTurnStateFromEvent(fromResponse, { response: { headers: { 'x-codex-turn-state': 'tok-r' } } });
    assert.equal(fromResponse.turnState, 'tok-r');
    const fromMeta = {};
    _captureTurnStateFromEvent(fromMeta, { response: { metadata: { headers: { 'x-codex-turn-state': 'tok-m' } } } });
    assert.equal(fromMeta.turnState, 'tok-m');
});

test('codex turn-state: echoed within a turn, dropped across turns, never fabricated', () => {
    const ctxA = { sendOpts: { turnId: 'turn-A', codexSessionId: 'sess', threadId: 'thread' } };
    // A server-captured token with unknown owner (handshake/prewarm capture).
    const entry = { turnState: 'tok-A' };
    const f1 = _withCodexWsClientMetadata({}, entry, true, ctxA);
    assert.equal(f1.client_metadata['x-codex-turn-state'], 'tok-A');
    // First use attributes the token to the turn now on the wire.
    assert.equal(entry.turnStateTurnId, 'turn-A');
    // Subsequent request in the SAME turn replays the same token.
    const f2 = _withCodexWsClientMetadata({}, entry, true, ctxA);
    assert.equal(f2.client_metadata['x-codex-turn-state'], 'tok-A');
    // Next turn: the token must be dropped, never replayed or fabricated.
    const ctxB = { sendOpts: { turnId: 'turn-B', codexSessionId: 'sess', threadId: 'thread' } };
    const f3 = _withCodexWsClientMetadata({}, entry, true, ctxB);
    assert.equal('x-codex-turn-state' in f3.client_metadata, false);
    assert.equal(entry.turnState, null);
});

test('codex turn-state: parity disabled leaves the frame untouched (no metadata, no echo)', () => {
    const entry = { turnState: 'tok-A' };
    const frame = { input: [] };
    const out = _withCodexWsClientMetadata(frame, entry, false, { sendOpts: { turnId: 'turn-A' } });
    assert.equal(out, frame);
    assert.equal(out.client_metadata, undefined);
});
