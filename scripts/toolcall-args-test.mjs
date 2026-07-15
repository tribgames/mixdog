#!/usr/bin/env node
// Regression tests pinning the native-provider (OpenAI-compat / claude-code / opencode)
// tool_call arguments contract: completed-but-malformed arguments JSON is NEVER
// thrown (which would kill the turn) NOR silently swallowed to {}. With a finish
// signal observed it is surfaced as an invalid-args MARKER carried on the
// arguments slot, so the dispatch loop feeds the parse error back to the model
// as an is_error tool_result and the model self-corrects in the SAME turn.
// Without a finish signal (mid-stream truncation) it remains a retryable
// TruncatedStreamError — that transient behavior is deliberately preserved.
// Unit-test style: synthetic inputs fed
// directly to the exported parser, asserting the resulting outcome — no
// network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
    parseCompletedToolCallArgumentsJson,
    toolCallsFromStreamAcc,
    isInvalidToolArgsMarker,
    formatInvalidToolArgsResult,
} from '../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';
import { parseSSEStream } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { classifyError } from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STREAM_SRC = resolve(__dirname, '../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs');
const UTF8 = new TextEncoder();

// Captures the synchronous throw of `fn` and returns the Error, failing if none.
function captureThrow(fn) {
    try {
        const v = fn();
        assert.fail(`expected throw, got resolved value: ${JSON.stringify(v)}`);
    } catch (err) {
        assert.ok(err instanceof Error, 'thrown value must be an Error');
        return err;
    }
}

test('A: valid arguments JSON parses to the intended object', () => {
    const out = parseCompletedToolCallArgumentsJson(
        '{"pattern":"x","path":"src"}', 'test', { finishReason: 'stop' });
    assert.deepEqual(out, { pattern: 'x', path: 'src' });
});

test('B: empty/missing arguments default to {}', () => {
    assert.deepEqual(parseCompletedToolCallArgumentsJson('', 'test', { finishReason: 'stop' }), {});
    assert.deepEqual(parseCompletedToolCallArgumentsJson(null, 'test', { finishReason: 'stop' }), {});
    assert.deepEqual(parseCompletedToolCallArgumentsJson(undefined, 'test'), {});
});

test('C: bareword JSON with finishReason → invalid-args marker (no throw, no salvage)', () => {
    const bareword = '{"pattern": dispatchAiWrapped, "path": "src/agent"}';
    const out = parseCompletedToolCallArgumentsJson(bareword, 'test', { finishReason: 'stop' });
    assert.equal(isInvalidToolArgsMarker(out), true);
    assert.equal(out.__invalidToolArgs, true);
    assert.equal(out.__rawArguments, bareword);
    assert.equal(typeof out.__parseError, 'string');
    assert.ok(out.__parseError.length > 0, 'parse error message must be carried');
    // Model-facing tool_result text uses the shared invalid-args template.
    const msg = formatInvalidToolArgsResult({ name: 'grep', arguments: out });
    assert.match(msg, /invalid JSON/);
    assert.match(msg, /Re-issue this tool call with valid JSON arguments/);
});

test('C: bareword JSON without finishReason → retryable TruncatedStreamError', () => {
    const bareword = '{"pattern": dispatchAiWrapped, "path": "src/agent"}';
    // meta omitted entirely
    const err1 = captureThrow(() => parseCompletedToolCallArgumentsJson(bareword, 'test'));
    assert.equal(err1.name, 'TruncatedStreamError');
    assert.equal(err1.code, 'TRUNCATED_STREAM');
    assert.equal(err1.truncatedStream, true);
    // meta present but finishReason unset
    const err2 = captureThrow(() =>
        parseCompletedToolCallArgumentsJson(bareword, 'test', { id: 'call_1', name: 'grep' }));
    assert.equal(err2.name, 'TruncatedStreamError');
    assert.equal(err2.code, 'TRUNCATED_STREAM');
    assert.equal(err2.truncatedStream, true);
});

test('D: fully malformed "{" splits on finishReason just like bareword', () => {
    const marker = parseCompletedToolCallArgumentsJson('{', 'test', { finishReason: 'stop' });
    assert.equal(isInvalidToolArgsMarker(marker), true);
    assert.equal(marker.__rawArguments, '{');

    const transient = captureThrow(() =>
        parseCompletedToolCallArgumentsJson('{', 'test'));
    assert.equal(transient.name, 'TruncatedStreamError');
    assert.equal(transient.code, 'TRUNCATED_STREAM');
    assert.equal(transient.truncatedStream, true);
});

test('E: source no longer contains any salvageBarewordJson reference', () => {
    const src = readFileSync(STREAM_SRC, 'utf8');
    assert.equal(src.includes('salvageBarewordJson'), false,
        'salvage helper must be fully removed');
});

// Stream-accumulation path: synthetic per-index accumulator + a parseToolCalls
// shim that delegates to the real parser (same wiring as openai-compat.mjs).
function parseToolCallsShim(choice, label) {
    const calls = choice.message?.tool_calls;
    if (!calls?.length) return undefined;
    const finishReason = choice.finish_reason || null;
    return calls
        .filter((tc) => tc.type === 'function')
        .map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: parseCompletedToolCallArgumentsJson(
                tc.function.arguments, label,
                { id: tc.id, name: tc.function.name, finishReason }),
        }));
}

test('stream acc: valid accumulated arguments parse through to a tool call', () => {
    const acc = new Map();
    acc.set('n:0', {
        id: 'call_a', type: 'function',
        function: { name: 'grep', arguments: '{"pattern":"x","path":"src"}' },
        _order: 1,
    });
    const out = toolCallsFromStreamAcc(acc, parseToolCallsShim, 'test', 'stop');
    assert.deepEqual(out, [{ id: 'call_a', name: 'grep', arguments: { pattern: 'x', path: 'src' } }]);
});

test('stream acc: bareword with finish_reason → invalid-args marker on the call (no throw)', () => {
    const acc = new Map();
    acc.set('n:0', {
        id: 'call_b', type: 'function',
        function: { name: 'grep', arguments: '{"pattern": dispatchAiWrapped, "path": "src/agent"}' },
        _order: 1,
    });
    const out = toolCallsFromStreamAcc(acc, parseToolCallsShim, 'test', 'stop');
    assert.equal(Array.isArray(out), true);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'call_b');
    assert.equal(out[0].name, 'grep');
    assert.equal(isInvalidToolArgsMarker(out[0].arguments), true);
});

test('retry-classifier: truncated stream (no finish) → transient (preserved behavior)', () => {
    // The invalid-args marker is no longer a thrown Error, so there is nothing
    // for classifyError to route — the dispatch loop handles it as a
    // tool_result. Only the mid-stream truncation path still throws, and it
    // must remain transient/retryable.
    const transient = captureThrow(() =>
        parseCompletedToolCallArgumentsJson('{', 'test'));
    assert.equal(classifyError(transient), 'transient');
});

function responseFromSseText(text) {
    return {
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(UTF8.encode(text));
                controller.close();
            },
        }),
    };
}

function livePingOnlyResponse(intervalMs = 5) {
    let timer = null;
    return {
        body: new ReadableStream({
            start(controller) {
                timer = setInterval(() => {
                    try { controller.enqueue(UTF8.encode(':ping\n\n')); }
                    catch { if (timer) clearInterval(timer); }
                }, intervalMs);
            },
            cancel() {
                if (timer) clearInterval(timer);
            },
        }),
    };
}

test('anthropic SSE: comments do not count as stream progress', async () => {
    const state = { firstMessageTimeoutMs: 100 };
    const progressKinds = [];
    const result = await parseSSEStream(
        responseFromSseText([
            ':ping',
            '',
            'event: message_start',
            'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":1}}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            '',
        ].join('\n')),
        null,
        null,
        (kind) => progressKinds.push(kind),
        null,
        state,
        null,
    );
    assert.equal(result.content, 'hi');
    assert.deepEqual(
        progressKinds,
        ['transport', 'semantic', 'text'],
        'the comment emits nothing; message_start and text each report only their exact kinds',
    );
});

test('anthropic SSE: ping-only stream times out before empty-stream guard can hang', async () => {
    const controller = new AbortController();
    const progressKinds = [];
    await assert.rejects(
        () => parseSSEStream(
            livePingOnlyResponse(),
            controller.signal,
            (reason) => controller.abort(reason),
            (kind) => progressKinds.push(kind),
            null,
            { firstMessageTimeoutMs: 30 },
            null,
        ),
        (err) => {
            assert.equal(err.code, 'EEMPTYSTREAM');
            assert.equal(err.isEmptyStream, true);
            assert.equal(err.firstByteTimeout, true);
            return true;
        },
    );
    assert.deepEqual(
        progressKinds,
        [],
        'ping-only SSE must emit no transport, semantic, or content progress',
    );
});
