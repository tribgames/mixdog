#!/usr/bin/env node
// Regression tests for the mid-stream SEMANTIC idle abort (Part A/C of the
// "mid-stream stall hangs 30 min + owner never notified" fix).
//
// Contract pinned here:
//   (a) a stream that emits a real delta then ONLY `:ping` keepalive frames
//       trips the semantic idle abort within the configured window (NOT the
//       30-min agent watchdog) and throws the NAMED terminal StreamStalledError
//       (code ESTREAMSTALL). Pings must NOT reset the semantic timer.
//   (b) a stream with genuine reasoning deltas spaced UNDER the window is NOT
//       aborted (thinking deltas are semantic progress → reset the timer).
//   (c) the named abort error classifies as a terminal STREAM FAILURE
//       ('transient' → owner gets notified via retry/reconcile), and is NOT a
//       user cancel (signal.aborted).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseSSEStream as anthropicParseSSEStream,
    _classifyMidstreamError,
} from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { classifyError } from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';
import { streamStalledError } from '../src/runtime/agent/orchestrator/stall-policy.mjs';

const encoder = new TextEncoder();
const frame = (e) => encoder.encode(`event: ${e.type || 'message'}\ndata: ${JSON.stringify(e)}\n\n`);

// Response-like shape whose reader emits `realEvents` immediately, then only
// `:ping` comment frames forever (on an interval) — the ping-only wedge.
function pingWedgeResponse(realEvents, { pingIntervalMs = 30 } = {}) {
    const realChunks = realEvents.map(frame);
    let i = 0;
    let cancelled = false;
    return {
        body: {
            getReader() {
                return {
                    read() {
                        if (cancelled) return Promise.resolve({ done: true, value: undefined });
                        if (i < realChunks.length) return Promise.resolve({ done: false, value: realChunks[i++] });
                        return new Promise((resolve) => {
                            const t = setTimeout(() => resolve({ done: false, value: encoder.encode(':ping\n\n') }), pingIntervalMs);
                            t.unref?.();
                        });
                    },
                    cancel() { cancelled = true; return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}

// Response-like shape that delivers each event after `gapMs` — models a live
// stream whose deltas are spaced but under the idle window.
function pacedResponse(events, { gapMs = 40 } = {}) {
    const chunks = events.map(frame);
    let i = 0;
    return {
        body: {
            getReader() {
                return {
                    read() {
                        if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
                        const value = chunks[i++];
                        return new Promise((resolve) => {
                            const t = setTimeout(() => resolve({ done: false, value }), gapMs);
                            t.unref?.();
                        });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}

test('(a) delta-then-ping-only wedge → semantic idle abort fires within window with named error', async () => {
    const realEvents = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    ];
    // Window 120ms, pings every 30ms: if pings RESET the timer it never fires;
    // proving the abort fires => pings are ping-immune (semantic-only reset).
    const state = { semanticIdleTimeoutMs: 120, firstMessageTimeoutMs: 60_000 };
    const started = Date.now();
    await assert.rejects(
        anthropicParseSSEStream(
            pingWedgeResponse(realEvents, { pingIntervalMs: 30 }),
            null, () => {}, () => {}, () => {}, state, () => {}, null,
        ),
        (err) => {
            assert.equal(err.name, 'StreamStalledError');
            assert.equal(err.code, 'ESTREAMSTALL');
            assert.equal(err.streamStalled, true);
            return true;
        },
    );
    const elapsed = Date.now() - started;
    // Fired near the 120ms window, nowhere near a 30-min hang.
    assert.ok(elapsed < 3_000, `expected abort within ~window, got ${elapsed}ms`);
});

test('(b) genuine reasoning deltas spaced under the window → NOT aborted', async () => {
    const events = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'b' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'c' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    // gap 40ms << window 200ms: each delta resets the semantic timer, so the
    // long-but-live stream completes normally.
    const state = { semanticIdleTimeoutMs: 200, firstMessageTimeoutMs: 60_000 };
    const result = await anthropicParseSSEStream(
        pacedResponse(events, { gapMs: 40 }),
        null, () => {}, () => {}, () => {}, state, () => {}, null,
    );
    assert.equal(result.content, 'done');
    assert.equal(result.hasThinkingContent, true);
});

test('(c) named abort → terminal stream failure (transient/notify), not a user cancel', () => {
    const err = streamStalledError('Anthropic OAuth SSE', 120_000);
    // classifyError routes ESTREAMSTALL as transient → withRetry / owner-notify
    // path treats it as a terminal stream failure, never as a silent success.
    assert.equal(classifyError(err), 'transient');
    // The SSE mid-stream classifier recognizes it via the inactivity text.
    const midState = { sawMessageStart: true, sawCompleted: false, attemptIndex: 0 };
    assert.equal(_classifyMidstreamError(err, midState), 'sse_idle_timeout');
    // It is NOT a user cancel: distinct name from the abort-reason names the
    // providers treat as watchdog/user aborts, and it carries no signal.aborted.
    assert.notEqual(err.name, 'AbortError');
    assert.equal(err.streamStalled, true);
});
