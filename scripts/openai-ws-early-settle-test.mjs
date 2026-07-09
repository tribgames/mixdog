// Regression: OpenAI OAuth WS early tool-call settle.
//
// A tool-call response can be fully formed (function_call_arguments.done +
// output_item.done) yet the server never emits the terminal
// response.completed/response.done frame. Before the fix _streamResponse
// coasted on that silence until a stall error (gated out of the loop via
// pendingToolUse) or the 30-min agent watchdog, and -- because the socket was
// still pooled -- the missing terminal frame later leaked onto the NEXT request
// as orphan bytes (http_status=0 wedge). The fix resolves early with the
// captured tool call and flags `closeSocket` so the pool discards the socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { _streamResponse } from '../src/runtime/agent/orchestrator/providers/openai-ws-stream.mjs';

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
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', name: 'explore', call_id: 'call_1' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"query"' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"query":"x"}', call_id: 'call_1', name: 'explore' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', name: 'explore', call_id: 'call_1', arguments: '{"query":"x"}' } },
];

test('ws early settle: complete tool call resolves without response.completed and flags closeSocket', async () => {
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
    const result = await p;
    assert.equal(result.closeSocket, true, 'socket must be dropped, not pooled');
    assert.ok(Array.isArray(result.toolCalls) && result.toolCalls.length === 1);
    assert.equal(result.toolCalls[0].id, 'call_1');
    assert.equal(result.toolCalls[0].name, 'explore');
    assert.deepEqual(result.toolCalls[0].arguments, { query: 'x' });
    assert.equal(emitted.length, 1, 'tool call dispatched exactly once');
    assert.equal(state.wsEarlySettle, 'inter_chunk');
    assert.ok(socket.closed, 'socket.close() invoked so it is never reused');
});

test('ws early settle: normal response.completed path keeps the socket (no closeSocket)', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        ...TOOL_CALL_EVENTS,
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                model: 'gpt-5.5',
                output: [{ type: 'function_call', id: 'fc_1', name: 'explore', call_id: 'call_1', arguments: '{"query":"x"}' }],
            },
        },
    ]);
    const result = await p;
    assert.equal(result.closeSocket, undefined, 'normal completion must not mark closeSocket');
    assert.equal(result.toolCalls.length, 1);
});

test('ws early settle: deferred salvage still pending does NOT early-settle (fails as stall)', async () => {
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

test('ws early settle: complete tool then partial second tool does NOT early-settle', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        ...TOOL_CALL_EVENTS,
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_2', name: 'grep', call_id: 'call_2' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"pattern"' },
    ]);
    await assert.rejects(p, /inter-chunk inactivity/);
    assert.equal(socket.closed?.reason, 'inter_chunk_timeout', 'partial second tool must use stall path, not early settle');
});

test('ws early settle: complete tool_search_call clears in-flight and can early-settle', async () => {
    const socket = new FakeSocket();
    const state = {};
    const p = _streamResponse({ entry: { socket }, state, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.output_item.added', item: { type: 'tool_search_call', id: 'ts_1' } },
        { type: 'response.output_item.done', item: { type: 'tool_search_call', id: 'ts_1', arguments: '{"query":"fetch"}' } },
    ]);
    const result = await p;
    assert.equal(result.closeSocket, true);
    assert.equal(result.toolCalls[0].id, 'ts_1');
    assert.equal(result.toolCalls[0].name, 'load_tool');
    assert.deepEqual(result.toolCalls[0].arguments, { query: 'fetch' });
    assert.equal(state.wsEarlySettle, 'inter_chunk');
});

test('ws early settle: complete tool_search_call plus partial custom tool does NOT early-settle', async () => {
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

test('ws early settle: output_item.done salvages deferred function_call and can early-settle', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_salvage', delta: '{"query"' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_salvage', arguments: '{"query":"x"}' },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_salvage', name: 'explore', call_id: 'call_salvage', arguments: '{"query":"x"}' } },
    ]);
    const result = await p;
    assert.equal(result.closeSocket, true);
    assert.equal(result.toolCalls[0].id, 'call_salvage');
    assert.equal(result.toolCalls[0].name, 'explore');
    assert.deepEqual(result.toolCalls[0].arguments, { query: 'x' });
});

test('ws early settle: call_id-only tool_search done clears id-tracked active item', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.output_item.added', item: { type: 'tool_search_call', id: 'ts_added', call_id: 'ts_call' } },
        { type: 'response.output_item.done', item: { type: 'tool_search_call', call_id: 'ts_call', arguments: '{"query":"fetch"}' } },
    ]);
    const result = await p;
    assert.equal(result.closeSocket, true);
    assert.equal(result.toolCalls[0].id, 'ts_call');
});

test('ws early settle: function args.done without item.done does NOT early-settle', async () => {
    const socket = new FakeSocket();
    const p = _streamResponse({ entry: { socket }, state: {}, _timeouts: FAST_TIMEOUTS });
    socket.feed([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_empty', name: 'explore', call_id: 'call_empty' } },
        { type: 'response.function_call_arguments.done', item_id: 'fc_empty', arguments: '{}', call_id: 'call_empty', name: 'explore' },
    ]);
    await assert.rejects(p, /inter-chunk inactivity/);
    assert.equal(socket.closed?.reason, 'inter_chunk_timeout', 'function item must stay active until output_item.done');
});
