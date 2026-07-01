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

// The provider's idle timer and the mock readers' ping timers are all `.unref()`
// (correct for production, where a ref'd socket keeps the loop alive). Under
// node:test in isolation there is no such socket, so once every timer is unref'd
// the event loop can empty BEFORE the ~window idle abort fires, and node exits
// the worker — surfacing as "Promise resolution is still pending / cancelled".
// A single ref'd keepalive interval for the duration of the file keeps the loop
// alive so the real abort actually fires; it is cleared on teardown.
let _keepAlive = null;
test.before(() => { _keepAlive = setInterval(() => {}, 50); });
test.after(() => { if (_keepAlive) { clearInterval(_keepAlive); _keepAlive = null; } });

// Response-like shape whose reader emits `realEvents` immediately, then only
// `:ping` comment frames forever (on an interval) — the ping-only wedge.
function pingWedgeResponse(realEvents, { pingIntervalMs = 30 } = {}) {
    const realChunks = realEvents.map(frame);
    let i = 0;
    let cancelled = false;
    let pendingResolve = null;
    let pendingTimer = null;
    return {
        body: {
            getReader() {
                return {
                    read() {
                        if (cancelled) return Promise.resolve({ done: true, value: undefined });
                        if (i < realChunks.length) return Promise.resolve({ done: false, value: realChunks[i++] });
                        // Keep a handle to the in-flight resolver + timer so
                        // cancel() can settle THIS pending read (mirrors the
                        // provider's idleReject force-unblock). Without this the
                        // unref timer leaves the read Promise pending forever and
                        // node:test cancels the whole file.
                        return new Promise((resolve) => {
                            pendingResolve = resolve;
                            pendingTimer = setTimeout(() => {
                                pendingResolve = null; pendingTimer = null;
                                resolve({ done: false, value: encoder.encode(':ping\n\n') });
                            }, pingIntervalMs);
                            pendingTimer.unref?.();
                        });
                    },
                    cancel() {
                        cancelled = true;
                        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
                        if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r({ done: true, value: undefined }); }
                        return Promise.resolve();
                    },
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

// Named-ping wedge: Anthropic sends keepalives as a NAMED SSE event
// (`event: ping` / `data: {"type":"ping"}`), NOT just `:` comment frames. If the
// semantic idle timer reset on any parsed event, a named-ping-only wedge would
// stay alive forever. This pins that named pings do NOT reset the timer.
function namedPingWedgeResponse(realEvents, { pingIntervalMs = 30 } = {}) {
    const realChunks = realEvents.map(frame);
    const pingChunk = frame({ type: 'ping' });
    let i = 0;
    let cancelled = false;
    let pendingResolve = null;
    let pendingTimer = null;
    return {
        body: {
            getReader() {
                return {
                    read() {
                        if (cancelled) return Promise.resolve({ done: true, value: undefined });
                        if (i < realChunks.length) return Promise.resolve({ done: false, value: realChunks[i++] });
                        return new Promise((resolve) => {
                            pendingResolve = resolve;
                            pendingTimer = setTimeout(() => {
                                pendingResolve = null; pendingTimer = null;
                                resolve({ done: false, value: pingChunk });
                            }, pingIntervalMs);
                            pendingTimer.unref?.();
                        });
                    },
                    cancel() {
                        cancelled = true;
                        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
                        if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r({ done: true, value: undefined }); }
                        return Promise.resolve();
                    },
                    releaseLock() {},
                };
            },
        },
    };
}

test('(a2) delta-then-NAMED-ping-only wedge → semantic idle abort still fires', async () => {
    const realEvents = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    ];
    // Window 120ms, NAMED pings every 30ms. If a parsed `event: ping` reset the
    // timer it would never fire; the abort firing proves named pings are ignored.
    const state = { semanticIdleTimeoutMs: 120, firstMessageTimeoutMs: 60_000 };
    const started = Date.now();
    await assert.rejects(
        anthropicParseSSEStream(
            namedPingWedgeResponse(realEvents, { pingIntervalMs: 30 }),
            null, () => {}, () => {}, () => {}, state, () => {}, null,
        ),
        (err) => {
            assert.equal(err.name, 'StreamStalledError');
            assert.equal(err.code, 'ESTREAMSTALL');
            return true;
        },
    );
    assert.ok(Date.now() - started < 3_000, 'named-ping wedge must abort near the window');
});

test('(c) named abort → terminal stream failure (transient/notify), not a user cancel', () => {
    const err = streamStalledError('Anthropic OAuth SSE', 120_000);
    // classifyError routes ESTREAMSTALL as transient → withRetry / owner-notify
    // path treats it as a terminal stream failure, never as a silent success.
    assert.equal(classifyError(err), 'transient');
    // The SSE mid-stream classifier recognizes the named stall via its name/
    // code/streamStalled flag and routes it to the dedicated `stream_stalled`
    // bucket (not the generic text-matched `sse_idle_timeout`).
    const midState = { sawMessageStart: true, sawCompleted: false, attemptIndex: 0 };
    assert.equal(_classifyMidstreamError(err, midState), 'stream_stalled');
    // It is NOT a user cancel: distinct name from the abort-reason names the
    // providers treat as watchdog/user aborts, and it carries no signal.aborted.
    assert.notEqual(err.name, 'AbortError');
    assert.equal(err.streamStalled, true);
});

// Double-dispatch guard: a stall AFTER a tool call was emitted must be
// unsafe-to-retry (withRetry throws it through) so the side-effecting tool is
// never re-run; a stall BEFORE any emit stays safely retryable.
test('(d) stall after tool emit is unsafe-to-retry; before emit is retryable', () => {
    const afterEmit = streamStalledError('Anthropic OAuth SSE', 120_000, { emittedToolCall: true });
    assert.equal(afterEmit.unsafeToRetry, true);
    // Mid-stream classifier returns null (terminal, no retry) when unsafeToRetry.
    const midState = { sawMessageStart: true, sawCompleted: false, attemptIndex: 0 };
    assert.equal(_classifyMidstreamError(afterEmit, midState), null);

    const beforeEmit = streamStalledError('Anthropic OAuth SSE', 120_000);
    assert.notEqual(beforeEmit.unsafeToRetry, true);
    assert.equal(_classifyMidstreamError(beforeEmit, midState), 'stream_stalled');
});

// Partial-final success recovery: a FINAL no-tool summary stream that wedges
// (ping-only) after message_start must throw a StreamStalledError that CARRIES
// the streamed partial text + pendingToolUse=false, so the agent loop can
// accept it as a successful partial-final instead of losing the summary.
test('(e) final no-tool summary wedge → stall error carries partial text, no pending tool', async () => {
    const realEvents = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial summary so far' } },
    ];
    const state = { semanticIdleTimeoutMs: 120, firstMessageTimeoutMs: 60_000 };
    const rejected = await anthropicParseSSEStream(
        pingWedgeResponse(realEvents, { pingIntervalMs: 30 }),
        null, () => {}, () => {}, () => {}, state, () => {}, null,
    ).then(() => null, (e) => e);
    assert.ok(rejected, 'expected the wedge to reject');
    assert.equal(rejected.name, 'StreamStalledError');
    // No tool was involved → recoverable as partial-final success by the loop.
    assert.equal(rejected.pendingToolUse, false);
    assert.notEqual(rejected.unsafeToRetry, true);
    assert.equal(typeof rejected.partialContent, 'string');
    assert.equal(rejected.partialContent, 'partial summary so far');
    assert.ok(!(Array.isArray(rejected.partialToolCalls) && rejected.partialToolCalls.length > 0));
});
