// Regression: wire-level `end_turn` passthrough on OpenAI Responses terminal
// frames, for both openai-oauth transports.
//
// codex-rs keeps `end_turn` structurally from the wire
// (codex-api/src/sse/responses.rs ResponseCompleted.end_turn: Option<bool>,
// consumed in core/src/session/turn.rs:2299). Our adapters previously dropped
// it, so a server that explicitly said "this turn is not finished" looked
// identical to a normal completion. These tests pin:
//   - response.completed / response.done(status completed|absent) carrying
//     end_turn:true|false surface a normalized boolean `endTurn`,
//   - a terminal frame WITHOUT the field leaves `endTurn` undefined (absence
//     is preserved, never coerced to false),
//   - non-boolean junk is ignored, and
//   - tool-call salvage / stopReason / early-settle semantics are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { _streamResponse } from '../src/runtime/agent/orchestrator/providers/openai-ws-stream.mjs';
import { sendViaHttpSse } from '../src/runtime/agent/orchestrator/providers/openai-oauth-http-sse.mjs';

// --- WS rig (mirrors scripts/openai-ws-early-settle-test.mjs) --------------
class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
        this.closed = null;
    }
    close(code, reason) { this.closed = { code, reason }; }
    ping() {}
    feed(events) { for (const e of events) this.emit('message', JSON.stringify(e)); }
}

const FAST_TIMEOUTS = { interChunkMs: 200, preResponseCreatedMs: 5000, firstMeaningfulMs: 5000 };

function wsStream(events) {
    const socket = new FakeSocket();
    const emitted = [];
    const p = _streamResponse({
        entry: { socket },
        state: {},
        onToolCall: (c) => emitted.push(c),
        _timeouts: FAST_TIMEOUTS,
    });
    socket.feed(events);
    return { promise: p, socket, emitted };
}

const WS_TEXT_PREFIX = [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
    { type: 'response.output_text.delta', delta: 'hi' },
];

// --- HTTP/SSE rig (mirrors scripts/provider-toolcall-test.mjs) -------------
function httpSseResponse(events) {
    const encoder = new TextEncoder();
    const chunks = events.map((e) => encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    let i = 0;
    return {
        status: 200,
        ok: true,
        headers: new Map(),
        body: {
            getReader() {
                return {
                    read() {
                        return i < chunks.length
                            ? Promise.resolve({ done: false, value: chunks[i++] })
                            : Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}

function sseSend(events, onToolCall) {
    return sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'k' },
        body: { model: 'gpt', tools: [] },
        useModel: 'gpt',
        onToolCall,
        fetchFn: async () => httpSseResponse(events),
    });
}

const SSE_TEXT_PREFIX = [
    { type: 'response.created', response: { id: 'r', model: 'gpt' } },
    { type: 'response.output_text.delta', delta: 'hi' },
];

// === WebSocket transport ===================================================

test('ws end_turn: response.completed end_turn:false surfaces endTurn=false', async () => {
    const { promise } = wsStream([
        ...WS_TEXT_PREFIX,
        { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.5', end_turn: false, output: [] } },
    ]);
    const result = await promise;
    assert.equal(result.endTurn, false);
    assert.equal(result.content, 'hi');
});

test('ws end_turn: response.completed end_turn:true surfaces endTurn=true', async () => {
    const { promise } = wsStream([
        ...WS_TEXT_PREFIX,
        { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.5', end_turn: true, output: [] } },
    ]);
    assert.equal((await promise).endTurn, true);
});

test('ws end_turn: absent field stays undefined (never coerced to false)', async () => {
    const { promise } = wsStream([
        ...WS_TEXT_PREFIX,
        { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.5', output: [] } },
    ]);
    const result = await promise;
    assert.equal(result.endTurn, undefined);
    assert.equal(Object.hasOwn(result, 'endTurn'), false);
});

test('ws end_turn: non-boolean wire value is ignored', async () => {
    const { promise } = wsStream([
        ...WS_TEXT_PREFIX,
        { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.5', end_turn: 'false', output: [] } },
    ]);
    assert.equal((await promise).endTurn, undefined);
});

test('ws end_turn: response.done success frame carries end_turn', async () => {
    const { promise } = wsStream([
        ...WS_TEXT_PREFIX,
        { type: 'response.done', response: { id: 'resp_1', status: 'completed', end_turn: false } },
    ]);
    assert.equal((await promise).endTurn, false);

    const bare = wsStream([
        ...WS_TEXT_PREFIX,
        { type: 'response.done', response: { id: 'resp_1', end_turn: true } },
    ]);
    assert.equal((await bare.promise).endTurn, true);
});

test('ws end_turn: tool-call salvage + dispatch semantics unchanged with end_turn present', async () => {
    const { promise, emitted } = wsStream([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"query"' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"query":"x"}' },
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                model: 'gpt-5.5',
                end_turn: false,
                output: [{ type: 'function_call', id: 'fc_1', name: 'explore', call_id: 'call_1', arguments: '{"query":"x"}' }],
            },
        },
    ]);
    const result = await promise;
    assert.equal(result.endTurn, false);
    assert.equal(result.closeSocket, undefined, 'normal completion must not mark closeSocket');
    assert.equal(emitted.length, 1, 'tool call dispatched exactly once');
    assert.equal(result.toolCalls[0].id, 'call_1');
    assert.equal(result.toolCalls[0].name, 'explore');
});

test('ws end_turn: failed salvage still errors (end_turn must not mask it)', async () => {
    const { promise } = wsStream([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"query":"x"}' },
        { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.5', end_turn: true, output: [] } },
    ]);
    await assert.rejects(promise, /function_call salvage failed/);
});

test('ws end_turn: incomplete max_output_tokens keeps length stopReason and no endTurn', async () => {
    const { promise } = wsStream([
        ...WS_TEXT_PREFIX,
        { type: 'response.incomplete', response: { id: 'resp_1', incomplete_details: { reason: 'max_output_tokens' } } },
    ]);
    const result = await promise;
    assert.equal(result.stopReason, 'length');
    assert.equal(result.truncated, true);
    assert.equal(result.endTurn, undefined);
});

// === HTTP/SSE transport ====================================================

test('http-sse end_turn: response.completed end_turn:false surfaces endTurn=false', async () => {
    const out = await sseSend([
        ...SSE_TEXT_PREFIX,
        { type: 'response.completed', response: { id: 'r', model: 'gpt', end_turn: false, output: [] } },
    ]);
    assert.equal(out.endTurn, false);
    assert.equal(out.content, 'hi');
});

test('http-sse end_turn: response.completed end_turn:true surfaces endTurn=true', async () => {
    const out = await sseSend([
        ...SSE_TEXT_PREFIX,
        { type: 'response.completed', response: { id: 'r', model: 'gpt', end_turn: true, output: [] } },
    ]);
    assert.equal(out.endTurn, true);
});

test('http-sse end_turn: absent field stays undefined (never coerced to false)', async () => {
    const out = await sseSend([
        ...SSE_TEXT_PREFIX,
        { type: 'response.completed', response: { id: 'r', model: 'gpt', output: [] } },
    ]);
    assert.equal(out.endTurn, undefined);
    assert.equal(Object.hasOwn(out, 'endTurn'), false);
});

test('http-sse end_turn: non-boolean wire value is ignored', async () => {
    const out = await sseSend([
        ...SSE_TEXT_PREFIX,
        { type: 'response.completed', response: { id: 'r', model: 'gpt', end_turn: 1, output: [] } },
    ]);
    assert.equal(out.endTurn, undefined);
});

test('http-sse end_turn: response.done success frame carries end_turn', async () => {
    const withStatus = await sseSend([
        ...SSE_TEXT_PREFIX,
        { type: 'response.done', response: { id: 'r', status: 'completed', end_turn: false } },
    ]);
    assert.equal(withStatus.endTurn, false);

    const bare = await sseSend([
        ...SSE_TEXT_PREFIX,
        { type: 'response.done', end_turn: true },
    ]);
    assert.equal(bare.endTurn, true);
});

test('http-sse end_turn: tool-call single-emit semantics unchanged with end_turn present', async () => {
    const emitted = [];
    const out = await sseSend([
        { type: 'response.created', response: { id: 'r', model: 'gpt' } },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fi_1', name: 'read', call_id: 'fc_1' } },
        { type: 'response.function_call_arguments.done', item_id: 'fi_1', arguments: '{"path":"a"}' },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fi_1', call_id: 'fc_1', name: 'read', arguments: '{"path":"a"}' } },
        {
            type: 'response.completed',
            response: {
                id: 'r',
                model: 'gpt',
                end_turn: false,
                output: [{ type: 'function_call', id: 'fi_1', call_id: 'fc_1', name: 'read', arguments: '{"path":"a"}' }],
            },
        },
    ], (call) => emitted.push(call));
    assert.equal(out.endTurn, false);
    assert.equal(emitted.length, 1, 'tool call dispatched exactly once');
    assert.deepEqual(out.toolCalls, [{ id: 'fc_1', name: 'read', arguments: { path: 'a' } }]);
});

test('http-sse end_turn: response.done failed still throws (end_turn must not mask it)', async () => {
    await assert.rejects(
        sseSend([
            ...SSE_TEXT_PREFIX,
            { type: 'response.done', response: { status: 'failed', end_turn: true, error: { message: 'boom' } } },
        ]),
        /response\.done failed: boom/,
    );
});

test('http-sse end_turn: incomplete max_output_tokens keeps length stopReason and no endTurn', async () => {
    const out = await sseSend([
        ...SSE_TEXT_PREFIX,
        { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    ]);
    assert.equal(out.stopReason, 'length');
    assert.equal(out.truncated, true);
    assert.equal(out.endTurn, undefined);
});
