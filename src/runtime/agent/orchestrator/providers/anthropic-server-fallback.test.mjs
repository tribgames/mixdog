import assert from 'node:assert/strict';
import test from 'node:test';

import {
    SERVER_SIDE_FALLBACK_BETA_HEADER,
    buildAnthropicBetaHeaders,
} from './anthropic-betas.mjs';
import { _buildRequestBodyForCacheSmoke } from './anthropic-oauth.mjs';
import {
    applyAnthropicServerFallback,
    parseAnthropicFallbackBlock,
    supportsAnthropicServerFallback,
} from './anthropic-server-fallback.mjs';
import { parseSSEStream } from './anthropic-sse.mjs';
import { normalizeAnthropicNonStreamingResponse } from './lib/anthropic-request-utils.mjs';
import { agentLoop } from '../session/agent-loop.mjs';

const fallbackBlock = {
    type: 'fallback',
    from: { model: 'claude-opus-5' },
    to: { model: 'claude-opus-4-8' },
    trigger: { type: 'refusal', category: 'cyber' },
};

test('server fallback defaults only eligible Anthropic model families', () => {
    assert.equal(supportsAnthropicServerFallback('claude-opus-5'), true);
    assert.equal(supportsAnthropicServerFallback('claude-fable-5-20260801'), true);
    assert.equal(supportsAnthropicServerFallback('claude-opus-4-8'), false);

    const body = {};
    assert.equal(applyAnthropicServerFallback(body, 'claude-opus-5'), true);
    assert.equal(body.fallbacks, 'default');

    const disabled = {};
    assert.equal(
        applyAnthropicServerFallback(disabled, 'claude-opus-5', { enabled: false }),
        false,
    );
    assert.equal('fallbacks' in disabled, false);
});

test('server fallback beta header is request-gated and deduplicated', () => {
    assert.equal(
        buildAnthropicBetaHeaders({ base: '', serverFallback: false }).includes(SERVER_SIDE_FALLBACK_BETA_HEADER),
        false,
    );
    const headers = buildAnthropicBetaHeaders({
        base: SERVER_SIDE_FALLBACK_BETA_HEADER,
        serverFallback: true,
    }).split(',');
    assert.equal(headers.filter((item) => item === SERVER_SIDE_FALLBACK_BETA_HEADER).length, 1);
});

test('OAuth request body opts eligible models into Anthropic default fallback', () => {
    const opus5 = _buildRequestBodyForCacheSmoke([], 'claude-opus-5');
    assert.equal(opus5.fallbacks, 'default');

    const opus48 = _buildRequestBodyForCacheSmoke([], 'claude-opus-4-8');
    assert.equal('fallbacks' in opus48, false);

    const disabled = _buildRequestBodyForCacheSmoke(
        [],
        'claude-opus-5',
        [],
        { serverFallback: false },
    );
    assert.equal('fallbacks' in disabled, false);
});

test('fallback block parser uses structured model and refusal category fields', () => {
    assert.deepEqual(parseAnthropicFallbackBlock(fallbackBlock), {
        trigger: 'refusal',
        originalModel: 'claude-opus-5',
        fallbackModel: 'claude-opus-4-8',
        category: 'cyber',
    });
    assert.equal(parseAnthropicFallbackBlock({ type: 'text', text: 'fallback' }), null);
});

const encoder = new TextEncoder();
function sseResponse(events) {
    const chunks = events.map((event) => (
        encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    ));
    let index = 0;
    return {
        body: {
            getReader() {
                return {
                    read() {
                        if (index < chunks.length) {
                            return Promise.resolve({ done: false, value: chunks[index++] });
                        }
                        return Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}

test('SSE parser records server fallback and attributes the turn to the serving model', async () => {
    const state = {
        attemptIndex: 0,
        sawMessageStart: false,
        sawCompleted: false,
        emittedToolCall: false,
        partialToolCall: false,
        emittedThinking: false,
        emittedText: false,
    };
    const result = await parseSSEStream(
        sseResponse([
            {
                type: 'message_start',
                message: {
                    model: 'claude-opus-5',
                    usage: { input_tokens: 10 },
                },
            },
            { type: 'content_block_start', index: 0, content_block: fallbackBlock },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
            { type: 'content_block_stop', index: 1 },
            {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 2 },
            },
            { type: 'message_stop' },
        ]),
        null,
        () => {},
        () => {},
        () => {},
        state,
        () => {},
    );

    assert.equal(result.content, 'done');
    assert.equal(result.model, 'claude-opus-4-8');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.contentBlockTypes.includes('fallback'), true);
    assert.deepEqual(result.providerMetadata, {
        anthropicFallbacks: [{
            trigger: 'refusal',
            originalModel: 'claude-opus-5',
            fallbackModel: 'claude-opus-4-8',
            category: 'cyber',
        }],
    });
});

test('agent loop reports the actual serving model in per-request usage deltas', async () => {
    const deltas = [];
    const provider = {
        name: 'anthropic-oauth',
        async send() {
            return {
                content: 'done',
                model: 'claude-opus-4-8',
                stopReason: 'end_turn',
                usage: {
                    inputTokens: 1,
                    outputTokens: 2,
                    cachedTokens: 3,
                    cacheWriteTokens: 4,
                    promptTokens: 8,
                },
            };
        },
    };

    const result = await agentLoop(
        provider,
        [{ role: 'user', content: 'test' }],
        'claude-opus-5',
        [],
        async () => {},
        process.cwd(),
        {
            sessionId: 'server-fallback-usage-test',
            onUsageDelta: (delta) => deltas.push(delta),
        },
    );

    assert.equal(result.model, 'claude-opus-4-8');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].requestedModel, 'claude-opus-5');
    assert.equal(deltas[0].model, 'claude-opus-4-8');
});

test('non-streaming normalizer excludes fallback blocks and preserves metadata', () => {
    const result = normalizeAnthropicNonStreamingResponse({
        model: 'claude-opus-5',
        content: [
            fallbackBlock,
            { type: 'text', text: 'done' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
    });

    assert.equal(result.content, 'done');
    assert.equal(result.model, 'claude-opus-4-8');
    assert.deepEqual(result.providerMetadata?.anthropicFallbacks, [{
        trigger: 'refusal',
        originalModel: 'claude-opus-5',
        fallbackModel: 'claude-opus-4-8',
        category: 'cyber',
    }]);
});
