import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isInvalidToolArgsMarker,
  anthropicParseSSEStream,
  anthropicSseResponse,
} from './_shared.mjs';


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
