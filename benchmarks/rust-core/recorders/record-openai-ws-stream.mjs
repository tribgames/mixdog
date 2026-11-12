#!/usr/bin/env node
// openai-ws-stream.test.mjs (15 tests), recorded at WIRE level: the provider's real sender (`sendViaWebSocket`, openai-oauth-ws.mjs) connects through its own client to a
// loopback WebSocket server (lib/ws-world.mjs; only `tls.connect` is redirected to the loopback) and reads the scripted frames. The Node test drives the stream reader
// `_streamResponse` over a fake socket with shortened watchdog values; no public Rust function takes that input, so the cases go through the sender and the watchdogs run
// with the product's real timeouts on the virtual clock. Each case records ONE ordered list: the dial, the upgrade request (every header in order), the upgrade response,
// every frame in each direction, the callbacks the caller saw (progress / text / tool / stage, interleaved as they happened), the virtual-clock steps (a retry the sender
// takes is followed step by step: its backoff timer, the redial) and the closes with their codes. A scripted close is a close frame with a code a server may send,
// or the connection dropped with no close frame (the client sees 1006, empty reason); the test's close(1006, 'gone') exists only on its mocked socket (see the manifest).
//   node benchmarks/rust-core/recorders/record-openai-ws-stream.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-ws-stream',
  // The send's own timing report (`transportTiming`, `*Ms` fields) is measured with the real performance clock: those numbers are replaced by a marker at this declared path only.
  maskRow: (row) => {
    for (const timing of [row.result?.result?.transportTiming, row.result?.nextSend?.result?.transportTiming]) {
      if (timing) for (const key of Object.keys(timing)) if (/Ms$/.test(key) && typeof timing[key] === 'number') timing[key] = '<ms, real clock>';
    }
  },
  exclusions: [
    'result.result.transportTiming.*Ms and result.nextSend.result.transportTiming.*Ms: measured with the real performance clock (declared mask); the other fields are compared',
    'openai-ws-stream.test.mjs:187 (and :203) emit close(1006, "gone") on a mocked socket; that pair cannot occur on a socket: 1006 is never carried in a close frame (RFC 6455 7.4.1) and the product\'s `ws` client rejects a frame carrying it (node_modules/ws/lib/receiver.js:662, isValidStatusCode in node_modules/ws/lib/validation.js:37-45, WS_ERR_INVALID_CLOSE_CODE). Recorded instead are the two real closes: close-dropped-without-close-frame-before-terminal (the connection ends with no close frame: the client reports 1006 with an empty reason) and close-frame-1011-gone-before-terminal (a close frame a server may send, code 1011, reason "gone"); :203 is recorded with the dropped connection',
    'internal fields the test reads are recorded through what they cause on the wire, in result.nextSend and the events after `next-send` (the next send on the same pool key / cache key, forceFresh off, store true for both sends): :58 result.responseId with state.sawCompleted -> the completed socket is kept and reused (no new dial); for the OpenAI OAuth (codex) transport the next request frame carries the full input and no previous_response_id, so the id itself does not reach the wire on this route; :361 state.userAbort / state.watchdogAbort -> the socket closed 4002 "aborted" (the user and watchdog aborts are the same on the wire), and the next send dials a fresh connection with the full input and no previous_response_id',
  ],
  entry: 'src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs sendViaWebSocket({ auth, body, sendOpts, onStreamDelta, onToolCall, onTextDelta, onStageChange, externalSignal, poolKey, cacheKey, iteration, useModel, forceFresh }) (the real ws client, real upgrade request, the stream reader and the retry loop inside it) against a loopback WebSocket server (lib/ws-world.mjs); the four watchdog cases that end in the reader\'s own timeout (no output at the first-output deadline, semantic idle after output, the reopened stream, the retry after output) call the stream reader `_streamResponse` (the entry the Node test calls) over a real client socket to the loopback server, so the first error is the outcome; the watchdog cases advance the virtual clock (`rec.clock`) with the product\'s real timeouts (PROVIDER_FIRST_BYTE_TIMEOUT_MS, PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS, ...). Not run: a live chatgpt.com.',
  compare: 'mixdog-ai providers::openai decoder.rs (:696-745 bundle salvage, :1011-1027, :1144-1179 max-output), the WS transport (openai/pool.rs, transport/ws.rs) and mixdog-agent send.rs:541-556: serve each case\'s `events` as the loopback server does (the `server->client` frames and closes, in order, answering the request frame) and compare, in order, the client\'s upgrade request headers, its frames, the callback events (`progress`/`text`/`tool`, interleaved with the frames), the clock steps, and `result`/`error` (message, wsCloseCode, partialToolCalls, pendingToolUse, providerErrorCode, ...) and `state`. `recorder-cleanup-close` is the recorder\'s own marker; the `ping` / `pong` pairs after a keepalive frame are the recorder\'s proof that the client handled the frame.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::openai::OpenAiAdapter (openai/adapter.rs:308) with OpenAiCodec (openai/codec.rs:36) and build_body (openai/profile.rs:497), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079); the socket pool is WsPool::checkout (openai/pool.rs:178).",
});
// The stall policy reads host overrides once at load; the stream loads with the defaults.
for (const name of Object.keys(process.env)) if (/^(MIXDOG_PROVIDER_|MIXDOG_STALL_|MIXDOG_ENABLE_STREAM_WATCHDOG$|STALL_TIMEOUT_S$)/.test(name)) delete process.env[name];
const P = 'agent/orchestrator/providers/';
const world = await rec.wsWorld();
const { sendViaWebSocket } = await rec.P(`${P}openai-oauth-ws.mjs`);
const { markSessionStreamDelta, updateSessionStage } = await rec.P('agent/orchestrator/session/manager/runtime-liveness.mjs');
const { runtimeState } = await rec.P('agent/orchestrator/session/manager/runtime-state.mjs');
const { PROVIDER_FIRST_OUTPUT_TIMEOUT_MS, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS, PROVIDER_FIRST_BYTE_TIMEOUT_MS, PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS } = await rec.P('agent/orchestrator/stall-policy.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/openai-ws-stream.test.mjs';
const created = { type: 'response.created', response: { id: 'resp_1', model: 'gpt-fixture' } };
const AUTH = { type: 'openai-oauth', access_token: 'fixture-access-token', account_id: 'acct-fixture' };
const BODY = { model: 'gpt-fixture', input: [{ type: 'message', role: 'user', content: 'hi' }] };

// Callbacks the caller hands the reader: each call is one event in the case's ordered list.
function onStreamDelta(kind) { world.note({ event: 'progress', kind }); }
function onToolCall(call) { world.note({ event: 'tool', call }); }
function onTextDelta(chunk) { world.note({ event: 'text', chunk }); }

// Server side of one connection: `plan` is consumed one entry per connection, when the request frame arrives (a connection past the plans
// repeats the last plan: a failure the product retries is served again on every attempt, so the send ends with its own typed error once its budget is spent):
// { frames, close: [code, reason] | 'drop' | null }: a close frame with that code and reason, or the connection ended with no close frame.
const serve = (plans) => {
  let n = 0;
  world.reset({
    onFrame: (conn) => {
      const plan = plans[Math.min(n++, plans.length - 1)];
      for (const frame of plan.frames) conn.send(frame);
      if (plan.close === 'drop') conn.terminate();
      else if (plan.close) conn.close(plan.close[0], plan.close[1]);
    },
  });
};
// One send through the provider's real WebSocket sender (`sendViaWebSocket`): it acquires the socket, writes the request frame and reads the stream; the
// client's own watchdogs run on the virtual clock with the product's real timeouts.
function connect(overrides = {}) {
  const outcome = sendViaWebSocket({
    auth: AUTH, body: BODY, sendOpts: {}, onStreamDelta, onToolCall, onTextDelta, externalSignal: null, poolKey: 'ws-stream-test', cacheKey: 'ws-stream-test',
    iteration: 0, useModel: 'gpt-fixture', forceFresh: true, onStageChange: (stage, detail) => world.note({ event: 'stage', stage, detail }), ...overrides,
  }).then((result) => ({ result }), (error) => ({ error }));
  outcome.then(() => world.note({ event: 'send-settled' }));
  return { outcome };
}
// Waits for the send to settle. A failure the product retries is followed on the virtual clock: the send reports the retry (stage 'reconnecting'), its
// backoff timer is armed, the clock moves to that timer and the send dials again; `stall` (ms) is then advanced once the new request frame reached the server
// (a connection that never answers). Every step is in the recorded clock trace and the event list.
const requestFrames = () => world.count((e) => e.event === 'frame' && e.dir === 'client->server');
const followReconnect = async (handled) => {
  await world.until((t) => t.some((e) => e.event === 'send-settled') || t.filter((e) => e.event === 'stage' && e.stage === 'reconnecting').length > handled, 'the send settled or decided to reconnect');
  if (world.count((e) => e.event === 'send-settled')) return false;
  const requesting = () => world.count((e) => e.event === 'stage' && e.stage === 'requesting');
  const before = requesting();
  const done = () => world.count((e) => e.event === 'send-settled') > 0 || requesting() > before;
  // The retry sleeps a backoff on the virtual clock (a timer created by the product's sleep function is armed), or starts its next attempt at once, or the send ends: wait for whichever comes first.
  const SLEEP = /at (async )?\S*[sS]leep\S* /;
  await rec.clock.advance(0, { what: 'retry backoff armed', until: () => done() || rec.clock.pendingFrom(SLEEP).length > 0 });
  if (world.count((e) => e.event === 'send-settled')) return false;
  if (requesting() > before) return true;
  // The connection the failed attempt released is closed by the client; the server's `closed` event for it is waited for before the clock
  // moves, so it comes before the next attempt's events in the trace whatever the machine's load.
  await world.until((t) => t.filter((e) => e.event === 'closed').length >= t.filter((e) => e.event === 'open').length, 'the released connection closed at the server');
  // The clock moves to the backoff timer (a recorded step) and waits for the next attempt to start (the product's 'requesting' stage) or the send to end.
  const sleep = rec.clock.pendingFrom(SLEEP)[0];
  await step(sleep.due - (Date.now() - rec.T0), { what: 'retry backoff', until: done });
  if (world.count((e) => e.event === 'send-settled')) return false;
  return true;
};
const settle = async (outcome, { stall = null } = {}) => {
  const settled = (t) => t.some((e) => e.event === 'send-settled');
  for (let handled = 0; ; handled += 1) {
    const framesBefore = requestFrames();
    if (!(await followReconnect(handled))) return outcome;
    if (stall !== null && !world.count((e) => e.event === 'send-settled')) {
      await world.until((tr) => tr.filter((e) => e.event === 'frame' && e.dir === 'client->server').length > framesBefore || settled(tr), 'request frame of the retry at the server');
      if (!world.count((e) => e.event === 'send-settled')) await step(stall, { what: 'stall of the retry connection' });
    }
  }
};

// The case is over: every socket still open is closed by the recorder (its close handshake is awaited).
async function end() {
  const open = world.count((e) => e.event === 'open');
  if (world.conns.some((c) => c.ws.readyState === 1)) {
    world.note({ event: 'recorder-cleanup-close' });
    for (const c of world.conns) if (c.ws.readyState === 1) c.close(1000, 'recorder-end');
  }
  await world.until((t) => t.filter((e) => e.event === 'closed').length >= open, 'every socket closed');
}
const snapshot = () => world.trace.map((e) => ({ ...e }));
// A metadata frame every minute for `ms` of virtual time: the socket stays live.
const KEEPALIVE = { type: 'response.in_progress', response: { id: 'resp_1' } };
// A frame the client must have handled before the case goes on: the server sends it and then a ping; the client answers the ping (a recorded `pong` event) only after it has parsed and
// dispatched every frame sent before it, so the pong is the observable proof that the frame was handled.
// A client that already closed its socket (a watchdog fired) ends the delivery: nothing more is sent to it.
const deliver = async (frame) => {
  const pongs = world.count((e) => e.event === 'pong') + 1;
  const conn = world.conns.at(-1);
  if (conn.ws.readyState !== 1) return false;
  conn.send(frame);
  conn.ping(`handled-${pongs}`);
  await world.until(() => world.count((e) => e.event === 'pong') >= pongs || conn.ws.readyState !== 1, `client handled ${frame.type}`);
  return world.count((e) => e.event === 'pong') >= pongs;
};
const step = async (ms, options) => {
  await rec.clock.advance(ms, options);
  world.note({ event: 'clock-step', advanceMs: ms, nowMs: Date.now() - rec.T0 });
};
// The send of the four stall cases: the provider's real sender with the stall retry window of the logical send already spent (`sendOpts._stallRetryBudget`, the product's own option: the same
// object resolveStallRetryBudget reads), so the first stall surfaces as the send's error - what the Node test asserts - instead of being retried in place. The window is an input of the case.
const SPENT_STALL_BUDGET = { allowStallRetry: () => false, firstStallAt: 0 };
const stalled = (overrides = {}) => connect({ sendOpts: { _stallRetryBudget: SPENT_STALL_BUDGET }, ...overrides });
const keepalivesFor = async (ms) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 60_000) {
    await step(Math.min(60_000, ms - elapsed));
    if (!(await deliver(KEEPALIVE))) return;
  }
};

// One stream: the frames are the server's answer to the request frame; `close` = [code, reason] is the server closing afterwards; `abort` is the external signal's reason.
// `nextSend`: after the case's send settles, the next send on the same pool key and cache key (forceFresh off for both), answered `completed` with resp_2:
// what the first send left on the connection / pool (its response id, whether the socket is reusable) shows in that send's dial and request frame.
const NEXT_COMPLETED = [{ type: 'response.created', response: { id: 'resp_2', model: 'gpt-fixture' } }, { type: 'response.completed', response: { id: 'resp_2', model: 'gpt-fixture', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'next' }] }] } }];
async function stream(frames, { close = null, knownToolNames, abort = null, retries = [], nextSend = false } = {}) {
  serve([{ frames, close }, ...retries, ...(nextSend ? [{ frames: NEXT_COMPLETED }] : [])]);
  const controller = new AbortController();
  const reuse = nextSend ? { forceFresh: false } : {};
  // With a next send, both sends ask the server to store the response (`store: true`), the condition under which a pooled response id may anchor the next request.
  const nextBody = { ...BODY, store: true };
  const { outcome } = connect({ externalSignal: abort ? controller.signal : null, ...reuse, ...(nextSend ? { body: nextBody } : {}), ...(knownToolNames ? { body: { ...BODY, tools: knownToolNames.map((name) => ({ type: 'function', name })) } } : {}) });
  if (abort) {
    await world.until((t) => t.some((e) => e.event === 'progress' && e.kind === 'transport'), 'response.created handled');
    controller.abort(abort);
  }
  const out = await settle(outcome);
  let next;
  if (nextSend) {
    // The connection an aborted send closes is seen closed at the server before the next send starts, so that event precedes the next send's events.
    if (abort) await world.until((t) => t.filter((e) => e.event === 'closed').length >= t.filter((e) => e.event === 'open').length, 'the aborted send\'s connection closed at the server');
    world.note({ event: 'next-send' });
    next = await connect({ ...reuse, body: { ...nextBody, input: [...BODY.input, { type: 'message', role: 'user', content: 'next' }] } }).outcome;
  }
  await end();
  return { ...out, ...(nextSend ? { nextSend: next } : {}), events: snapshot() };
}
const row = (id, line, frames, options = {}) => rec.run(id, `${SRC}:${line}`, { frames, ...(options.close ? { close: options.close } : {}), ...(options.knownToolNames ? { knownToolNames: options.knownToolNames } : {}), ...(options.nextSend ? { nextSend: 'the next send on the same pool and cache key, forceFresh off, answered completed resp_2' } : {}) }, () => stream(frames, options));

await row('text-call-and-usage-in-one-result', 58, [
  created, { type: 'response.output_text.delta', delta: 'Hello ' }, { type: 'response.output_text.delta', delta: 'world' },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path"' }, { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"path":"a.txt"}' },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' } },
  { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-fixture', end_turn: false, usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }] } },
], { nextSend: true });
await row('call-id-only-in-completed-bundle-is-salvaged', 112, [created, { type: 'response.function_call_arguments.done', item_id: 'fc_late', arguments: '{"q":1}' }, { type: 'response.completed', response: { output: [{ type: 'function_call', id: 'fc_late', call_id: 'call_late', name: 'search' }] } }]);
await row('unsalvageable-call-fails', 112, [created, { type: 'response.function_call_arguments.done', item_id: 'fc_lost', arguments: '{}' }, { type: 'response.completed', response: { output: [] } }]);
const leaked = '<function_calls><invoke name="read"><parameter name="path">a.txt</parameter></invoke></function_calls>';
await row('leaked-tool-call-recovered-once', 140, [created, { type: 'response.output_text.delta', delta: 'Sure. ' }, { type: 'response.output_text.delta', delta: leaked }, { type: 'response.completed', response: { output: [] } }], { knownToolNames: ['read'] });
await row('max-output-tokens-truncated-success', 155, [created, { type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]);
await row('response-failed-rejects-with-frame', 155, [created, { type: 'response.failed', response: { error: { message: 'boom', code: 'server_error', status: 503 } } }]);
await row('response-done-cancelled-rejects', 155, [created, { type: 'response.done', response: { status: 'cancelled' } }]);
const halfFrames = [created, { type: 'response.output_text.delta', delta: 'half' }, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_open', call_id: 'c', name: 'n' } }];
await row('close-dropped-without-close-frame-before-terminal', 187, halfFrames, { close: 'drop' });
await row('close-frame-1011-gone-before-terminal', 187, halfFrames, { close: [1011, 'gone'] });
const done = { type: 'function_call', id: 'fc_done', call_id: 'call_done', name: 'read' };
await row('close-after-finished-call-carries-it', 203, [
  created, { type: 'response.output_item.added', item: done }, { type: 'response.function_call_arguments.done', item_id: 'fc_done', arguments: '{"path":"a.txt"}' },
  { type: 'response.output_item.done', item: { ...done, arguments: '{"path":"a.txt"}' } },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_open', call_id: 'call_open', name: 'edit' } }, { type: 'response.function_call_arguments.delta', item_id: 'fc_open', delta: '{"pa' },
], { close: 'drop' });
const abortRows = [['user-abort', new Error('stop')], ['watchdog-abort', Object.assign(new Error('stalled'), { name: 'AgentStallAbortError' })]];
for (const [id, reason] of abortRows) await rec.run(`external-abort-tags-${id}`, `${SRC}:361`, { frames: [created], abort: reason, nextSend: 'the next send on the same pool and cache key, forceFresh off, answered completed resp_2' }, () => stream([created], { abort: reason, nextSend: true }));

// ---- watchdogs on the virtual clock ----
const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [] };
const policy = { PROVIDER_FIRST_OUTPUT_TIMEOUT_MS, PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS, PROVIDER_FIRST_BYTE_TIMEOUT_MS, PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS };
const watchdog = (id, line, input, fn) => rec.run(id, `${SRC}:${line}`, { policy, ...input }, fn);
const closedBy = (e) => e.event === 'closed';

await watchdog('prestream-watchdog-closes-silent-socket-first-byte-timeout', 231, { frames: [], advanceMs: [PROVIDER_FIRST_BYTE_TIMEOUT_MS] }, async () => {
  serve([{ frames: [] }]);
  const { outcome } = connect();
  await world.until((t) => t.some((e) => e.event === 'frame' && e.dir === 'client->server'), 'request frame at the server');
  await step(PROVIDER_FIRST_BYTE_TIMEOUT_MS);
  const out = await settle(outcome, { stall: PROVIDER_FIRST_BYTE_TIMEOUT_MS });
  await end();
  return { ...out, events: snapshot() };
});
await watchdog('inter-chunk-stall-after-output-rejects-as-continuation', 245, { frames: [created, { type: 'response.output_text.delta', delta: 'kept' }], advanceMs: [PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS] }, async () => {
  serve([{ frames: [created, { type: 'response.output_text.delta', delta: 'kept' }] }]);
  const { outcome } = connect();
  await world.until((t) => t.some((e) => e.event === 'text'), 'text delta handled');
  await step(PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS);
  const out = await settle(outcome);
  await end();
  return { ...out, events: snapshot() };
});
const completed = { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-fixture', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] } };
await watchdog('silent-thinking-past-semantic-idle-until-first-output', 275, { frames: [created, KEEPALIVE, { type: 'response.output_item.added', item: reasoningItem }], keepalivesEveryMs: 60000, keepalivesForMs: PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS + 60_000, thenFrames: [{ type: 'response.output_item.done', item: reasoningItem }, { type: 'response.output_text.delta', delta: 'answer' }, completed] }, async () => {
  serve([{ frames: [created, KEEPALIVE, { type: 'response.output_item.added', item: reasoningItem }] }]);
  const { outcome } = connect();
  await world.until((t) => t.some((e) => e.event === 'progress'), 'reasoning handled');
  await keepalivesFor(PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS + 60_000);
  for (const frame of [{ type: 'response.output_item.done', item: reasoningItem }, { type: 'response.output_text.delta', delta: 'answer' }, completed]) world.conns.at(-1).send(frame);
  const out = await outcome;
  await end();
  return { ...out, events: snapshot() };
});
await watchdog('no-output-aborted-at-first-output-deadline', 298, { frames: [created, { type: 'response.output_item.added', item: reasoningItem }], keepalivesForMs: PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1, advanceMsAfter: 1, stallRetryBudget: 'spent' }, async () => {
  serve([{ frames: [created, { type: 'response.output_item.added', item: reasoningItem }] }]);
  const { outcome } = stalled();
  await world.until((t) => t.some((e) => e.event === 'progress'), 'reasoning handled');
  await keepalivesFor(PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1);
  await step(1);
  const out = await settle(outcome);
  await end();
  return { ...out, events: snapshot() };
});
await watchdog('semantic-idle-applies-after-first-output', 313, { frames: [created, { type: 'response.output_text.delta', delta: 'kept' }], keepalivesForMs: PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1, advanceMsAfter: 1, stallRetryBudget: 'spent' }, async () => {
  serve([{ frames: [created, { type: 'response.output_text.delta', delta: 'kept' }] }]);
  const { outcome } = stalled();
  await world.until((t) => t.some((e) => e.event === 'text'), 'text handled');
  await keepalivesFor(PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1);
  await step(1);
  const out = await settle(outcome);
  await end();
  return { ...out, events: snapshot() };
});
const sessionRequest = (sessionId) => {
  updateSessionStage(sessionId, 'requesting');
  return Date.now();
};
await watchdog('reopened-stream-aborts-at-original-request-deadline', 337, { sessionId: 'sess_ws_retry_deadline', firstFrames: [created, { type: 'response.output_item.added', item: reasoningItem }], firstKeepalivesForMs: 400_000, firstClose: [1006, 'gone'], retryFrames: [created], stallRetryBudget: 'spent' }, async () => {
  const sessionId = 'sess_ws_retry_deadline';
  const startedAt = sessionRequest(sessionId);
  serve([{ frames: [created, { type: 'response.output_item.added', item: reasoningItem }] }, { frames: [created] }]);
  try {
    const { outcome } = stalled({ poolKey: sessionId });
    await world.until((tr) => tr.some((e) => e.event === 'progress'), 'reasoning handled');
    await keepalivesFor(400_000);
    world.conns.at(-1).terminate();
    await followReconnect(0);
    const progressBefore = world.count((e) => e.event === 'progress');
    await world.until((tr) => tr.filter((e) => e.event === 'progress').length > progressBefore, 'retry response.created handled');
    const retryKeepaliveMs = startedAt + PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1 - Date.now();
    await keepalivesFor(retryKeepaliveMs);
    await step(1);
    const result = await settle(outcome);
    await end();
    return { startedAtMs: startedAt - rec.T0, retryKeepaliveMs, ...result, events: snapshot() };
  } finally {
    runtimeState.delete(sessionId);
  }
});
await watchdog('ws-retry-after-output-stays-under-semantic-idle', 360, { sessionId: 'sess_ws_retry_after_output', markDelta: 'reasoning', advanceMsBeforeRetry: 10_000, retryFrames: [created], keepalivesForMs: PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1, advanceMsAfter: 1, stallRetryBudget: 'spent' }, async () => {
  const sessionId = 'sess_ws_retry_after_output';
  sessionRequest(sessionId);
  serve([{ frames: [created] }]);
  try {
    await markSessionStreamDelta(sessionId, 'reasoning');
    await step(10_000);
    updateSessionStage(sessionId, 'requesting');
    const retry = stalled({ poolKey: sessionId });
    await world.until((t) => t.some((e) => e.event === 'progress'), 'retry response.created handled');
    await keepalivesFor(PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS - 1);
    await step(1);
    const out = await settle(retry.outcome);
    await end();
    return { retry: out, events: snapshot() };
  } finally {
    runtimeState.delete(sessionId);
  }
});
await rec.finish();
