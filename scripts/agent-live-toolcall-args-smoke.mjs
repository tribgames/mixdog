#!/usr/bin/env node
// Standalone regression smoke pinning the tool_call arguments contract used by
// the native providers (see scripts/toolcall-args-test.mjs for the full suite).
// Same unit-test style: synthetic inputs fed to the exported parser, asserting
// the outcome — no network, no model. Kept minimal so it can run in isolation
// via `node --test scripts/agent-live-toolcall-args-smoke.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseCompletedToolCallArgumentsJson,
    isInvalidToolArgsMarker,
    formatInvalidToolArgsResult,
} from '../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';

test('smoke: valid arguments JSON parses to the intended object', () => {
    const out = parseCompletedToolCallArgumentsJson(
        '{"pattern":"x","path":"src"}', 'smoke', { finishReason: 'stop' });
    assert.deepEqual(out, { pattern: 'x', path: 'src' });
});

test('smoke: empty/missing arguments default to {}', () => {
    assert.deepEqual(parseCompletedToolCallArgumentsJson('', 'smoke', { finishReason: 'stop' }), {});
    assert.deepEqual(parseCompletedToolCallArgumentsJson(undefined, 'smoke'), {});
});

test('smoke: malformed args with finishReason → invalid-args marker (no throw)', () => {
    const bareword = '{"pattern": dispatchAiWrapped, "path": "src/agent"}';
    const out = parseCompletedToolCallArgumentsJson(bareword, 'smoke', { finishReason: 'stop' });
    assert.equal(isInvalidToolArgsMarker(out), true);
    assert.equal(out.__rawArguments, bareword);
    const msg = formatInvalidToolArgsResult({ name: 'grep', arguments: out });
    assert.match(msg, /Re-issue this tool call with valid JSON arguments/);
});

test('smoke: malformed args without finishReason → retryable TruncatedStreamError', () => {
    let threw;
    try {
        parseCompletedToolCallArgumentsJson('{', 'smoke');
    } catch (err) {
        threw = err;
    }
    assert.ok(threw instanceof Error, 'must throw on mid-stream truncation');
    assert.equal(threw.code, 'TRUNCATED_STREAM');
    assert.equal(threw.truncatedStream, true);
});
