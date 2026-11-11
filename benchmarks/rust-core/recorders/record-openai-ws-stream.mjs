#!/usr/bin/env node
// openai-ws-stream.test.mjs (15 tests): the real Responses WS stream reader (`_streamResponse`) reading a REAL WebSocket: the provider's own client
// (`acquireWebSocket`, openai-ws-pool.mjs -> ws through createWsConnection) connects to a loopback WebSocket server (lib/ws-world.mjs; only `tls.connect`
// is redirected to the loopback), `_sendFrame` writes the request frame and the server answers with the scripted frames. Each case records ONE ordered
// list of events: the dial, the upgrade request (every header in order), the upgrade response, every frame in each direction, the callbacks the caller
// saw (progress / text / tool, interleaved as they happened), the virtual-clock steps and the closes with their codes. The watchdog cases
// (:231-:361) run on the virtual clock: every `advance` step and every keepalive frame is an input; each step waits for what it caused. 1006 cannot be sent
// on the wire: a scripted 1006 is the server dropping the TCP connection (the client sees 1006 with an empty reason).
//   node benchmarks/rust-core/recorders/record-openai-ws-stream.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-ws-stream',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/openai-ws-pool.mjs acquireWebSocket (the real ws client, real upgrade request) + _sendFrame + openai-ws-stream.mjs _streamResponse({ entry, externalSignal, onStreamDelta, onToolCall, onTextDelta, state, knownToolNames }) reading a real WebSocket served by a loopback server (lib/ws-world.mjs); the watchdog cases advance the virtual clock (`rec.clock`). Not run: the provider send around it (openai-oauth-ws.mjs sendViaWebSocket) and a live chatgpt.com.',
  compare: 'mixdog-ai providers::openai decoder.rs (:696-745 bundle salvage, :1011-1027, :1144-1179 max-output), the WS transport (openai/pool.rs, transport/ws.rs) and mixdog-agent send.rs:541-556: serve each case\'s `events` as the loopback server does (the `server->client` frames and closes, in order, answering the request frame) and compare, in order, the client\'s upgrade request headers, its frames, the callback events (`progress`/`text`/`tool`, interleaved with the frames), the clock steps, and `result`/`error` (message, wsCloseCode, partialToolCalls, pendingToolUse, providerErrorCode, ...) and `state`. `client-frame-handled` and `recorder-cleanup-close` are the recorder\'s own markers.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::openai::OpenAiAdapter (openai/adapter.rs:308) with OpenAiCodec (openai/codec.rs:36) and build_body (openai/profile.rs:497), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079); the socket pool is WsPool::checkout (openai/pool.rs:178).",
});
// The stall policy reads host overrides once at load; the stream loads with the defaults.
for (const name of Object.keys(process.env)) if (/^(MIXDOG_PROVIDER_|MIXDOG_STALL_|MIXDOG_ENABLE_STREAM_WATCHDOG$|STALL_TIMEOUT_S$)/.test(name)) delete process.env[name];
const P = 'agent/orchestrator/providers/';
const world = await rec.wsWorld();
const { _streamResponse } = await rec.P(`${P}openai-ws-stream.mjs`);
const { acquireWebSocket, _sendFrame } = await rec.raw(`${P}openai-ws-pool.mjs`);
const { markSessionStreamDelta, updateSessionStage } = await rec.P('agent/orchestrator/session/manager/runtime-liveness.mjs');
const { runtimeState } = await rec.P('agent/orchestrator/session/manager/runtime-state.mjs');
const { PROVIDER_FIRST_OUTPUT_TIMEOUT_MS, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS } = await rec.P('agent/orchestrator/stall-policy.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/openai-ws-stream.test.mjs';
const created = { type: 'response.created', response: { id: 'resp_1', model: 'gpt-fixture' } };
const AUTH = { type: 'openai-oauth', access_token: 'fixture-access-token', account_id: 'acct-fixture' };
const REQUEST = { type: 'response.create', model: 'gpt-fixture', input: [], stream: true };

// Callbacks the caller hands the reader: each call is one event in the case's ordered list.
function onStreamDelta(kind) { world.note({ event: 'progress', kind }); }
function onToolCall(call) { world.note({ event: 'tool', call }); }
function onTextDelta(chunk) { world.note({ event: 'text', chunk }); }

// Server side of one connection: `plan` is consumed one entry per connection, when the request frame arrives:
// { frames, close: [code, reason] | null } (1006 = the server drops the connection).
const serve = (plans) => {
  let n = 0;
  world.reset({
    onFrame: (conn) => {
      const plan = plans[n++];
      for (const frame of plan.frames) conn.send(frame);
      if (plan.close) (plan.close[0] === 1006 ? conn.terminate() : conn.close(plan.close[0], plan.close[1]));
    },
  });
};
// One connection: the provider's client connects, the reader is attached, the request frame is sent.
async function connect(overrides = {}) {
  const { entry } = await acquireWebSocket({ auth: AUTH, poolKey: '', cacheKey: 'ws-stream-test', forceFresh: true });
  rec.describe(entry, { $connection: 'the provider client socket of this case: a real WebSocket to the loopback server; its wire events are the ordered events of the case' });
  entry.socket.on('message', () => world.note({ event: 'client-frame-handled' }));
  const state = { sessionId: 'ws-stream-test' };
  const pending = _streamResponse({ entry, externalSignal: null, onStreamDelta, onToolCall, onTextDelta, state, logSuppressedReasoningDeltas: false, ...overrides });
  const outcome = pending.then((result) => ({ result }), (error) => ({ error }));
  await _sendFrame(entry, REQUEST);
  return { entry, state, pending, outcome };
}
// The case is over: when the client closed (or is closing) its socket, wait for the close to reach the server; otherwise the recorder closes it.
async function end(entry) {
  await new Promise((resolve) => setImmediate(resolve));
  if (entry.socket.readyState === 1) {
    world.note({ event: 'recorder-cleanup-close' });
    world.conns.at(-1).close(1000, 'recorder-end');
  }
  await world.until((t) => t.some((e) => e.event === 'closed'), 'socket closed');
}
const snapshot = () => world.trace.map((e) => ({ ...e }));
// A metadata frame every minute for `ms` of virtual time: the socket stays live.
const KEEPALIVE = { type: 'response.in_progress', response: { id: 'resp_1' } };
const deliver = async (frame) => {
  const handled = world.count((e) => e.event === 'client-frame-handled') + 1;
  world.conns.at(-1).send(frame);
  await world.until(() => world.count((e) => e.event === 'client-frame-handled') >= handled, `client handled ${frame.type}`);
};
const step = async (ms, options) => {
  await rec.clock.advance(ms, options);
  world.note({ event: 'clock-step', advanceMs: ms, nowMs: Date.now() - rec.T0 });
};
const keepalivesFor = async (ms) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 60_000) {
    await step(Math.min(60_000, ms - elapsed));
    await deliver(KEEPALIVE);
  }
};

// One stream: the frames are the server's answer to the request frame; `close` = [code, reason] is the server closing afterwards; `abort` is the external signal's reason.
async function stream(frames, { close = null, knownToolNames, abort = null } = {}) {
  serve([{ frames, close }]);
  const controller = new AbortController();
  const { entry, state, outcome } = await connect({ externalSignal: abort ? controller.signal : null, ...(knownToolNames ? { knownToolNames } : {}) });
  if (abort) {
    await world.until((t) => t.some((e) => e.event === 'progress' && e.kind === 'transport'), 'response.created handled');
    controller.abort(abort);
  }
  const out = await outcome;
  await end(entry);
  return { ...out, state, events: snapshot() };
}
const row = (id, line, frames, options = {}) => rec.run(id, `${SRC}:${line}`, { frames, ...(options.close ? { close: options.close } : {}), ...(options.knownToolNames ? { knownToolNames: options.knownToolNames } : {}) }, () => stream(frames, options));

await row('text-call-and-usage-in-one-result', 58, [
  created, { type: 'response.output_text.delta', delta: 'Hello ' }, { type: 'response.output_text.delta', delta: 'world' },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path"' }, { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"path":"a.txt"}' },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' } },
  { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-fixture', end_turn: false, usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }] } },
]);
await row('call-id-only-in-completed-bundle-is-salvaged', 112, [created, { type: 'response.function_call_arguments.done', item_id: 'fc_late', arguments: '{"q":1}' }, { type: 'response.completed', response: { output: [{ type: 'function_call', id: 'fc_late', call_id: 'call_late', name: 'search' }] } }]);
await row('unsalvageable-call-fails', 112, [created, { type: 'response.function_call_arguments.done', item_id: 'fc_lost', arguments: '{}' }, { type: 'response.completed', response: { output: [] } }]);
const leaked = '<function_calls><invoke name="read"><parameter name="path">a.txt</parameter></invoke></function_calls>';
await row('leaked-tool-call-recovered-once', 140, [created, { type: 'response.output_text.delta', delta: 'Sure. ' }, { type: 'response.output_text.delta', delta: leaked }, { type: 'response.completed', response: { output: [] } }], { knownToolNames: ['read'] });
await row('max-output-tokens-truncated-success', 155, [created, { type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]);
await row('response-failed-rejects-with-frame', 155, [created, { type: 'response.failed', response: { error: { message: 'boom', code: 'server_error', status: 503 } } }]);
await row('response-done-cancelled-rejects', 155, [created, { type: 'response.done', response: { status: 'cancelled' } }]);
await row('close-before-terminal-keeps-partial-state', 133, [created, { type: 'response.output_text.delta', delta: 'half' }, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_open', call_id: 'c', name: 'n' } }], { close: [1006, 'gone'] });
const done = { type: 'function_call', id: 'fc_done', call_id: 'call_done', name: 'read' };
await row('close-after-finished-call-carries-it', 203, [
  created, { type: 'response.output_item.added', item: done }, { type: 'response.function_call_arguments.done', item_id: 'fc_done', arguments: '{"path":"a.txt"}' },
  { type: 'response.output_item.done', item: { ...done, arguments: '{"path":"a.txt"}' } },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_open', call_id: 'call_open', name: 'edit' } }, { type: 'response.function_call_arguments.delta', item_id: 'fc_open', delta: '{"pa' },
], { close: [1006, 'gone'] });
const abortRows = [['user-abort', new Error('stop')], ['watchdog-abort', Object.assign(new Error('stalled'), { name: 'AgentStallAbortError' })]];
for (const [id, reason] of abortRows) await rec.run(`external-abort-tags-${id}`, `${SRC}:361`, { frames: [created], abort: reason }, () => stream([created], { abort: reason }));

// ---- watchdogs on the virtual clock ----
const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [] };
const policy = { PROVIDER_FIRST_OUTPUT_TIMEOUT_MS, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS };
const watchdog = (id, line, input, fn) => rec.run(id, `${SRC}:${line}`, { policy, ...input }, fn);
const closedBy = (e) => e.event === 'closed';

await watchdog('prestream-watchdog-closes-silent-socket-first-byte-timeout', 231, { frames: [], timeouts: { preResponseCreatedMs: 20 }, advanceMs: [20] }, async () => {
  serve([{ frames: [] }]);
  const { entry, state, outcome } = await connect({ _timeouts: { preResponseCreatedMs: 20 } });
  await world.until((t) => t.some((e) => e.event === 'frame' && e.dir === 'client->server'), 'request frame at the server');
  await step(20);
  const out = await outcome;
  await end(entry);
  return { ...out, stateFirstByteTimeout: state.firstByteTimeout, events: snapshot() };
});
await watchdog('inter-chunk-stall-after-output-rejects-as-continuation', 245, { frames: [created, { type: 'response.output_text.delta', delta: 'kept' }], timeouts: { preResponseCreatedMs: 5000, interChunkMs: 20, firstMeaningfulMs: 5000 }, advanceMs: [20] }, async () => {
  serve([{ frames: [created, { type: 'response.output_text.delta', delta: 'kept' }] }]);
  const { entry, outcome } = await connect({ _timeouts: { preResponseCreatedMs: 5_000, interChunkMs: 20, firstMeaningfulMs: 5_000 } });
  await world.until((t) => t.some((e) => e.event === 'text'), 'text delta handled');
  await step(20);
  const out = await outcome;
  await end(entry);
  return { ...out, events: snapshot() };
});
const completed = { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-fixture', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] } };
await watchdog('silent-thinking-past-semantic-idle-until-first-output', 275, { frames: [created, KEEPALIVE, { type: 'response.output_item.added', item: reasoningItem }], keepalivesEveryMs: 60000, keepalivesForMs: PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS + 60_000, thenFrames: [{ type: 'response.output_item.done', item: reasoningItem }, { type: 'response.output_text.delta', delta: 'answer' }, completed] }, async () => {
  serve([{ frames: [created, KEEPALIVE, { type: 'response.output_item.added', item: reasoningItem }] }]);
  const { entry, outcome } = await connect();
  await world.until((t) => t.some((e) => e.event === 'progress'), 'reasoning handled');
  await keepalivesFor(PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS + 60_000);
  for (const frame of [{ type: 'response.output_item.done', item: reasoningItem }, { type: 'response.output_text.delta', delta: 'answer' }, completed]) world.conns.at(-1).send(frame);
  const out = await outcome;
  await end(entry);
  return { ...out, events: snapshot() };
});
await watchdog('no-output-aborted-at-first-output-deadline', 298, { frames: [created, { type: 'response.output_item.added', item: reasoningItem }], keepalivesForMs: PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1, advanceMsAfter: 1 }, async () => {
  serve([{ frames: [created, { type: 'response.output_item.added', item: reasoningItem }] }]);
  const { entry, outcome } = await connect();
  await world.until((t) => t.some((e) => e.event === 'progress'), 'reasoning handled');
  await keepalivesFor(PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1);
  await step(1);
  const out = await outcome;
  await end(entry);
  return { ...out, events: snapshot() };
});
await watchdog('semantic-idle-applies-after-first-output', 313, { frames: [created, { type: 'response.output_text.delta', delta: 'kept' }], keepalivesForMs: PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1, advanceMsAfter: 1 }, async () => {
  serve([{ frames: [created, { type: 'response.output_text.delta', delta: 'kept' }] }]);
  const { entry, outcome } = await connect();
  await world.until((t) => t.some((e) => e.event === 'text'), 'text handled');
  await keepalivesFor(PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1);
  await step(1);
  const out = await outcome;
  await end(entry);
  return { ...out, events: snapshot() };
});
const sessionRequest = (sessionId) => {
  updateSessionStage(sessionId, 'requesting');
  return Date.now();
};
await watchdog('reopened-stream-aborts-at-original-request-deadline', 337, { sessionId: 'sess_ws_retry_deadline', firstFrames: [created, { type: 'response.output_item.added', item: reasoningItem }], firstKeepalivesForMs: 400_000, firstClose: [1006, 'gone'], retryFrames: [created] }, async () => {
  const sessionId = 'sess_ws_retry_deadline';
  const startedAt = sessionRequest(sessionId);
  serve([{ frames: [created, { type: 'response.output_item.added', item: reasoningItem }] }, { frames: [created] }]);
  try {
    const first = await connect({ state: { sessionId } });
    await world.until((t) => t.some((e) => e.event === 'progress'), 'reasoning handled');
    await keepalivesFor(400_000);
    world.conns.at(-1).terminate();
    const firstOut = await first.outcome;
    await end(first.entry);
    updateSessionStage(sessionId, 'requesting');
    world.note({ event: 'reopen', startedAtMs: startedAt - rec.T0 });
    const progressBefore = world.count((e) => e.event === 'progress');
    const retry = await connect({ state: { sessionId } });
    await world.until((t) => t.filter((e) => e.event === 'progress').length > progressBefore, 'retry response.created handled');
    const retryKeepaliveMs = startedAt + PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1 - Date.now();
    await keepalivesFor(retryKeepaliveMs);
    await step(1);
    const retryOut = await retry.outcome;
    await end(retry.entry);
    return { startedAtMs: startedAt - rec.T0, firstOut, retryKeepaliveMs, retry: retryOut, events: snapshot() };
  } finally {
    runtimeState.delete(sessionId);
  }
});
await watchdog('ws-retry-after-output-stays-under-semantic-idle', 360, { sessionId: 'sess_ws_retry_after_output', markDelta: 'reasoning', advanceMsBeforeRetry: 10_000, retryFrames: [created], keepalivesForMs: PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1, advanceMsAfter: 1 }, async () => {
  const sessionId = 'sess_ws_retry_after_output';
  sessionRequest(sessionId);
  serve([{ frames: [created] }]);
  try {
    await markSessionStreamDelta(sessionId, 'reasoning');
    await step(10_000);
    updateSessionStage(sessionId, 'requesting');
    const retry = await connect({ state: { sessionId } });
    await world.until((t) => t.some((e) => e.event === 'progress'), 'retry response.created handled');
    await keepalivesFor(PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1);
    await step(1);
    const out = await retry.outcome;
    await end(retry.entry);
    return { retry: out, events: snapshot() };
  } finally {
    runtimeState.delete(sessionId);
  }
});
await rec.finish();
