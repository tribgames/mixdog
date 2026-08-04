#!/usr/bin/env node
// Provider-boundary contract for Anthropic NATIVE server-tool turns
// (`stop_reason:'pause_turn'`): the ordered `server_tool_use` +
// `*_tool_result` blocks must survive BOTH Anthropic transports end-to-end —
// the API-key streaming return and the non-streaming fallback of each
// provider — because a result block is only valid immediately after the call
// block that produced it. Ordinary text/thinking/tool_use turns must keep the
// existing shape (no assistantBlocks, no duplicate thinking/tool replay).
import test from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicProvider } from '../src/runtime/agent/orchestrator/providers/anthropic.mjs';
import { AnthropicOAuthProvider } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { toAnthropicMessages } from '../src/runtime/agent/orchestrator/providers/anthropic-messages.mjs';
import { normalizeAnthropicNonStreamingResponse } from '../src/runtime/agent/orchestrator/providers/lib/anthropic-request-utils.mjs';

const encoder = new TextEncoder();

function sseResponse(events) {
    const bytes = encoder.encode(events.map((event) => (
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    )).join(''));
    let sent = false;
    return {
        ok: true,
        status: 200,
        headers: new Map(),
        body: { getReader: () => ({
            async read() {
                if (sent) return { done: true };
                sent = true;
                return { done: false, value: bytes };
            },
            async cancel() {},
            releaseLock() {},
        }) },
    };
}

const WEB_SEARCH_RESULT_BLOCK = {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_01WebSearch',
    content: [
        {
            type: 'web_search_result',
            title: 'Anthropic docs — pause_turn',
            url: 'https://docs.anthropic.com/en/docs/build-with-claude/tool-use',
            encrypted_content: 'EvgBCioIARgBIiQ8dW9wcXJzdHV2d3h5ejAxMjM0NTY3ODkQ',
            page_age: 'April 30, 2025',
        },
    ],
};
const SERVER_TOOL_USE_BLOCK = {
    type: 'server_tool_use',
    id: 'srvtoolu_01WebSearch',
    name: 'web_search',
    input: { query: 'anthropic pause_turn' },
};

// Streaming wire shape: text → server_tool_use (streamed input) → result.
function nativeSseEvents() {
    return [
        { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 12 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me look that up.' } },
        { type: 'content_block_stop', index: 0 },
        {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'server_tool_use', id: 'srvtoolu_01WebSearch', name: 'web_search', input: {} },
        },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query": ' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"anthropic pause_turn"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: WEB_SEARCH_RESULT_BLOCK },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 30 } },
        { type: 'message_stop' },
    ];
}

// Truncated stream (message_start, live text, no message_stop) — the exact
// condition that routes both providers into the non-streaming fallback.
function truncatedTextSseEvents() {
    return [
        { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 7 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Searching' } },
    ];
}

// Non-streaming wire shape (message.content), thinking + text + native pair.
function nativeNonStreamingMessage() {
    return {
        id: 'msg_native_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        stop_reason: 'pause_turn',
        content: [
            { type: 'thinking', thinking: 'need fresh docs', signature: 'sig-native' },
            { type: 'text', text: 'Let me look that up.' },
            SERVER_TOOL_USE_BLOCK,
            WEB_SEARCH_RESULT_BLOCK,
        ],
        usage: { input_tokens: 12, output_tokens: 30 },
    };
}

function apiKeyProvider(createImpl) {
    const provider = Object.create(AnthropicProvider.prototype);
    provider.name = 'anthropic';
    provider.config = { apiKey: 'fixture-key' };
    provider.fastModeBetaHeaderLatched = false;
    provider.client = { messages: { create: createImpl } };
    return provider;
}

function oauthProvider() {
    const provider = Object.create(AnthropicOAuthProvider.prototype);
    provider.name = 'anthropic-oauth';
    provider.credentials = { accessToken: 'fixture', expiresAt: Date.now() + 60_000 };
    provider.config = {};
    provider.fastModeBetaHeaderLatched = false;
    provider.ensureAuth = async () => provider.credentials;
    provider.scrubTokens = (text) => text;
    return provider;
}

const EXPECTED_STREAM_BLOCKS = [
    { type: 'text', text: 'Let me look that up.' },
    SERVER_TOOL_USE_BLOCK,
    WEB_SEARCH_RESULT_BLOCK,
];

function loweredAssistantContent(response) {
    const lowered = toAnthropicMessages([
        { role: 'user', content: 'search the docs' },
        {
            role: 'assistant',
            content: response.content,
            ...(response.assistantBlocks ? { assistantBlocks: response.assistantBlocks } : {}),
            ...(response.thinkingBlocks && !response.assistantBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
        },
    ]);
    return lowered.find((m) => m.role === 'assistant')?.content;
}

test('API-key streaming return preserves ordered native server-tool blocks', async () => {
    const provider = apiKeyProvider(() => ({ async asResponse() { return sseResponse(nativeSseEvents()); } }));

    const result = await provider.send([{ role: 'user', content: 'search the docs' }], 'claude-sonnet-4-5', [], {});

    assert.equal(result.stopReason, 'pause_turn');
    assert.equal(result.content, 'Let me look that up.');
    assert.equal(result.toolCalls, undefined);
    assert.deepEqual(result.assistantBlocks, EXPECTED_STREAM_BLOCKS);
    // Replay must lower verbatim: result block directly after its call block.
    assert.deepEqual(loweredAssistantContent(result), EXPECTED_STREAM_BLOCKS);
});

test('API-key streaming ordinary text/thinking turn stays unchanged (no assistantBlocks)', async () => {
    const provider = apiKeyProvider(() => ({ async asResponse() {
        return sseResponse([
            { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 3 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing options' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'final answer' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
            { type: 'message_stop' },
        ]);
    } }));

    const result = await provider.send([{ role: 'user', content: 'answer' }], 'claude-sonnet-4-5', [], {});

    assert.equal(result.assistantBlocks, undefined);
    assert.equal(result.content, 'final answer');
    assert.deepEqual(result.thinkingBlocks, [{ type: 'thinking', thinking: 'weighing options', signature: 'sig-abc' }]);
});

test('non-streaming normalization keeps ordered native blocks from raw message.content', () => {
    const normalized = normalizeAnthropicNonStreamingResponse(nativeNonStreamingMessage(), 'fallback-model');

    assert.equal(normalized.stopReason, 'pause_turn');
    assert.equal(normalized.content, 'Let me look that up.');
    assert.equal(normalized.toolCalls, undefined);
    assert.deepEqual(normalized.assistantBlocks, [
        { type: 'thinking', thinking: 'need fresh docs', signature: 'sig-native' },
        { type: 'text', text: 'Let me look that up.' },
        SERVER_TOOL_USE_BLOCK,
        WEB_SEARCH_RESULT_BLOCK,
    ]);
    // assistantBlocks already carries the thinking block; lowering must use the
    // ordered list and never replay thinking twice.
    const lowered = loweredAssistantContent(normalized);
    assert.deepEqual(lowered, normalized.assistantBlocks);
    assert.equal(lowered.filter((block) => block.type === 'thinking').length, 1);
});

test('non-streaming normalization keeps native MCP pairs and drops empty text blocks', () => {
    const normalized = normalizeAnthropicNonStreamingResponse({
        model: 'claude-sonnet-4-5',
        stop_reason: 'pause_turn',
        content: [
            { type: 'text', text: '' },
            { type: 'mcp_tool_use', id: 'mcptoolu_01', name: 'echo', server_name: 'demo', input: { value: 1 } },
            { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_01', is_error: false, content: [{ type: 'text', text: '1' }] },
        ],
        usage: { input_tokens: 4, output_tokens: 2 },
    });

    assert.deepEqual(normalized.assistantBlocks, [
        { type: 'mcp_tool_use', id: 'mcptoolu_01', name: 'echo', server_name: 'demo', input: { value: 1 } },
        { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_01', is_error: false, content: [{ type: 'text', text: '1' }] },
    ]);
});

test('non-streaming normalization emits no assistantBlocks for ordinary text/thinking/tool_use turns', () => {
    const ordinary = normalizeAnthropicNonStreamingResponse({
        model: 'claude-sonnet-4-5',
        stop_reason: 'tool_use',
        content: [
            { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
            { type: 'text', text: 'calling a tool' },
            { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.txt' } },
        ],
        usage: { input_tokens: 5, output_tokens: 6 },
    });

    assert.equal(ordinary.assistantBlocks, undefined);
    assert.equal(ordinary.content, 'calling a tool');
    assert.deepEqual(ordinary.toolCalls, [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } }]);
    assert.deepEqual(ordinary.thinkingBlocks, [{ type: 'thinking', thinking: 'plan', signature: 'sig-1' }]);
});

test('API-key non-streaming fallback returns the native blocks through the provider return', async () => {
    let streamingCalls = 0;
    let nonStreamingCalls = 0;
    const provider = apiKeyProvider((params) => {
        if (params.stream === false) {
            nonStreamingCalls += 1;
            return nativeNonStreamingMessage();
        }
        streamingCalls += 1;
        return { async asResponse() { return sseResponse(truncatedTextSseEvents()); } };
    });

    const result = await provider.send([{ role: 'user', content: 'search the docs' }], 'claude-sonnet-4-5', [], {
        onTextDelta: () => {},
        onTextReset: async () => true,
    });

    assert.equal(streamingCalls, 1);
    assert.equal(nonStreamingCalls, 1);
    assert.equal(result.stopReason, 'pause_turn');
    assert.deepEqual(result.assistantBlocks, [
        { type: 'thinking', thinking: 'need fresh docs', signature: 'sig-native' },
        { type: 'text', text: 'Let me look that up.' },
        SERVER_TOOL_USE_BLOCK,
        WEB_SEARCH_RESULT_BLOCK,
    ]);
    assert.deepEqual(loweredAssistantContent(result), result.assistantBlocks);
});

test('OAuth non-streaming fallback returns the native blocks through the provider return', async () => {
    const provider = oauthProvider();
    const requestedBodies = [];

    const result = await provider.send([{ role: 'user', content: 'search the docs' }], 'claude-sonnet-4-5', [], {
        onTextDelta: () => {},
        onTextReset: async () => true,
        _parseSSEFn: async (_response, _signal, _abort, _onStreamDelta, _onToolCall, state) => {
            state.emittedText = true;
            state.emittedTextChars = 9;
            throw Object.assign(new Error('stream dropped'), { code: 'ECONNRESET' });
        },
        _doRequestFn: async (_token, _signal, requestBody) => {
            requestedBodies.push(requestBody);
            return {
                response: {
                    ok: true,
                    status: 200,
                    headers: new Map(),
                    async text() { return ''; },
                    async json() { return nativeNonStreamingMessage(); },
                },
                controller: { abort() {} },
                cancelHandler: null,
            };
        },
    });

    assert.equal(requestedBodies.length, 2);
    assert.equal(requestedBodies[0].stream, true);
    assert.equal(requestedBodies[1].stream, false);
    assert.equal(result.stopReason, 'pause_turn');
    assert.deepEqual(result.assistantBlocks, [
        { type: 'thinking', thinking: 'need fresh docs', signature: 'sig-native' },
        { type: 'text', text: 'Let me look that up.' },
        SERVER_TOOL_USE_BLOCK,
        WEB_SEARCH_RESULT_BLOCK,
    ]);
    assert.deepEqual(loweredAssistantContent(result), result.assistantBlocks);
});
