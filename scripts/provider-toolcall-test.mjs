#!/usr/bin/env node
// Regression tests pinning the cross-provider "native tool_call extraction"
// contract: when a provider's native parser is fed a well-formed tool_call
// payload, it MUST surface the call in our canonical toolCalls shape
// ({ id, name, arguments }). Mirrors codex-rs sse/responses.rs #[cfg(test)]
// style — synthetic inputs fed directly to the exported parser, asserting the
// resulting outcome. No network, no model. Each provider also gets one
// negative case (no native tool_call → undefined / empty).
//
// Parser entry points (file:line at authoring time) and sharing notes are
// documented inline per provider block below.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseToolCalls as compatParseToolCalls,
    parseResponsesToolCalls as compatParseResponsesToolCalls,
} from '../src/runtime/agent/orchestrator/providers/openai-compat.mjs';
import { isInvalidToolArgsMarker } from '../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';
import { parseToolCalls as geminiParseToolCalls } from '../src/runtime/agent/orchestrator/providers/gemini.mjs';
import { parseSSEStream as anthropicParseSSEStream } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';

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

// === 4. openai-oauth / openai-oauth-ws =====================================
// openai-oauth (HTTP/SSE) and openai-oauth-ws (WebSocket) both consume the
// Responses event stream inside large stateful stream loops, NOT a standalone
// parser. The HTTP path's handleEvent is a private closure inside
// sendViaHttpSse (openai-oauth.mjs:1038) and cannot be exported without
// extracting it (forbidden: no logic change). The WS path's _streamResponse
// (openai-oauth-ws.mjs:1190) IS exported but requires a live `entry.socket`
// EventEmitter and resolves only on response.completed — driving it needs a
// full fake-socket harness, well beyond "inject synthetic input to a parser".
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
