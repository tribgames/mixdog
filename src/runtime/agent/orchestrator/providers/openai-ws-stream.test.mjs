import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

// The stall policy reads host overrides once at load; the stream loads with
// the defaults (watchdog on, default windows), and the host's values are put
// back afterwards.
const hostPolicy = Object.keys(process.env)
  .filter((name) => /^(MIXDOG_PROVIDER_|MIXDOG_STALL_|MIXDOG_ENABLE_STREAM_WATCHDOG$|STALL_TIMEOUT_S$)/.test(name))
  .map((name) => [name, process.env[name]]);
for (const [name] of hostPolicy) delete process.env[name];
let markSessionStreamDelta, updateSessionStage, runtimeState, _streamResponse;
let PROVIDER_FIRST_OUTPUT_TIMEOUT_MS, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS;
try {
  ({ markSessionStreamDelta, updateSessionStage } = await import('../session/manager/runtime-liveness.mjs'));
  ({ runtimeState } = await import('../session/manager/runtime-state.mjs'));
  ({ _streamResponse } = await import('./openai-ws-stream.mjs'));
  ({ PROVIDER_FIRST_OUTPUT_TIMEOUT_MS, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS } = await import('../stall-policy.mjs'));
} finally {
  for (const [name, value] of hostPolicy) process.env[name] = value;
}

// Observable contract of one Responses WS stream: what the resolved result
// carries, what the callbacks saw, and what a stalled/closed stream reports.

function streamEntry() {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.closes = [];
  socket.close = (code, reason) => {
    socket.readyState = 3;
    socket.closes.push([code, reason]);
  };
  socket.terminate = socket.close;
  return { socket, ephemeral: true };
}

function run(events, overrides = {}) {
  const entry = streamEntry();
  const seen = { text: [], tools: [], progress: [] };
  const state = { sessionId: 'ws-stream-test' };
  const pending = _streamResponse({
    entry,
    externalSignal: null,
    onStreamDelta: (kind) => seen.progress.push(kind),
    onToolCall: (call) => seen.tools.push(call),
    onTextDelta: (chunk) => seen.text.push(chunk),
    state,
    logSuppressedReasoningDeltas: false,
    ...overrides,
  });
  for (const event of events) entry.socket.emit('message', Buffer.from(JSON.stringify(event)));
  return { pending, seen, state, socket: entry.socket };
}

const created = { type: 'response.created', response: { id: 'resp_1', model: 'gpt-fixture' } };

test('streamed text, a native function call and the completed usage land in one result', async () => {
  const { pending, seen, state } = run([
    created,
    { type: 'response.output_text.delta', delta: 'Hello ' },
    { type: 'response.output_text.delta', delta: 'world' },
    {
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' },
    },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path"' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"path":"a.txt"}' },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        model: 'gpt-fixture',
        end_turn: false,
        usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }],
      },
    },
  ]);
  const result = await pending;
  assert.equal(result.content, 'Hello world');
  assert.equal(result.model, 'gpt-fixture');
  assert.equal(result.responseId, 'resp_1');
  assert.equal(result.endTurn, false);
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }]);
  assert.deepEqual(seen.tools, [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }]);
  assert.deepEqual(seen.text, ['Hello ', 'world']);
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 3);
  assert.equal(result.usage.cachedTokens, 4);
  assert.equal(result.usage.promptTokens, 12);
  // The replay keeps the function call item AND the message from the bundle.
  assert.deepEqual(
    result.responseItems.map((item) => item.type),
    ['function_call', 'message']
  );
  assert.equal(result.responseItems[0].call_id, 'call_1');
  assert.equal(state.sawResponseCreated, true);
  assert.equal(state.sawCompleted, true);
  assert.equal(state.emittedText, true);
  assert.equal(state.emittedToolCall, true);
  // The response.created ack is transport, never model output.
  assert.equal(seen.progress[0], 'transport');
  assert.ok(seen.progress.includes('text'));
  assert.ok(seen.progress.includes('tool'));
});

test('a function call whose id arrives only in the completed bundle is salvaged, and an unsalvageable one fails', async () => {
  const salvaged = run([
    created,
    { type: 'response.function_call_arguments.done', item_id: 'fc_late', arguments: '{"q":1}' },
    {
      type: 'response.completed',
      response: { output: [{ type: 'function_call', id: 'fc_late', call_id: 'call_late', name: 'search' }] },
    },
  ]);
  const result = await salvaged.pending;
  assert.deepEqual(result.toolCalls, [{ id: 'call_late', name: 'search', arguments: { q: 1 } }]);
  assert.deepEqual(salvaged.seen.tools, [{ id: 'call_late', name: 'search', arguments: { q: 1 } }]);

  const unresolved = run([
    created,
    { type: 'response.function_call_arguments.done', item_id: 'fc_lost', arguments: '{}' },
    { type: 'response.completed', response: { output: [] } },
  ]);
  await assert.rejects(unresolved.pending, /function_call salvage failed: missing call_id\/name for item_id=fc_lost/);
});

test('a tool call leaked as text is recovered once and never rendered', async () => {
  const leaked =
    '<function_calls><invoke name="read"><parameter name="path">a.txt</parameter></invoke></function_calls>';
  const { pending, seen } = run(
    [
      created,
      { type: 'response.output_text.delta', delta: 'Sure. ' },
      { type: 'response.output_text.delta', delta: leaked },
      { type: 'response.completed', response: { output: [] } },
    ],
    { knownToolNames: ['read'] }
  );
  const result = await pending;
  assert.equal(result.content, 'Sure. ');
  assert.equal(seen.text.join(''), 'Sure. ');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'read');
  assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.txt' });
  assert.match(result.toolCalls[0].id, /^call_leaked_/);
  assert.equal(seen.tools.length, 1);
});

test('max_output_tokens is a truncated success; other incomplete reasons and failures reject with the frame attached', async () => {
  const truncated = run([
    created,
    { type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
  ]);
  const result = await truncated.pending;
  assert.equal(result.content, 'partial');
  assert.equal(result.stopReason, 'length');
  assert.equal(result.truncated, true);
  assert.equal(result.incompleteReason, 'max_output_tokens');

  const failed = run([
    created,
    { type: 'response.failed', response: { error: { message: 'boom', code: 'server_error', status: 503 } } },
  ]);
  await assert.rejects(failed.pending, (err) => {
    assert.match(err.message, /response\.failed: boom$/);
    assert.equal(err.providerErrorCode, 'server_error');
    assert.equal(err.responseFailed.type, 'response.failed');
    assert.equal(failed.state.responseFailedPayload.type, 'response.failed');
    return true;
  });

  const done = run([created, { type: 'response.done', response: { status: 'cancelled' } }]);
  await assert.rejects(done.pending, (err) => {
    assert.match(err.message, /response\.done unexpected status: cancelled/);
    assert.equal(err.responseDoneStatus, 'cancelled');
    return true;
  });
});

test('a socket close before the terminal frame rejects with the close code and the streamed partial state', async () => {
  const { pending, socket, state } = run([
    created,
    { type: 'response.output_text.delta', delta: 'half' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_open', call_id: 'c', name: 'n' } },
  ]);
  socket.emit('close', 1006, Buffer.from('gone'));
  await assert.rejects(pending, (err) => {
    assert.equal(err.wsCloseCode, 1006);
    assert.equal(err.wsCloseReason, 'gone');
    assert.match(err.message, /closed before response\.completed \(code=1006, reason=gone\)/);
    assert.equal(state.wsCloseCode, 1006);
    return true;
  });
});

test('a socket close after a finished function call carries that call for the loop', async () => {
  const done = { type: 'function_call', id: 'fc_done', call_id: 'call_done', name: 'read' };
  const { pending, socket, seen } = run([
    created,
    { type: 'response.output_item.added', item: done },
    { type: 'response.function_call_arguments.done', item_id: 'fc_done', arguments: '{"path":"a.txt"}' },
    { type: 'response.output_item.done', item: { ...done, arguments: '{"path":"a.txt"}' } },
    {
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'fc_open', call_id: 'call_open', name: 'edit' },
    },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_open', delta: '{"pa' },
  ]);
  socket.emit('close', 1006, Buffer.from('gone'));
  await assert.rejects(pending, (err) => {
    assert.deepEqual(
      err.partialToolCalls.map((call) => call.id),
      ['call_done']
    );
    assert.equal(err.pendingToolUse, true);
    return true;
  });
  assert.deepEqual(
    seen.tools.map((call) => call.id),
    ['call_done']
  );
});

test('the pre-stream watchdog closes a silent socket with a retryable first-byte timeout', async () => {
  const { pending, socket, state } = run([], { _timeouts: { preResponseCreatedMs: 20 } });
  await assert.rejects(pending, (err) => {
    assert.equal(err.firstByteTimeout, true);
    assert.equal(err.wsCloseCode, 4000);
    assert.equal(state.firstByteTimeout, true);
    return true;
  });
  assert.deepEqual(socket.closes, [[4000, 'first_byte_timeout']]);
});

test('an inter-chunk stall after output rejects as a continuation carrying the partial text', async () => {
  const { pending, socket } = run([created, { type: 'response.output_text.delta', delta: 'kept' }], {
    _timeouts: { preResponseCreatedMs: 5_000, interChunkMs: 20, firstMeaningfulMs: 5_000 },
  });
  await assert.rejects(pending, (err) => {
    assert.equal(err.streamStalled, true);
    assert.equal(err.code, 'ESTREAMSTALL', 'the authoritative stall code, not only the flag');
    assert.equal(err.partialContent, 'kept');
    assert.equal(err.pendingToolUse, false);
    assert.equal(err.partialModel, 'gpt-fixture');
    return true;
  });
  assert.deepEqual(socket.closes, [[4000, 'inter_chunk_timeout']]);
});

const frame = (socket, event) => socket.emit('message', Buffer.from(JSON.stringify(event)));
// Metadata/keepalive frames every minute for `ms`: the socket stays live.
function keepalivesFor(t, socket, ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 60_000) {
    t.mock.timers.tick(Math.min(60_000, ms - elapsed));
    frame(socket, { type: 'response.in_progress', response: { id: 'resp_1' } });
  }
}
const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [] };

test('a model may think silently past the semantic idle until its first output', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { pending, socket, seen } = run([
    created,
    { type: 'response.in_progress', response: { id: 'resp_1' } },
    { type: 'response.output_item.added', item: reasoningItem },
  ]);
  keepalivesFor(t, socket, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS + 60_000);
  assert.deepEqual(socket.closes, [], 'not aborted while thinking silently');
  assert.ok(
    seen.progress.every((kind) => kind === 'transport'),
    'metadata is never reported as model output'
  );
  frame(socket, { type: 'response.output_item.done', item: reasoningItem });
  frame(socket, { type: 'response.output_text.delta', delta: 'answer' });
  frame(socket, {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      model: 'gpt-fixture',
      usage: { input_tokens: 1, output_tokens: 1 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
    },
  });
  assert.equal((await pending).content, 'answer');
});

test('a stream with no output is aborted at the first-output deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { pending, socket } = run([created, { type: 'response.output_item.added', item: reasoningItem }]);
  keepalivesFor(t, socket, PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1);
  assert.deepEqual(socket.closes, []);
  t.mock.timers.tick(1);
  await assert.rejects(pending, (err) => {
    assert.equal(err.streamStalled, true);
    assert.match(err.message, new RegExp(`after ${PROVIDER_FIRST_OUTPUT_TIMEOUT_MS}ms`));
    return true;
  });
  assert.deepEqual(socket.closes, [[4000, 'first_output_timeout']]);
});

test('after the first output the semantic idle applies unchanged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { pending, socket } = run([created, { type: 'response.output_text.delta', delta: 'kept' }]);
  keepalivesFor(t, socket, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1);
  assert.deepEqual(socket.closes, []);
  t.mock.timers.tick(1);
  await assert.rejects(pending, (err) => {
    assert.equal(err.streamStalled, true);
    assert.equal(err.partialContent, 'kept');
    return true;
  });
  assert.deepEqual(socket.closes, [[4000, 'semantic_idle_timeout']]);
});

// A session whose logical model request starts now (mocked clock).
function sessionRequest(t, sessionId) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000_000 });
  t.after(() => runtimeState.delete(sessionId));
  updateSessionStage(sessionId, 'requesting');
  return Date.now();
}

test('a reopened stream aborts at the logical request original deadline', async (t) => {
  const sessionId = 'sess_ws_retry_deadline';
  const startedAt = sessionRequest(t, sessionId);
  const first = run([created, { type: 'response.output_item.added', item: reasoningItem }], { state: { sessionId } });
  first.pending.catch(() => {});
  keepalivesFor(t, first.socket, 400_000);
  first.socket.emit('close', 1006, Buffer.from('gone')); // the attempt dies before output
  await first.pending.catch(() => {});
  updateSessionStage(sessionId, 'requesting');
  const retry = run([created], { state: { sessionId } });
  keepalivesFor(t, retry.socket, startedAt + PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1 - Date.now());
  assert.deepEqual(retry.socket.closes, []);
  t.mock.timers.tick(1);
  await assert.rejects(retry.pending, new RegExp(`after ${PROVIDER_FIRST_OUTPUT_TIMEOUT_MS}ms`));
  assert.deepEqual(retry.socket.closes, [[4000, 'first_output_timeout']]);
});

test('a WS retry after output stays under the semantic idle', async (t) => {
  const sessionId = 'sess_ws_retry_after_output';
  sessionRequest(t, sessionId);
  await markSessionStreamDelta(sessionId, 'reasoning');
  t.mock.timers.tick(10_000);
  updateSessionStage(sessionId, 'requesting');
  const retry = run([created], { state: { sessionId } });
  keepalivesFor(t, retry.socket, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1);
  assert.deepEqual(retry.socket.closes, []);
  t.mock.timers.tick(1);
  await assert.rejects(retry.pending, (err) => err.streamStalled === true);
  assert.deepEqual(retry.socket.closes, [[4000, 'semantic_idle_timeout']]);
});

test('an external abort settles the stream and tags user versus watchdog aborts', async () => {
  const user = new AbortController();
  const byUser = run([created], { externalSignal: user.signal });
  user.abort(new Error('stop'));
  await assert.rejects(byUser.pending, /stop/);
  assert.equal(byUser.state.userAbort, true);
  assert.deepEqual(byUser.socket.closes, [[4002, 'aborted']]);

  const watchdog = new AbortController();
  const byWatchdog = run([created], { externalSignal: watchdog.signal });
  const reason = new Error('stalled');
  reason.name = 'AgentStallAbortError';
  watchdog.abort(reason);
  await assert.rejects(byWatchdog.pending, /stalled/);
  assert.equal(byWatchdog.state.watchdogAbort, 'AgentStallAbortError');
  assert.notEqual(byWatchdog.state.userAbort, true);
});
