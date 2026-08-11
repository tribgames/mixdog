// Regression: OpenAI Responses WS requires the REAL terminal frame.
//
// A tool-call response can be fully formed (function_call_arguments.done +
// output_item.done) yet the server never emits response.completed/
// response.done. The transport must NOT synthesize a completion for it: the
// stream ends as an explicit continuation (stall) carrying the streamed
// partial state, and the session loop decides what to do with it (partial
// tool-call recovery). `sawCompleted` stays false, so nothing downstream can
// mistake the turn for a terminal one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { _streamResponse } from '../src/runtime/agent/orchestrator/providers/openai-ws-stream.mjs';
import { classifyMidstreamError, MIDSTREAM_RETRY_POLICY } from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';
import { readStreamOutcome } from '../src/runtime/agent/orchestrator/providers/lib/stream-outcome.mjs';

// Minimal fake WS: matches the .on/.off/.close/.ping surface _streamResponse
// uses. close() is a no-op here -- the early-settle path sets done=true before
// calling it, so the real closeHandler would short-circuit anyway.
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

const FAST_TIMEOUTS = { interChunkMs: 40, preResponseCreatedMs: 5000, firstMeaningfulMs: 5000 };

const TOOL_CALL_EVENTS = [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', name: 'read', call_id: 'call_1' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"query"' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"path":"x"}', call_id: 'call_1', name: 'read' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', name: 'read', call_id: 'call_1', arguments: '{"path":"x"}' } },
];

test('ws terminal frame: a complete tool call without response.completed never completes the turn', async () => {
    const socket = new FakeSocket();
    const state = {};
    const emitted = [];
    const p = _streamResponse({
        entry: { socket },
        state,
        onToolCall: (c) => emitted.push(c),
        _timeouts: FAST_TIMEOUTS,
    });
    socket.feed(TOOL_CALL_EVENTS);
    const error = await p.then(() => null, (e) => e);
    assert.ok(error, 'no terminal frame means no success');
    assert.notEqual(state.sawCompleted, true, 'completion is never synthesized');
    assert.equal(state.wsEarlySettle, undefined);
    assert.equal(emitted.length, 1, 'tool call dispatched exactly once, while streaming');
    // The streamed partial rides the error so the loop can finalize it as an
    // explicit tool-call turn (send-with-recovery), not as a provider success.
    assert.equal(error.partialToolCalls?.length, 1);
    assert.equal(error.partialToolCalls[0].id, 'call_1');
    assert.equal(error.partialToolCalls[0].name, 'read');
    assert.deepEqual(error.partialToolCalls[0].arguments, { path: 'x' });
    assert.equal(error.pendingToolUse, false, 'the tool input finished streaming');
    const outcome = readStreamOutcome(error);
    assert.equal(outcome.terminalObserved, false);
    assert.equal(outcome.continuation, true);
    assert.equal(outcome.successEligible, false);
    assert.equal(outcome.sideEffectDispatched, true, 'the dispatched call blocks a replay');
    assert.equal(outcome.replaySafe, false);
    assert.ok(socket.closed, 'socket.close() invoked so it is never reused');
});

test('ws terminal frame: the real response.completed path still succeeds', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        ...TOOL_CALL_EVENTS,
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                model: 'gpt-5.5',
                output: [{ type: 'function_call', id: 'fc_1', name: 'read', call_id: 'call_1', arguments: '{"path":"x"}' }],
            },
        },
    ]);
    const result = await p;
    assert.equal(result.closeSocket, undefined, 'normal completion must not mark closeSocket');
    assert.equal(result.toolCalls.length, 1);
});

test('ws terminal frame: a deferred salvage placeholder fails as a stall', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    // No output_item.added -> pendingCalls empty; args.done carries no call_id/name
    // -> a deferred placeholder that only response.completed could salvage.
    socket.feed([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"query"' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"query":"x"}' },
    ]);
    await assert.rejects(p, /inter-chunk inactivity/);
});

test('ws terminal frame: a partial second tool keeps the turn pending', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        ...TOOL_CALL_EVENTS,
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_2', name: 'grep', call_id: 'call_2' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"pattern"' },
    ]);
    const error = await p.then(() => null, (e) => e);
    assert.match(error.message, /inter-chunk inactivity/);
    assert.equal(error.pendingToolUse, true, 'the second tool input never finished');
    assert.equal(socket.closed?.reason, 'inter_chunk_timeout');
});

test('ws terminal frame: a complete tool_search_call still needs the terminal frame', async () => {
    const socket = new FakeSocket();
    const state = {};
    const p = _streamResponse({ entry: { socket }, state, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.output_item.added', item: { type: 'tool_search_call', id: 'ts_1' } },
        { type: 'response.output_item.done', item: { type: 'tool_search_call', id: 'ts_1', arguments: '{"query":"fetch"}' } },
    ]);
    const error = await p.then(() => null, (e) => e);
    assert.ok(error);
    assert.notEqual(state.sawCompleted, true);
    assert.equal(error.partialToolCalls[0].id, 'ts_1');
    assert.equal(error.partialToolCalls[0].name, 'load_tool');
    assert.deepEqual(error.partialToolCalls[0].arguments, { query: 'fetch' });
    assert.equal(error.pendingToolUse, false);
});

test('ws terminal frame: a partial custom tool keeps the turn pending', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.output_item.added', item: { type: 'tool_search_call', id: 'ts_1' } },
        { type: 'response.output_item.done', item: { type: 'tool_search_call', id: 'ts_1', arguments: '{"query":"fetch"}' } },
        { type: 'response.output_item.added', item: { type: 'custom_tool_call', id: 'ct_2', call_id: 'call_custom_2', name: 'apply_patch' } },
        { type: 'response.custom_tool_call_input.delta', item_id: 'ct_2', delta: '*** Begin Patch' },
    ]);
    await assert.rejects(p, /inter-chunk inactivity/);
    assert.equal(socket.closed?.reason, 'inter_chunk_timeout', 'partial custom tool must keep stall path');
});

test('ws terminal frame: output_item.done salvages a deferred function_call into the partial', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_salvage', delta: '{"query"' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_salvage', arguments: '{"query":"x"}' },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_salvage', name: 'read', call_id: 'call_salvage', arguments: '{"path":"x"}' } },
    ]);
    const error = await p.then(() => null, (e) => e);
    assert.ok(error);
    assert.equal(error.partialToolCalls[0].id, 'call_salvage');
    assert.equal(error.partialToolCalls[0].name, 'read');
    assert.deepEqual(error.partialToolCalls[0].arguments, { query: 'x' });
});

test('ws terminal frame: call_id-only tool_search done clears the id-tracked active item', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.output_item.added', item: { type: 'tool_search_call', id: 'ts_added', call_id: 'ts_call' } },
        { type: 'response.output_item.done', item: { type: 'tool_search_call', call_id: 'ts_call', arguments: '{"query":"fetch"}' } },
    ]);
    const error = await p.then(() => null, (e) => e);
    assert.ok(error);
    assert.equal(error.partialToolCalls[0].id, 'ts_call');
    assert.equal(error.pendingToolUse, false, 'the active item was cleared by output_item.done');
});

test('ws terminal frame: function args.done without item.done stays pending', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_empty', name: 'read', call_id: 'call_empty' } },
        { type: 'response.function_call_arguments.done', item_id: 'fc_empty', arguments: '{}', call_id: 'call_empty', name: 'read' },
    ]);
    const error = await p.then(() => null, (e) => e);
    assert.match(error.message, /inter-chunk inactivity/);
    assert.equal(error.pendingToolUse, true, 'function item stays active until output_item.done');
    assert.equal(socket.closed?.reason, 'inter_chunk_timeout');
});

test('OpenAI WS rejects an oversized Buffer before UTF-8 conversion and marks it retryable', async () => {
    const socket = new FakeSocket();
    const state = { attemptIndex: 0 };
    const payload = Buffer.alloc(33);
    payload.toString = () => { throw new Error('oversized Buffer was decoded'); };
    const p = _streamResponse({
        entry: { socket },
        state,
        _timeouts: { ...FAST_TIMEOUTS, maxIncomingFrameBytes: 32 },
    });
    socket.emit('message', payload);
    await assert.rejects(p, (error) => {
        assert.equal(error.code, 'EOPENAIWSFRAMETOOLARGE');
        assert.equal(error.retryable, true);
        assert.match(error.message, /33 bytes; limit 32 bytes.*retryable/);
        assert.equal(
            classifyMidstreamError(error, state, MIDSTREAM_RETRY_POLICY.ws),
            'ws_frame_too_large',
        );
        return true;
    });
    assert.deepEqual(socket.closed, { code: 1009, reason: 'frame_too_large' });
});

test('OpenAI WS preserves normal-size Buffer handling', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({
        entry: { socket },
        state: {},
        _timeouts: { ...FAST_TIMEOUTS, maxIncomingFrameBytes: 1024 },
    });
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_normal', model: 'gpt-5.5', output: [] },
    })));
    const result = await p;
    assert.equal(result.responseId, 'resp_normal');
});
test('xAI WS uses the same pre-decode receive limit', async () => {
    const socket = new FakeSocket();
    const state = { attemptIndex: 0 };
    const p = _streamResponse({
        entry: { socket },
        state,
        traceProvider: 'xai',
        _timeouts: { ...FAST_TIMEOUTS, maxIncomingFrameBytes: 32 },
    });
    socket.emit('message', Buffer.alloc(33));
    await assert.rejects(p, (error) => {
        assert.equal(error.code, 'EOPENAIWSFRAMETOOLARGE');
        assert.equal(error.wsFrameTooLarge, true);
        return true;
    });
});

test('ws maxPayload typed errors preserve frame-too-large retry classification', async () => {
    const socket = new FakeSocket();
    const state = { attemptIndex: 0 };
    const p = _streamResponse({
        entry: { socket },
        state,
        _timeouts: FAST_TIMEOUTS,
    });
    socket.emit('error', Object.assign(
        new RangeError('Max payload size exceeded'),
        { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' },
    ));
    await assert.rejects(p, (error) => {
        assert.equal(error.wsFrameTooLarge, true);
        assert.equal(error.retryable, true);
        assert.equal(
            classifyMidstreamError(error, state, MIDSTREAM_RETRY_POLICY.ws),
            'ws_frame_too_large',
        );
        return true;
    });
});
