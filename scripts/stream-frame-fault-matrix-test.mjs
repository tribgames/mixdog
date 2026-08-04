#!/usr/bin/env node
// FRAME-LEVEL fault matrix over externally observable stream outcomes.
//
// Model-based: every row is a scripted SSE frame sequence (the model) plus the
// externally observable outcome it must produce. Nothing here depends on
// unfinished implementation internals — the only seam used is the public
// Anthropic SSE parser already exercised by scripts/provider-stream-stall-test.mjs.
//
// Invariants asserted for every row:
//   1. EXACTLY ONE terminal outcome — success and failure are mutually
//      exclusive, and the parser stops CONSUMING frames at its terminal, so a
//      duplicate/late frame can neither be processed nor add a second outcome.
//      This is measured by observable side effects (frames pulled from the
//      body, callbacks fired after the terminal), never by counting promise
//      settlements, which a promise guarantees on its own.
//   2. AT-MOST-ONCE tool dispatch — a duplicated or post-terminal tool_use block
//      never dispatches the same call twice.
//   3. NO PARTIAL-SUCCESS PROMOTION — a truncated stream (EOF before terminal)
//      or a tool_use whose input never completed is a terminal FAILURE, never a
//      success carrying partial content.
//   4. UI PARITY — the text handed to the UI (onTextDelta) equals the text the
//      parser accumulated for history on the success path, and post-terminal
//      text reaches neither.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSSEStream } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';

const encoder = new TextEncoder();
const encodeFrame = (event) => encoder.encode(
    `event: ${event.type || 'message'}\ndata: ${JSON.stringify(event)}\n\n`,
);

// Frame vocabulary of the model. Rows compose these; no timing is involved, so
// every row is fully deterministic.
const F = {
    start: () => ({ type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 1 } } }),
    textStart: (index = 0) => ({ type: 'content_block_start', index, content_block: { type: 'text' } }),
    text: (text, index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }),
    blockStop: (index = 0) => ({ type: 'content_block_stop', index }),
    toolStart: (index, id, name) => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } }),
    toolArgs: (index, partialJson) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partialJson } }),
    messageDelta: (stopReason) => ({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } }),
    stop: () => ({ type: 'message_stop' }),
    error: () => ({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
};

// Response-like shape that replays `frames` one chunk at a time and then hits
// EOF. `signal` models a mid-stream client abort: once aborted, the next read
// rejects exactly like a cancelled body would.
function scriptedStream(frames, { signal = null, onDelivered = null } = {}) {
    const chunks = frames.map(encodeFrame);
    let index = 0;
    return {
        body: {
            getReader() {
                return {
                    async read() {
                        if (signal?.aborted) throw signal.reason;
                        if (index >= chunks.length) return { done: true, value: undefined };
                        const value = chunks[index++];
                        onDelivered?.(index);
                        return { done: false, value };
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}

async function runFrames(frames, { signal = null, onDelivered = null } = {}) {
    const state = {};
    const uiText = [];
    const dispatched = [];
    // Observable post-terminal activity. `state.sawCompleted` is set by the
    // parser the moment it accepts a terminal frame, so any callback that runs
    // afterwards is late/duplicate frame processing.
    let delivered = 0;
    let postTerminalUi = 0;
    let postTerminalDispatch = 0;
    let postTerminalReads = 0;
    const trackDelivery = (count) => {
        delivered = count;
        if (state.sawCompleted === true) postTerminalReads += 1;
        onDelivered?.(count);
    };
    let result = null;
    let error = null;
    try {
        result = await parseSSEStream(
            scriptedStream(frames, { signal, onDelivered: trackDelivery }),
            signal,
            () => {},
            () => {},
            (call) => {
                if (state.sawCompleted === true) postTerminalDispatch += 1;
                dispatched.push(call);
            },
            state,
            (chunk) => {
                if (state.sawCompleted === true) postTerminalUi += 1;
                uiText.push(chunk);
            },
            null,
        );
    } catch (err) {
        error = err;
    }
    return {
        state,
        uiText: uiText.join(''),
        dispatched,
        result,
        error,
        delivered,
        postTerminalUi,
        postTerminalDispatch,
        postTerminalReads,
        outcome: error ? 'failure' : 'success',
    };
}

// ── Fault matrix ──────────────────────────────────────────────────────────
// Each row: scripted frames + the ONE observable outcome the contract allows.
const MATRIX = [
    {
        name: 'clean terminal',
        frames: [F.start(), F.textStart(), F.text('ok'), F.blockStop(), F.messageDelta('end_turn'), F.stop()],
        expect: { outcome: 'success', content: 'ok', uiText: 'ok', dispatched: 0, completed: true, consumed: 6 },
    },
    {
        name: 'duplicate terminal frames',
        frames: [
            F.start(), F.textStart(), F.text('ok'), F.blockStop(), F.messageDelta('end_turn'),
            F.stop(), F.text('ghost after terminal'), F.stop(),
        ],
        // Consumption stops at the first terminal: the ghost delta and the
        // second message_stop are never even read from the body.
        expect: { outcome: 'success', content: 'ok', uiText: 'ok', dispatched: 0, completed: true, consumed: 6 },
    },
    {
        name: 'tool_use frame arriving after the terminal frame',
        frames: [
            F.start(), F.textStart(), F.text('ok'), F.stop(),
            F.toolStart(1, 'toolu_late', 'read'), F.toolArgs(1, '{"path":"p"}'), F.blockStop(1),
            F.messageDelta('tool_use'), F.stop(),
        ],
        expect: { outcome: 'success', content: 'ok', uiText: 'ok', dispatched: 0, toolCalls: 0, completed: true, consumed: 4 },
    },
    {
        name: 'out-of-order block frames (delta before start, stop for an unopened block)',
        frames: [
            F.start(), F.text('early'), F.textStart(0), F.blockStop(9), F.text(' late'),
            F.messageDelta('end_turn'), F.stop(),
        ],
        expect: { outcome: 'success', content: 'early late', uiText: 'early late', dispatched: 0, completed: true, consumed: 7 },
    },
    {
        name: 'stream close before terminal with partial text',
        frames: [F.start(), F.textStart(), F.text('partial summary')],
        expect: {
            outcome: 'failure', uiText: 'partial summary', dispatched: 0, completed: false,
            errorName: 'TruncatedStreamError', errorCode: 'TRUNCATED_STREAM', pendingToolUse: false,
            consumed: 3,
        },
    },
    {
        name: 'stream close before terminal with a partial tool call',
        frames: [F.start(), F.toolStart(0, 'toolu_partial', 'shell'), F.toolArgs(0, '{"command":"ec')],
        expect: {
            outcome: 'failure', uiText: '', dispatched: 0, completed: false,
            errorName: 'TruncatedStreamError', errorCode: 'TRUNCATED_STREAM', pendingToolUse: true,
            consumed: 3,
        },
    },
    {
        name: 'duplicate complete tool calls',
        frames: [
            F.start(),
            F.toolStart(0, 'toolu_a', 'read'), F.toolArgs(0, '{"path":"p"}'), F.blockStop(0),
            F.toolStart(1, 'toolu_b', 'read'), F.toolArgs(1, '{"path":"p"}'), F.blockStop(1),
            F.messageDelta('tool_use'),
        ],
        expect: { outcome: 'success', content: '', uiText: '', dispatched: 1, toolCalls: 1, completed: true, consumed: 8 },
    },
    {
        name: 'provider error frame after partial text',
        frames: [F.start(), F.textStart(), F.text('half'), F.error()],
        expect: {
            outcome: 'failure', uiText: 'half', dispatched: 0, completed: false,
            errorCode: 'EANTHROPIC_SSE_ERROR', consumed: 4,
        },
    },
];

for (const row of MATRIX) {
    test(`frame matrix — ${row.name}`, async () => {
        const observed = await runFrames(row.frames);

        // (1) exactly one terminal outcome — success and failure are mutually
        // exclusive, and nothing is processed after the terminal.
        assert.equal(observed.outcome, row.expect.outcome);
        assert.equal(
            (observed.result === null) !== (observed.error === null),
            true,
            'exactly one of result/error may be produced',
        );
        assert.equal(observed.delivered, row.expect.consumed,
            'the parser must stop consuming frames at its terminal');
        assert.equal(observed.postTerminalReads, 0, 'no frame may be read after the terminal');
        assert.equal(observed.postTerminalUi, 0, 'no UI text may be emitted after the terminal');
        assert.equal(observed.postTerminalDispatch, 0, 'no tool may be dispatched after the terminal');
        if (row.expect.outcome === 'success') {
            assert.ok(observed.result, 'a success outcome must carry a result');
            assert.equal(observed.error, null);
            assert.equal(observed.result.content, row.expect.content);
            // (4) UI parity — what the UI saw is what history gets
            assert.equal(observed.uiText, observed.result.content);
        } else {
            assert.equal(observed.result, null, 'a failed stream must not also produce a result');
            assert.ok(observed.error, 'a failure outcome must carry an error');
            if (row.expect.errorName) assert.equal(observed.error.name, row.expect.errorName);
            if (row.expect.errorCode) assert.equal(observed.error.code, row.expect.errorCode);
            // (3) no partial-success promotion
            if (Object.hasOwn(row.expect, 'pendingToolUse')) {
                assert.equal(observed.error.pendingToolUse, row.expect.pendingToolUse);
            }
        }
        // (4) UI parity, including the failure path
        assert.equal(observed.uiText, row.expect.uiText);
        // (2) at-most-once tool dispatch
        assert.equal(observed.dispatched.length, row.expect.dispatched);
        if (Object.hasOwn(row.expect, 'toolCalls')) {
            assert.equal(observed.result?.toolCalls?.length ?? 0, row.expect.toolCalls);
        }
        const ids = observed.dispatched.map((call) => call.id);
        assert.equal(new Set(ids).size, ids.length, 'no tool id may be dispatched twice');
        assert.equal(observed.state.sawCompleted === true, row.expect.completed);
    });
}

// ── Row: terminal frame while a tool_use input is still incomplete. A
// `message_stop` arriving while `pendingToolInputs` is non-empty means the
// model's tool arguments were never completed, so nothing about that turn is
// finished: it must be a terminal FAILURE carrying pendingToolUse, with zero
// dispatch — never a success with empty content (partial-success promotion).
test('frame matrix — terminal frame while a tool_use input is still incomplete', async () => {
    const observed = await runFrames([
        F.start(), F.toolStart(0, 'toolu_pending', 'read'), F.toolArgs(0, '{"path":'),
        F.messageDelta('tool_use'), F.stop(),
    ]);

    assert.equal(observed.outcome, 'failure', 'an incomplete tool_use input must not end in success');
    assert.equal(observed.result, null, 'no partial-success promotion');
    assert.equal(observed.error?.pendingToolUse, true);
    assert.equal(observed.dispatched.length, 0, 'an incomplete tool call must never dispatch');
    assert.equal(observed.postTerminalDispatch, 0);
    assert.equal(observed.postTerminalUi, 0);
});

test('frame matrix — abort mid-stream produces one terminal failure and no tool dispatch', async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('canary cancel'), { name: 'AbortError' });
    const frames = [
        F.start(), F.textStart(), F.text('partial before abort'),
        F.toolStart(1, 'toolu_after_abort', 'read'), F.toolArgs(1, '{"path":"p"}'), F.blockStop(1),
        F.messageDelta('tool_use'), F.stop(),
    ];
    const observed = await runFrames(frames, {
        signal: controller.signal,
        onDelivered: (delivered) => { if (delivered === 3) controller.abort(reason); },
    });

    assert.equal(observed.outcome, 'failure');
    assert.equal(observed.result, null, 'an aborted stream must never be promoted to success');
    assert.equal(observed.error, reason, 'the abort reason is the single terminal outcome');
    assert.equal(observed.uiText, 'partial before abort');
    assert.equal(observed.dispatched.length, 0, 'no tool may be dispatched after the abort');
    // The abort stops consumption: the tool frames behind it are never read,
    // so no late frame can produce a second outcome or a dispatch.
    assert.equal(observed.delivered, 3);
    assert.equal(observed.postTerminalReads, 0);
    assert.equal(observed.postTerminalUi, 0);
    assert.equal(observed.postTerminalDispatch, 0);
    assert.equal(observed.state.sawCompleted === true, false);
});
