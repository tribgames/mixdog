#!/usr/bin/env node
// openai-ws-stream.test.mjs (15 tests): the real Responses WS stream reader (`_streamResponse`) over a scripted socket (an EventEmitter
// that receives the frames below as message events, then optionally a close event; the socket records the close codes the reader sends).
// All 15 tests are recorded. The watchdog / idle / first-output / reopened-deadline cases (:231-:361) run on the virtual clock: the stall-policy
// windows are the product defaults (host overrides removed before load, as the test does), every `advanceMs` step and every keepalive frame is an
// input. The core removed these timers (dec:138, dec:145): the cases document the Node behaviour only.
//   node benchmarks/rust-core/recorders/record-openai-ws-stream.mjs --tree <exact export of b6f10295a>
import { EventEmitter } from 'node:events';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-ws-stream',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/openai-ws-stream.mjs _streamResponse({ entry: { socket }, externalSignal, onStreamDelta, onToolCall, onTextDelta, state, knownToolNames }) fed by a scripted socket (frames as message events, close events). The watchdog cases advance the virtual clock (`rec.clock`).',
  compare: 'mixdog-ai providers::openai decoder.rs (:696-745 bundle salvage, :1011-1027, :1144-1179 max-output) and mixdog-agent send.rs:541-556: feed `input.frames` (+ `input.close`) and compare `result`/`error` (message, wsCloseCode, partialToolCalls, pendingToolUse, providerErrorCode, ...), the callbacks (`text`, `tools`, `progress`) in order, `state` flags and `closes`.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::openai::OpenAiAdapter (openai/adapter.rs:308) with OpenAiCodec (openai/codec.rs:36) and build_body (openai/profile.rs:494), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079); the socket pool is WsPool::checkout (openai/pool.rs:178).",
});
// The stall policy reads host overrides once at load; the stream loads with the defaults.
for (const name of Object.keys(process.env)) if (/^(MIXDOG_PROVIDER_|MIXDOG_STALL_|MIXDOG_ENABLE_STREAM_WATCHDOG$|STALL_TIMEOUT_S$)/.test(name)) delete process.env[name];
const { _streamResponse } = await rec.P('agent/orchestrator/providers/openai-ws-stream.mjs');
const { markSessionStreamDelta, updateSessionStage } = await rec.P('agent/orchestrator/session/manager/runtime-liveness.mjs');
const { runtimeState } = await rec.P('agent/orchestrator/session/manager/runtime-state.mjs');
const { PROVIDER_FIRST_OUTPUT_TIMEOUT_MS, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS } = await rec.P('agent/orchestrator/stall-policy.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/openai-ws-stream.test.mjs';
const created = { type: 'response.created', response: { id: 'resp_1', model: 'gpt-fixture' } };

// One stream: frames are emitted after the reader started; `close` = [code, reason] is emitted last; `signal` is an abort controller step.
async function stream(frames, { close = null, knownToolNames, abort = null } = {}) {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.closes = [];
  socket.close = (code, reason) => { socket.readyState = 3; socket.closes.push([code, reason]); };
  socket.terminate = socket.close;
  const seen = { text: [], tools: [], progress: [] };
  const state = { sessionId: 'ws-stream-test' };
  const controller = new AbortController();
  const pending = _streamResponse({
    entry: { socket, ephemeral: true }, externalSignal: abort ? controller.signal : null,
    onStreamDelta: (kind) => seen.progress.push(kind), onToolCall: (call) => seen.tools.push(call), onTextDelta: (chunk) => seen.text.push(chunk),
    state, logSuppressedReasoningDeltas: false, ...(knownToolNames ? { knownToolNames } : {}),
  });
  for (const event of frames) socket.emit('message', Buffer.from(JSON.stringify(event)));
  if (close) socket.emit('close', close[0], Buffer.from(close[1]));
  if (abort) controller.abort(abort);
  let out;
  try {
    out = { result: await pending };
  } catch (error) {
    out = { error };
  }
  return { ...out, ...seen, state, closes: socket.closes };
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
for (const [id, reason] of abortRows) await rec.run(`external-abort-tags-${id}`, `${SRC}:361`, { frames: [created], abort: { name: reason.name, message: reason.message } }, () => stream([created], { abort: reason }));
// ---- watchdogs on the virtual clock ----
const open = (frames, overrides = {}) => {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.closes = [];
  socket.close = (code, reason) => { socket.readyState = 3; socket.closes.push([code, reason]); };
  socket.terminate = socket.close;
  const seen = { text: [], tools: [], progress: [] };
  const state = { sessionId: 'ws-stream-test' };
  const pending = _streamResponse({ entry: { socket, ephemeral: true }, externalSignal: null, onStreamDelta: (kind) => seen.progress.push(kind), onToolCall: (call) => seen.tools.push(call), onTextDelta: (chunk) => seen.text.push(chunk), state, logSuppressedReasoningDeltas: false, ...overrides });
  for (const event of frames) socket.emit('message', Buffer.from(JSON.stringify(event)));
  return { pending, seen, state, socket };
};
const settle = (promise) => promise.then((result) => ({ result }), (error) => ({ error }));
const frame = (socket, event) => socket.emit('message', Buffer.from(JSON.stringify(event)));
const KEEPALIVE = { type: 'response.in_progress', response: { id: 'resp_1' } };
// A metadata frame every minute for `ms` of virtual time: the socket stays live.
const keepalivesFor = async (socket, ms) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 60_000) {
    await rec.clock.advance(Math.min(60_000, ms - elapsed));
    frame(socket, KEEPALIVE);
  }
};
const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [] };
const policy = { PROVIDER_FIRST_OUTPUT_TIMEOUT_MS, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS };
const watchdog = (id, line, input, fn) => rec.run(id, `${SRC}:${line}`, { policy, ...input }, fn);

await watchdog('prestream-watchdog-closes-silent-socket-first-byte-timeout', 231, { frames: [], timeouts: { preResponseCreatedMs: 20 }, advanceMs: [20] }, async () => {
  const { pending, socket, state } = open([], { _timeouts: { preResponseCreatedMs: 20 } });
  await rec.clock.advance(20);
  const out = await settle(pending);
  return { ...out, stateFirstByteTimeout: state.firstByteTimeout, closes: socket.closes };
});
await watchdog('inter-chunk-stall-after-output-rejects-as-continuation', 245, { frames: [created, { type: 'response.output_text.delta', delta: 'kept' }], timeouts: { preResponseCreatedMs: 5000, interChunkMs: 20, firstMeaningfulMs: 5000 }, advanceMs: [20] }, async () => {
  const { pending, socket } = open([created, { type: 'response.output_text.delta', delta: 'kept' }], { _timeouts: { preResponseCreatedMs: 5_000, interChunkMs: 20, firstMeaningfulMs: 5_000 } });
  await rec.clock.advance(20);
  return { ...(await settle(pending)), closes: socket.closes };
});
const completed = { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-fixture', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] } };
await watchdog('silent-thinking-past-semantic-idle-until-first-output', 275, { frames: [created, KEEPALIVE, { type: 'response.output_item.added', item: reasoningItem }], keepalivesEveryMs: 60000, keepalivesForMs: PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS + 60_000, thenFrames: [{ type: 'response.output_item.done', item: reasoningItem }, { type: 'response.output_text.delta', delta: 'answer' }, completed] }, async () => {
  const { pending, socket, seen } = open([created, KEEPALIVE, { type: 'response.output_item.added', item: reasoningItem }]);
  await keepalivesFor(socket, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS + 60_000);
  const whileThinking = { closes: [...socket.closes], progress: [...seen.progress] };
  frame(socket, { type: 'response.output_item.done', item: reasoningItem });
  frame(socket, { type: 'response.output_text.delta', delta: 'answer' });
  frame(socket, completed);
  return { whileThinking, ...(await settle(pending)), progress: seen.progress, text: seen.text };
});
await watchdog('no-output-aborted-at-first-output-deadline', 298, { frames: [created, { type: 'response.output_item.added', item: reasoningItem }], keepalivesForMs: PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1, advanceMsAfter: 1 }, async () => {
  const { pending, socket } = open([created, { type: 'response.output_item.added', item: reasoningItem }]);
  await keepalivesFor(socket, PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1);
  const before = [...socket.closes];
  await rec.clock.advance(1);
  return { closesBeforeDeadline: before, ...(await settle(pending)), closes: socket.closes };
});
await watchdog('semantic-idle-applies-after-first-output', 313, { frames: [created, { type: 'response.output_text.delta', delta: 'kept' }], keepalivesForMs: PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1, advanceMsAfter: 1 }, async () => {
  const { pending, socket } = open([created, { type: 'response.output_text.delta', delta: 'kept' }]);
  await keepalivesFor(socket, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1);
  const before = [...socket.closes];
  await rec.clock.advance(1);
  return { closesBeforeIdle: before, ...(await settle(pending)), closes: socket.closes };
});
const sessionRequest = (sessionId) => {
  updateSessionStage(sessionId, 'requesting');
  return Date.now();
};
await watchdog('reopened-stream-aborts-at-original-request-deadline', 337, { sessionId: 'sess_ws_retry_deadline', firstFrames: [created, { type: 'response.output_item.added', item: reasoningItem }], firstKeepalivesForMs: 400_000, firstClose: [1006, 'gone'], retryFrames: [created] }, async () => {
  const sessionId = 'sess_ws_retry_deadline';
  const startedAt = sessionRequest(sessionId);
  try {
    const first = open([created, { type: 'response.output_item.added', item: reasoningItem }], { state: { sessionId } });
    const firstSettled = settle(first.pending);
    await keepalivesFor(first.socket, 400_000);
    first.socket.emit('close', 1006, Buffer.from('gone'));
    const firstOut = await firstSettled;
    updateSessionStage(sessionId, 'requesting');
    const retry = open([created], { state: { sessionId } });
    const retrySettled = settle(retry.pending);
    const retryKeepaliveMs = startedAt + PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1 - Date.now();
    await keepalivesFor(retry.socket, retryKeepaliveMs);
    const before = [...retry.socket.closes];
    await rec.clock.advance(1);
    return { startedAtMs: startedAt, firstOut, retryKeepaliveMs, retryClosesBeforeDeadline: before, retry: await retrySettled, retryCloses: retry.socket.closes };
  } finally {
    runtimeState.delete(sessionId);
  }
});
await watchdog('ws-retry-after-output-stays-under-semantic-idle', 360, { sessionId: 'sess_ws_retry_after_output', markDelta: 'reasoning', advanceMsBeforeRetry: 10_000, retryFrames: [created], keepalivesForMs: PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1, advanceMsAfter: 1 }, async () => {
  const sessionId = 'sess_ws_retry_after_output';
  sessionRequest(sessionId);
  try {
    await markSessionStreamDelta(sessionId, 'reasoning');
    await rec.clock.advance(10_000);
    updateSessionStage(sessionId, 'requesting');
    const retry = open([created], { state: { sessionId } });
    const retrySettled = settle(retry.pending);
    await keepalivesFor(retry.socket, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1);
    const before = [...retry.socket.closes];
    await rec.clock.advance(1);
    return { closesBeforeIdle: before, retry: await retrySettled, closes: retry.socket.closes };
  } finally {
    runtimeState.delete(sessionId);
  }
});
await rec.finish();
