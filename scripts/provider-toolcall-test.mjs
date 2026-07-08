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
import { parseSSEStream as anthropicParseSSEStream } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { _buildRequestBodyForCacheSmoke } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
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

// --- Helpers ---------------------------------------------------------------

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

function compatResponsesEventStream(events) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
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

test('openai-compat/xai Responses: freeform apply_patch downgrades to function schema', () => {
    const tools = _toResponsesToolsForTest(PATCH_TOOL_DEFS);
    const patch = tools.find((tool) => tool.name === 'apply_patch');
    assert.equal(patch.type, 'function');
    assert.equal(patch.format, undefined);
    assert.equal(patch.parameters?.properties?.patch?.type, 'string');
    assert.deepEqual(patch.parameters?.required, ['patch']);
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
    ], null, { model: 'grok-composer-2.5-fast' });
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
                lastResponseItems: [{ type: 'function_call', call_id: 'call_1', name: 'tool', arguments: '{}' }],
            },
            body: {
                ...body,
                input: [
                    body.input[0],
                    { type: 'function_call', call_id: 'call_other', name: 'tool', arguments: '{}' },
                    body.input[1],
                ],
            },
        });
        assert.equal(responseMismatch.mode, 'full');
        assert.equal(responseMismatch.reason, 'response_output_mismatch:function_call');
        assert.equal(responseMismatch.frame.previous_response_id, undefined);
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

test('canonical frame: delta insert keeps key order, drops empty instructions, overrides input', () => {
    const body = {
        model: 'gpt-5.5',
        instructions: 'sys',
        input: [{ a: 1 }, { b: 2 }],
        tool_choice: 'auto',
        text: { verbosity: 'low' },
    };
    const delta = _buildResponseCreateFrame(body, { previousResponseId: 'resp_prev', inputOverride: [{ b: 2 }] });
    assert.deepEqual(Object.keys(delta), ['type', 'model', 'instructions', 'previous_response_id', 'input', 'tool_choice', 'text']);
    assert.equal(delta.previous_response_id, 'resp_prev');
    assert.deepEqual(delta.input, [{ b: 2 }]);
    // Empty instructions is dropped in delta mode (server resolves via prev id).
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

test('transport policy: default (no env) is ws-delta / refs continuation ON', () => {
    const p = resolveOpenAiTransportPolicy({});
    assert.equal(p.mode, 'ws-delta');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, false);
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

test('transport policy: unknown MIXDOG_OAI_TRANSPORT falls back to default ws-delta', () => {
    const p = resolveOpenAiTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'quantum' });
    assert.equal(p.mode, 'ws-delta');
    assert.equal(p.transport, 'ws');
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
    assert.equal(_normalizeTransportMode('auto'), 'ws-delta');
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

test('responses transport policy: xai auto defers (transport=auto, delta OFF, no http fallback)', () => {
    const p = resolveResponsesTransportPolicy({}, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(p.mode, 'ws-delta');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, false);
    assert.deepEqual(p.delta, { force: false, refs: true, optIn: true });
});

test('responses transport policy: explicit auto is a ws-delta compatibility spelling', () => {
    const p = resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'auto' }, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(p.transport, 'ws');
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

test('openai-compat/xai: provider-local HTTP pin beats global OAI ws-delta', async () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const provider = new OpenAICompatProvider('xai', {
            apiKey: 'xai-test',
            responsesTransport: 'http',
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
    } finally {
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
    assert.equal(_gateTransportMode('ws-delta', noDelta), 'ws-full');
    assert.equal(_gateTransportMode('ws-full', noDelta), 'ws-full');
    assert.equal(_gateTransportMode('http-sse', noDelta), 'http-sse');
    // WS unsupported → WS modes prefer HTTP.
    const httpOnly = { ws: false, http: true, delta: false };
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
