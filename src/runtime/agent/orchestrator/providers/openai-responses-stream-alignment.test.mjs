import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { _streamResponse } from './openai-ws-stream.mjs';
import { createHttpSseResponseState } from './openai-http-sse-response-state.mjs';
import { convertMessagesToResponsesInput } from './openai-responses-input.mjs';
import { customToolCallFromResponseItem } from './custom-tool-wire.mjs';
import { REFUSAL_STOP_REASON } from './openai-ws-response-state/refusals.mjs';

// First-party Responses stream alignment with the documented event and item
// shapes: max-output cutoffs with tool input in flight, refusals, terminal
// output reconciliation, and tool namespaces.

function runWs(events) {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.close = () => {
    socket.readyState = 3;
  };
  socket.terminate = socket.close;
  const seen = { tools: [], text: [] };
  const pending = _streamResponse({
    entry: { socket, ephemeral: true },
    externalSignal: null,
    onToolCall: (call) => seen.tools.push(call),
    onTextDelta: (chunk) => seen.text.push(chunk),
    state: { sessionId: 'ws-alignment-test' },
    logSuppressedReasoningDeltas: false,
  });
  for (const event of events) socket.emit('message', Buffer.from(JSON.stringify(event)));
  return { pending, seen };
}

function runHttp(events) {
  const seen = { tools: [], text: [] };
  const state = createHttpSseResponseState({
    body: { tools: [] },
    onToolCall: (call) => seen.tools.push(call),
    onTextDelta: (text) => seen.text.push(text),
    meaningful() {},
    onServerEvent() {},
    label: 'test',
  });
  for (const event of events) state.handleEvent(event);
  return { result: () => state.finish({ useModel: 'gpt-fixture', poolKey: 'k', iteration: 0, sseStartedAt: Date.now() }), seen };
}

const created = { type: 'response.created', response: { id: 'resp_1', model: 'gpt-fixture' } };
const usage = { input_tokens: 10, output_tokens: 5 };
const maxOutput = (frame = 'response.incomplete') => ({
  type: frame,
  response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage },
});

test('WS: max_output_tokens with function arguments in flight rejects as a pending-tool cutoff with usage and partial state', async () => {
  for (const frame of ['response.incomplete', 'response.done']) {
    const { pending, seen } = runWs([
      created,
      { type: 'response.output_text.delta', delta: 'calling' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'edit' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":"a' },
      maxOutput(frame),
    ]);
    await assert.rejects(pending, (err) => {
      assert.match(err.message, /max_output_tokens\) with tool call in flight/);
      assert.equal(err.streamStalled, true);
      assert.equal(err.pendingToolUse, true);
      assert.equal(err.incompleteReason, 'max_output_tokens');
      assert.equal(err.partialContent, 'calling');
      assert.equal(err.partialModel, 'gpt-fixture');
      assert.equal(err.partialUsage.inputTokens, 10);
      assert.equal(err.partialUsage.outputTokens, 5);
      return true;
    });
    assert.deepEqual(seen.tools, []);
  }
  // A fully assembled call before the cutoff is not pending: length success.
  const done = { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'read', arguments: '{}' };
  const ok = runWs([
    created,
    { type: 'response.output_item.added', item: done },
    { type: 'response.function_call_arguments.done', item_id: 'fc_2', arguments: '{}' },
    { type: 'response.output_item.done', item: done },
    maxOutput(),
  ]);
  const result = await ok.pending;
  assert.equal(result.stopReason, 'length');
  assert.deepEqual(result.toolCalls, [{ id: 'call_2', name: 'read', arguments: {} }]);
});

const callItem = (n, extra = {}) => ({
  type: 'function_call',
  id: `fc_${n}`,
  call_id: `call_${n}`,
  name: 'read',
  arguments: '{}',
  ...extra,
});
// One complete call, then a second whose arguments are cut off by the limit.
const truncatedBatch = (frame) => [
  created,
  { type: 'response.output_text.delta', delta: 'calling' },
  { type: 'response.output_item.added', item: callItem(1, { arguments: '' }) },
  { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{}' },
  { type: 'response.output_item.done', item: callItem(1) },
  { type: 'response.output_item.added', item: callItem(2, { arguments: '' }) },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"path":"a' },
  maxOutput(frame),
];
const assertTruncatedBatchError = (err) => {
  assert.match(err.message, /max_output_tokens\) with tool call in flight/);
  assert.equal(err.streamStalled, true);
  assert.equal(err.pendingToolUse, true);
  assert.equal(err.incompleteReason, 'max_output_tokens');
  assert.equal(err.partialContent, 'calling');
  assert.equal(err.partialModel, 'gpt-fixture');
  assert.equal(err.partialUsage.inputTokens, 10);
  assert.equal(err.partialUsage.outputTokens, 5);
  // The complete call is carried (and was dispatched) once; the cut one is not.
  assert.deepEqual(
    err.partialToolCalls.map((call) => call.id),
    ['call_1']
  );
  return true;
};

test('WS and HTTP/SSE: a cut tool batch keeps text, usage and the complete calls, dispatching each once', async () => {
  for (const frame of ['response.incomplete', 'response.done']) {
    const ws = runWs(truncatedBatch(frame));
    await assert.rejects(ws.pending, assertTruncatedBatchError);
    assert.deepEqual(
      ws.seen.tools.map((call) => call.id),
      ['call_1']
    );

    const seen = { tools: [] };
    const state = createHttpSseResponseState({
      body: { tools: [] },
      onToolCall: (call) => seen.tools.push(call),
      onTextDelta() {},
      meaningful() {},
      onServerEvent() {},
      label: 'test',
    });
    assert.throws(() => {
      for (const event of truncatedBatch(frame)) state.handleEvent(event);
    }, assertTruncatedBatchError);
    assert.deepEqual(
      seen.tools.map((call) => call.id),
      ['call_1']
    );
  }
});

test('WS and HTTP/SSE: a server-truncated call item is never collected, dispatched or replayed', async () => {
  const cut = callItem(3, { arguments: '{"path":"a', status: 'incomplete' });
  const events = (frame) => [
    created,
    { type: 'response.output_item.added', item: { ...cut, arguments: '' } },
    { type: 'response.output_item.done', item: cut },
    { ...maxOutput(frame), response: { ...maxOutput(frame).response, output: [cut] } },
  ];
  for (const frame of ['response.incomplete', 'response.done']) {
    const ws = runWs(events(frame));
    await assert.rejects(ws.pending, (err) => err.pendingToolUse === true && err.streamStalled === true);
    assert.deepEqual(ws.seen.tools, []);
    assert.throws(() => runHttp(events(frame)), (err) => err.pendingToolUse === true && err.streamStalled === true);
  }
  // Only present in the terminal bundle: still a truncated call, not a success.
  const bundleOnly = runWs([created, { ...maxOutput(), response: { ...maxOutput().response, output: [cut] } }]);
  await assert.rejects(bundleOnly.pending, (err) => err.pendingToolUse === true);
});

test('WS and HTTP/SSE: a text-only max_output_tokens cutoff completes as length with its reason', async () => {
  const frames = [created, { type: 'response.output_text.delta', delta: 'partial' }, maxOutput()];
  const ws = await runWs(frames).pending;
  const http = runHttp(frames).result();
  for (const result of [ws, http]) {
    assert.equal(result.content, 'partial');
    assert.equal(result.stopReason, 'length');
    assert.equal(result.incompleteReason, 'max_output_tokens');
    assert.equal(result.truncated, true);
    assert.equal(result.usage.inputTokens, 10);
  }
});

test('WS and HTTP/SSE: terminal-only message parts are all absorbed; streamed text is not duplicated', async () => {
  const completed = (parts) => ({
    type: 'response.completed',
    response: {
      status: 'completed',
      usage,
      output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: parts.map((text) => ({ type: 'output_text', text })) }],
    },
  });
  const terminalOnly = [created, completed(['first', 'second'])];
  const streamed = [created, { type: 'response.output_text.delta', delta: 'firstsecond' }, completed(['first', 'second'])];
  for (const [frames, expected] of [[terminalOnly, 'firstsecond'], [streamed, 'firstsecond']]) {
    const ws = await runWs(frames).pending;
    const http = runHttp(frames).result();
    assert.equal(ws.content, expected, 'ws');
    assert.equal(http.content, expected, 'http');
  }
});

const refusalMessage = (text) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  content: [{ type: 'refusal', refusal: text }],
});

test('WS: refusal deltas and final refusal parts surface a typed refusal, never an empty success', async () => {
  const streamed = runWs([
    created,
    { type: 'response.refusal.delta', item_id: 'msg_1', content_index: 0, delta: 'I can' },
    { type: 'response.refusal.delta', item_id: 'msg_1', content_index: 0, delta: 'not help.' },
    { type: 'response.refusal.done', item_id: 'msg_1', content_index: 0, refusal: "I can't help." },
    { type: 'response.output_item.done', item: refusalMessage("I can't help.") },
    { type: 'response.completed', response: { output: [refusalMessage("I can't help.")] } },
  ]);
  const result = await streamed.pending;
  assert.equal(result.stopReason, REFUSAL_STOP_REASON);
  assert.equal(result.refusal, "I can't help.");
  assert.equal(result.content, "I can't help.");
  // Refusal text is never relayed as live answer text.
  assert.deepEqual(streamed.seen.text, []);

  const bundleOnly = runWs([created, { type: 'response.completed', response: { output: [refusalMessage('No.')] } }]);
  const final = await bundleOnly.pending;
  assert.equal(final.stopReason, 'refusal');
  assert.equal(final.refusal, 'No.');
  assert.equal(final.content, 'No.');
});

test('HTTP/SSE: refusal deltas and final refusal parts surface a typed refusal', () => {
  const streamed = runHttp([
    created,
    { type: 'response.refusal.delta', item_id: 'msg_1', content_index: 0, delta: 'Sorry' },
    { type: 'response.refusal.done', item_id: 'msg_1', content_index: 0, refusal: 'Sorry, no.' },
    { type: 'response.output_item.done', item: refusalMessage('Sorry, no.') },
    { type: 'response.completed', response: { output: [refusalMessage('Sorry, no.')] } },
  ]);
  const result = streamed.result();
  assert.equal(result.stopReason, 'refusal');
  assert.equal(result.refusal, 'Sorry, no.');
  assert.equal(result.content, 'Sorry, no.');
  assert.deepEqual(streamed.seen.text, []);

  const bundleOnly = runHttp([created, { type: 'response.completed', response: { output: [refusalMessage('No.')] } }]);
  const final = bundleOnly.result();
  assert.equal(final.stopReason, 'refusal');
  assert.equal(final.refusal, 'No.');

  // A normal answer carries no refusal fields.
  const normal = runHttp([
    created,
    { type: 'response.output_text.delta', delta: 'hi' },
    { type: 'response.completed', response: { output: [] } },
  ]).result();
  assert.equal(Object.hasOwn(normal, 'refusal'), false);
  assert.equal(normal.stopReason, undefined);
});

test('WS: calls present only in the terminal output bundle are created once through the deduplicated collector', async () => {
  const bundleCall = { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'read', arguments: '{"path":"b"}' };
  for (const terminal of [
    { type: 'response.completed', response: { output: [bundleCall] } },
    { type: 'response.done', response: { status: 'completed', output: [bundleCall] } },
  ]) {
    const { pending, seen } = runWs([created, terminal]);
    const result = await pending;
    assert.deepEqual(result.toolCalls, [{ id: 'call_b', name: 'read', arguments: { path: 'b' } }], terminal.type);
    assert.deepEqual(seen.tools, [{ id: 'call_b', name: 'read', arguments: { path: 'b' } }], terminal.type);
  }
  // A streamed call repeated in the bundle is not dispatched twice.
  const { pending, seen } = runWs([
    created,
    { type: 'response.output_item.added', item: { ...bundleCall, arguments: '' } },
    { type: 'response.function_call_arguments.done', item_id: 'fc_b', arguments: bundleCall.arguments },
    { type: 'response.output_item.done', item: bundleCall },
    { type: 'response.done', response: { status: 'completed', output: [bundleCall] } },
  ]);
  const result = await pending;
  assert.equal(result.toolCalls.length, 1);
  assert.equal(seen.tools.length, 1);
  // An unresolvable deferred call fails on response.done as on completed.
  const lost = runWs([
    created,
    { type: 'response.function_call_arguments.done', item_id: 'fc_lost', arguments: '{}' },
    { type: 'response.done', response: { status: 'completed', output: [] } },
  ]);
  await assert.rejects(lost.pending, /function_call salvage failed: missing call_id\/name for item_id=fc_lost/);
});

test('HTTP/SSE: a completed response.done reconciles its output bundle', () => {
  const bundleCall = { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'read', arguments: '{}' };
  const run = runHttp([created, { type: 'response.done', response: { status: 'completed', output: [bundleCall] } }]);
  assert.deepEqual(run.result().toolCalls, [{ id: 'call_b', name: 'read', arguments: {} }]);
  assert.equal(run.seen.tools.length, 1);
});

test('namespaced calls keep their namespace through parsing, dedupe identity and replay', async () => {
  const fn = { type: 'function_call', id: 'fc_n', call_id: 'call_n', name: 'read', namespace: 'fs', arguments: '{}' };
  const ws = runWs([
    created,
    { type: 'response.output_item.added', item: { ...fn, arguments: '' } },
    { type: 'response.function_call_arguments.done', item_id: 'fc_n', arguments: '{}' },
    { type: 'response.output_item.done', item: fn },
    { type: 'response.completed', response: { output: [fn] } },
  ]);
  const wsResult = await ws.pending;
  assert.deepEqual(wsResult.toolCalls, [{ id: 'call_n', name: 'read', namespace: 'fs', arguments: {} }]);

  const http = runHttp([created, { type: 'response.completed', response: { output: [fn] } }]);
  assert.deepEqual(http.result().toolCalls, [{ id: 'call_n', name: 'read', namespace: 'fs', arguments: {} }]);

  assert.equal(
    customToolCallFromResponseItem({ type: 'custom_tool_call', call_id: 'cu', name: 'apply_patch', namespace: 'ed', input: 'P' })
      .namespace,
    'ed'
  );

  const input = convertMessagesToResponsesInput([
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call_n', name: 'read', namespace: 'fs', arguments: {} },
        { id: 'call_p', name: 'read', arguments: {} },
        { id: 'cu', name: 'apply_patch', namespace: 'ed', arguments: { patch: 'P' }, nativeType: 'custom_tool_call' },
      ],
    },
    { role: 'tool', toolCallId: 'call_n', content: 'a' },
    { role: 'tool', toolCallId: 'call_p', content: 'b' },
    { role: 'tool', toolCallId: 'cu', content: 'c' },
  ]);
  assert.deepEqual(input.slice(1, 4), [
    { type: 'function_call', call_id: 'call_n', name: 'read', namespace: 'fs', arguments: '{}' },
    { type: 'function_call', call_id: 'call_p', name: 'read', arguments: '{}' },
    { type: 'custom_tool_call', call_id: 'cu', name: 'apply_patch', namespace: 'ed', input: 'P' },
  ]);
  // custom_tool_call_output follows the documented shape: no `name`.
  assert.deepEqual(input[6], { type: 'custom_tool_call_output', call_id: 'cu', output: 'c' });
});
