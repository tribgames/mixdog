#!/usr/bin/env node
// openai-ws-send-attempts.test.mjs (19 tests): the real `createWsSendAttempts` (handshakeFailed / streamFailed / exhausted), the real
// `createWsSendContext` reconnect stage, `emitProviderRetryStage`, `retryReasonClass`, `safeRetryErrorCode` and `providerTimeoutError`. The
// retry sleep is the test's injected `sleepFn` (it records the requested ms and returns at once), the progress / stage / trace callbacks
// record every argument, and the clock is the virtual clock (`retryAt` is `Date.now()` of it plus the advised wait).
// The cases whose failure comes from the wire (:86 an HTTP 401 on the upgrade, :124/:142/:374 a dropped connection, :153 a rate-limited response.failed frame, :431 a 1009
// close on the retry) are ALSO recorded over a real loopback WebSocket (`ws-*` case ids): the real `sendViaWebSocket` connects to it, the server's scripted answers
// are the inputs, and the case is ONE ordered list (dial, upgrade request with every header, frames each way, closes, the retry sleeps the product requests, the
// stage/progress callbacks). The retry sleep is the product's own `_sleepFn` injection point (records the requested ms, returns at once: no real waiting).
// Not over a socket: :74/:97/:111 (the handshake retry classifier table and budget are driven with constructed errors: the handshake retry layer sleeps with its own
// real timers, openai-ws-send/handshake-retry), :165/:180/:214/:284/:297/:325/:354/:362 (pure formatting of an already-built error or stage: no transport call exists),
// :392/:417/:464/:478 (they need a prior stored response id / duplicate-item server text the loopback cannot reproduce without a full session: kept on the state machine).
//   node benchmarks/rust-core/recorders/record-openai-ws-send-attempts.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  // Every case without a socket: the Node test builds the failure by hand against `createWsSendAttempts` / the formatting helpers. Where the same behaviour is reachable over the wire it is
  // ALSO recorded as a `ws-*` case (the state-machine rows :74 :86 :97 :111 :124 :142 :153 :165 :214 :374 :392 :431). What remains has no same-input/output public Rust function:
  // looked in crates/** (mixdog-ai, mixdog-core-api domain/provider.rs, mixdog-agent) for retry_reason_class / safe_retry_error_code / emit_provider_retry_stage / provider_timeout_error /
  // reconnecting-stage builders: none is public; the retry stage is produced inside the broker retry loop.
  pure: { '*': 'RUST WORK: no public Rust function takes the same input/output (see the recorder header: the retry stage and its reason class exist only inside the broker retry loop); the wire `ws-*` cases are the replayable form' },
  set: 'provider-openai-ws-send-attempts',
  net: false,
  exclusions: ['result.error.props.transportTiming.*Ms and result.result.transportTiming.*Ms of the ws-* cases: performance.now() durations of the real clock, written as a marker (the keys stay)'],
  maskRow: (row) => {
    const walk = (value) => {
      if (!value || typeof value !== 'object') return;
      if (value.transportTiming && typeof value.transportTiming === 'object') for (const [k, v] of Object.entries(value.transportTiming)) if (/Ms$/.test(k) && typeof v === 'number') value.transportTiming[k] = '<ms, real clock>';
      for (const child of Object.values(value)) walk(child);
    };
    if (row.id?.startsWith('ws-')) walk(row.result);
  },
  entry: 'src/runtime/agent/orchestrator/providers/openai-ws-send-attempts.mjs createWsSendAttempts(opts) / openai-ws-send/send-context.mjs createWsSendContext(opts), provider-error-kind.mjs retryReasonClass / safeRetryErrorCode, retry-executor.mjs emitProviderRetryStage, stall-policy.mjs providerTimeoutError. The state-machine cases feed a scripted Error (own properties are the inputs) and read `attempts.state` and the error objects after each call; the `ws-*` cases run sendViaWebSocket over a real loopback WebSocket.',
  compare: 'mixdog-agent send.rs:541-664 (retry loop, advised wait, reasons), mixdog-ai retry decider.rs:55-57,172-185 and retry advice.rs, openai adapter.rs: feed each case\'s scripted errors / midState and compare `results`, `progress`, `sleeps`, `details`, `traces`, `stages` and the error fields. K1 gap G10 (exhaustion surfaces the first error, not the last) and G1 (xAI WS carry-forward) are OPEN in the core, so those cases are expected to differ.',
  replay: "Rust entry (pub, on o1): mixdog_ai::broker ModelBroker::send (broker/send.rs:75) with mixdog_ai::retry StandardRetryDecider (retry/decider.rs:35), retry::classify::kind_of (retry/classify.rs:142) and retry::advice::from_headers (retry/advice.rs:25). The helper createWsSendAttempts / createWsSendContext have no Rust item of that name: the behaviour is the broker's retry loop; the first-error-with-cause exhaustion is K1 G10, work for the Rust side.",
});
const P = 'agent/orchestrator/providers/';
const { createStreamSafetyStamps } = await rec.P(`${P}retry-classifier.mjs`);
const { createWsSendAttempts, MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT } = await rec.P(`${P}openai-ws-send-attempts.mjs`);
const { createWsSendContext } = await rec.P(`${P}openai-ws-send/send-context.mjs`);
const { retryReasonClass, safeRetryErrorCode } = await rec.P(`${P}provider-error-kind.mjs`);
const { providerTimeoutError } = await rec.P('agent/orchestrator/stall-policy.mjs');
const { emitProviderRetryStage } = await rec.P(`${P}retry-executor.mjs`);
const { sendViaWebSocket } = await rec.P(`${P}openai-oauth-ws.mjs`);
const world = await rec.wsWorld();
const SRC = 'src/runtime/agent/orchestrator/providers/openai-ws-send-attempts.test.mjs';

function harness(overrides = {}) {
  const progress = [];
  const details = [];
  const spanEvents = [];
  const sleeps = [];
  const sendSpan = { retryBackoffMs: 0, poolAcquireMs: 0, poolOwnerWaitMs: 0, emit(kind, target) { spanEvents.push([kind, target]); } };
  const attempts = createWsSendAttempts({
    externalSignal: null, sleepFn: async (ms) => { sleeps.push(ms); }, sendSpan,
    emitReconnectProgress: (p) => { progress.push({ attempt: p.attempt, max: p.max, classifier: p.classifier }); details.push(p); },
    safetyStamps: createStreamSafetyStamps(), handshakeErrorPolicy: null, retry429: true, stallRetryBudget: { allowStallRetry: () => true },
    trace: { poolKey: 'send-attempts-test', traceProvider: 'openai-oauth', useModel: 'gpt-5' }, auth: null, body: {}, ...overrides,
  });
  return { attempts, progress, details, spanEvents, sleeps, sendSpan };
}
const fakeEntry = (extra = {}) => ({ socket: { readyState: 3, close() {}, terminate() {} }, busy: true, lastResponseId: null, ...extra });
const midState = (extra = {}) => ({ attemptIndex: 0, sawResponseCreated: true, sawCompleted: false, emittedText: false, emittedToolCall: false, emittedReasoning: false, startedToolCall: false, ...extra });
const handshakeInfo = (attemptIndex) => ({ attemptIndex, handshakeStart: 0, handshakeRetries: 0, handshakeRetryClassifiers: [] });
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const logs = (h) => ({ progress: h.progress, details: h.details, spanEvents: h.spanEvents, sleeps: h.sleeps });
const errorOf = (message, props) => ({ message, props });
const make = ({ message, props }) => Object.assign(new Error(message), props);
const LIMIT = MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT;

await rec.run('handshake-transient-connect-error-spends-budget-and-retries', `${SRC}:74`, { limit: LIMIT, error: errorOf('reset', { code: 'ECONNRESET' }), info: handshakeInfo(0) }, async () => {
  const h = harness();
  const err = make(errorOf('reset', { code: 'ECONNRESET' }));
  const out = await settle(h.attempts.handshakeFailed(err, handshakeInfo(0)));
  return { out, error: err, ...logs(h), firstAttemptErrorIsTheError: h.attempts.state.firstAttemptError === err, firstAttemptClassifier: h.attempts.state.firstAttemptClassifier };
});
await rec.run('handshake-http-401-surfaces-immediately', `${SRC}:86`, { error: errorOf('unauthorized', { httpStatus: 401 }), info: handshakeInfo(0) }, async () => {
  const h = harness();
  const err = make(errorOf('unauthorized', { httpStatus: 401 }));
  const out = await settle(h.attempts.handshakeFailed(err, handshakeInfo(0)));
  return { rejectedWithTheError: out.error === err, error: err, ...logs(h), spanEventTargetIsTheError: h.spanEvents[0]?.[1] === err };
});
await rec.run('handshake-policy-veto-tagged-for-http-fallback', `${SRC}:97`, { policy: 'retry:false, httpFallback when classifier === http_503', error: errorOf('unavailable', { httpStatus: 503 }), info: handshakeInfo(0) }, async () => {
  const h = harness({ handshakeErrorPolicy: ({ classifier }) => ({ retry: false, httpFallback: classifier === 'http_503' }) });
  const err = make(errorOf('unavailable', { httpStatus: 503 }));
  const out = await settle(h.attempts.handshakeFailed(err, handshakeInfo(0)));
  return { rejectedWithTheError: out.error === err, error: err, ...logs(h) };
});
await rec.run('handshake-budget-spent-first-attempt-error-surfaces-exhausted', `${SRC}:111`, { first: errorOf('first reset', { code: 'ECONNRESET' }), last: errorOf('last reset', { code: 'ECONNRESET' }), lastAttemptIndex: LIMIT }, async () => {
  const h = harness();
  const first = make(errorOf('first reset', { code: 'ECONNRESET' }));
  const firstOut = await settle(h.attempts.handshakeFailed(first, handshakeInfo(0)));
  const last = make(errorOf('last reset', { code: 'ECONNRESET' }));
  const lastOut = await settle(h.attempts.handshakeFailed(last, handshakeInfo(LIMIT)));
  return { firstOut, lastRejectedWithFirst: lastOut.error === first, first, last, ...logs(h) };
});
await rec.run('stream-abnormal-close-before-output-releases-socket-and-retries', `${SRC}:124`, { error: errorOf('gone', { wsCloseCode: 1006 }), midState: midState() }, async () => {
  const h = harness();
  const entry = fakeEntry();
  let closed = false;
  entry.socket.close = () => { closed = true; };
  const err = make(errorOf('gone', { wsCloseCode: 1006 }));
  const out = await settle(h.attempts.streamFailed(err, { attemptIndex: 0, entry, midState: midState() }));
  return { out, socketClosed: closed, entryBusy: entry.busy, error: err, streamOutcomeType: typeof err.streamOutcome, ...logs(h) };
});
await rec.run('stream-cut-while-tool-input-streams-surfaces', `${SRC}:142`, { error: errorOf('gone', { wsCloseCode: 1006, pendingToolUse: true }), midState: midState() }, async () => {
  const h = harness();
  const err = make(errorOf('gone', { wsCloseCode: 1006, pendingToolUse: true }));
  const out = await settle(h.attempts.streamFailed(err, { attemptIndex: 0, entry: fakeEntry(), midState: midState() }));
  return { rejectedWithTheError: out.error === err, error: err, ...logs(h) };
});
const rateLimited = errorOf('rate limited', { responseFailed: { response: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 1.5s.' } } } });
await rec.run('stream-rate-limited-response-failed-waits-advised-time', `${SRC}:153`, { error: rateLimited, midState: midState() }, async () => {
  const h = harness();
  const err = make(rateLimited);
  const out = await settle(h.attempts.streamFailed(err, { attemptIndex: 0, entry: fakeEntry(), midState: midState() }));
  return { out, error: err, ...logs(h) };
});
const longWait = errorOf('OpenAI OAuth WS error: Rate limit reached. Please try again in 210s.', { responseFailed: { type: 'error', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 210s.' } } });
await rec.run('stream-long-advised-wait-announced-before-it-starts', `${SRC}:165`, { error: longWait, midState: midState({ sawResponseCreated: false }) }, async () => {
  const h = harness();
  const err = make(longWait);
  const out = await settle(h.attempts.streamFailed(err, { attemptIndex: 0, entry: fakeEntry(), midState: midState({ sawResponseCreated: false }) }));
  return { out, error: err, ...logs(h), detailErrorIsTheError: h.details[0]?.error === err };
});
await rec.run('reconnect-stage-names-failure-and-counts-down-advised-wait', `${SRC}:181`, { create: { auth: { type: 'xai' }, useModel: 'gpt-6.1-sol', traceProvider: 'xai' }, progress: [{ attempt: 1, max: 5, classifier: 'http_429', error: errorOf('Rate limit reached. Please try again in 210s.', { code: 'rate_limit_exceeded' }), waitMs: 210000 }, { attempt: 2, max: 5, classifier: 'ws_1006' }] }, () => {
  const stages = [];
  const ctx = createWsSendContext({ auth: { type: 'xai' }, body: {}, sendOpts: {}, onStageChange: (stage, detail) => stages.push([stage, detail]), externalSignal: null, poolKey: 'send-context-test', cacheKey: null, iteration: 0, useModel: 'gpt-6.1-sol', traceProvider: 'xai', _sendSpanTraceFn: () => {} });
  const before = Date.now();
  ctx.emitReconnectProgress({ attempt: 1, max: 5, classifier: 'http_429', error: make(errorOf('Rate limit reached. Please try again in 210s.', { code: 'rate_limit_exceeded' })), waitMs: 210_000 });
  ctx.emitReconnectProgress({ attempt: 2, max: 5, classifier: 'ws_1006' });
  return { clockNowMs: before, stages };
});
const markers = ['PROMPT_MARKER_7f3a', 'sk-TOKEN_MARKER_9b2c', 'acct_ACCOUNT_MARKER_44d1'];
const serverText = `Rate limit reached for "${markers[0]}" (key ${markers[1]}, account ${markers[2]}). Please try again in 3s.`;
const redactionErrors = [
  errorOf(`OpenAI OAuth WS error: ${serverText}`, { responseFailed: { type: 'error', status: 429, error: { code: 'rate_limit_exceeded', message: serverText } }, httpStatus: 429 }),
  errorOf(serverText, { responseFailed: { response: { error: { code: `bad ${markers[0]}`, message: serverText } } } }),
  errorOf(serverText, { responseFailed: { response: { error: { code: 'acct_private-123', message: serverText } } } }),
];
await rec.run('server-error-text-never-reaches-retry-trace-or-status', `${SRC}:222`, { errors: redactionErrors, markers }, async () => {
  const stages = [];
  const traces = [];
  const ctx = createWsSendContext({ auth: { type: 'xai' }, body: {}, sendOpts: {}, onStageChange: (stage, detail) => stages.push([stage, detail]), externalSignal: null, poolKey: 'redaction-test', cacheKey: null, iteration: 0, useModel: 'gpt-6.1-sol', traceProvider: 'xai', _sleepFn: async () => {}, _sendSpanTraceFn: () => {}, _agentTraceFn: (row) => traces.push(row) });
  const results = [];
  for (const [index, spec] of redactionErrors.entries()) results.push(await ctx.attempts.streamFailed(make(spec), { attemptIndex: index, entry: fakeEntry(), midState: midState({ attemptIndex: index }) }));
  const visible = JSON.stringify({ traces, stages });
  return { results, traces, stages, leaked: [...markers, 'acct_private-123', 'Rate limit reached for'].map((text) => [text, visible.includes(text)]) };
});
await rec.run('safe-retry-error-code-keeps-only-known-codes', `${SRC}:272`, { known: ['rate_limit_exceeded', 'usage_limit_reached', 'server_is_overloaded', 'model_not_found'], unknown: ['acct_private-123', 'user_12345', 'sk-abc', 'prompt words'] }, () => {
  const coded = (code) => Object.assign(new Error('x'), { responseFailed: { error: { code } } });
  return Object.fromEntries(['rate_limit_exceeded', 'usage_limit_reached', 'server_is_overloaded', 'model_not_found', 'acct_private-123', 'user_12345', 'sk-abc', 'prompt words'].map((code) => [code, safeRetryErrorCode(coded(code))]));
});
await rec.run('retry-stage-takes-reason-class-never-caller-text', `${SRC}:297`, { calls: [{ attempt: 1, maxAttempts: 5, delayMs: 1000, reason: 'INJECTED_REASON_TEXT', reasonClass: 'INJECTED_CLASS text' }, { attempt: 1, maxAttempts: 5, delayMs: 1000, reasonClass: 'overloaded' }] }, () => {
  const stages = [];
  emitProviderRetryStage((_stage, detail) => stages.push(detail), { attempt: 1, maxAttempts: 5, lastErr: new Error('x'), delayMs: 1_000, reason: 'INJECTED_REASON_TEXT', reasonClass: 'INJECTED_CLASS text' });
  emitProviderRetryStage((_stage, detail) => stages.push(detail), { attempt: 1, maxAttempts: 5, lastErr: new Error('x'), delayMs: 1_000, reasonClass: 'overloaded' });
  return { stages };
});
const stageFor = (lastErr, extra = {}) => {
  const stages = [];
  emitProviderRetryStage((_stage, detail) => stages.push(detail), { attempt: 1, maxAttempts: 5, lastErr, delayMs: 1_000, ...extra });
  return stages[0];
};
await rec.run('typed-timeouts-keep-their-own-wording', `${SRC}:325`, {}, () => ({
  cursor: stageFor(providerTimeoutError('Cursor request', 5_000)),
  anthropic: stageFor(Object.assign(new Error('Anthropic SSE stream produced no message_start within 45000ms'), { code: 'EEMPTYSTREAM', isEmptyStream: true, firstByteTimeout: true })),
  ws: stageFor(Object.assign(new Error('WS stream: no first server event within 10000ms'), { firstByteTimeout: true })),
  stall: stageFor(Object.assign(new Error('Responses WS timed out after 60000ms of inactivity'), { name: 'StreamStalledError' })),
}));
await rec.run('token-refresh-timeout-classifies-as-auth', `${SRC}:345`, {}, () => {
  const refresh = Object.assign(new Error('OpenAI OAuth token refresh timed out after 30000ms'), { timeoutPhase: 'auth' });
  return { reasonClass: retryReasonClass(refresh), stage: stageFor(refresh) };
});
await rec.run('injected-label-or-unknown-code-never-reaches-retry-stage', `${SRC}:362`, {}, () => {
  const err = Object.assign(new Error('first byte timed out after 60000ms'), { timeoutPhase: 'headers', providerLabel: 'INJECTED_LABEL', code: 'acct_INJECTED_CODE' });
  return { detail: stageFor(err), withLabel: stageFor(err, { providerLabel: 'Antigravity' }) };
});
await rec.run('stream-relayed-text-latches-no-replay-and-surfaces', `${SRC}:374`, { error: errorOf('gone', { wsCloseCode: 1006 }), midState: midState({ emittedText: true }), later: errorOf('later', {}) }, async () => {
  const h = harness();
  const err = make(errorOf('gone', { wsCloseCode: 1006 }));
  const out = await settle(h.attempts.streamFailed(err, { attemptIndex: 0, entry: fakeEntry(), midState: midState({ emittedText: true }) }));
  const after = { rejectedWithTheError: out.error === err, error: err, ...logs(h) };
  const later = new Error('later');
  const laterOut = await settle(h.attempts.streamFailed(later, { attemptIndex: 1, entry: fakeEntry(), midState: midState({ attemptIndex: 1 }) }));
  return { after, later: { rejectedWithTheError: laterOut.error === later, error: later } };
});
await rec.run('stream-duplicate-reasoning-rejection-strips-replay-once', `${SRC}:392`, { first: errorOf('Duplicate item rs_abc123 already exists', { httpStatus: 400 }), again: errorOf('Duplicate item rs_def456 already exists', { httpStatus: 400 }), entry: { replayReasoning: true } }, async () => {
  const h = harness();
  const err = make(errorOf('Duplicate item rs_abc123 already exists', { httpStatus: 400 }));
  const entry = fakeEntry({ replayReasoning: true });
  const out = await settle(h.attempts.streamFailed(err, { attemptIndex: 0, entry, midState: midState() }));
  const firstStep = { out, suppressReasoningReplay: h.attempts.state.suppressReasoningReplay, error: err, ...logs(h) };
  const again = make(errorOf('Duplicate item rs_def456 already exists', { httpStatus: 400 }));
  const againOut = await settle(h.attempts.streamFailed(again, { attemptIndex: 1, entry, midState: midState({ attemptIndex: 1 }) }));
  return { firstStep, second: { rejectedWithTheFirstError: againOut.error === err, error: again } };
});
await rec.run('stream-exhausted-budget-first-error-with-last-as-cause', `${SRC}:417`, { first: errorOf('first', { wsCloseCode: 1006 }), last: errorOf('last', { wsCloseCode: 1006 }), lastAttemptIndex: LIMIT }, async () => {
  const h = harness();
  const first = make(errorOf('first', { wsCloseCode: 1006 }));
  const firstOut = await settle(h.attempts.streamFailed(first, { attemptIndex: 0, entry: fakeEntry(), midState: midState() }));
  const last = make(errorOf('last', { wsCloseCode: 1006 }));
  const lastOut = await settle(h.attempts.streamFailed(last, { attemptIndex: LIMIT, entry: fakeEntry(), midState: midState({ attemptIndex: LIMIT }) }));
  return { firstOut, lastRejectedWithFirst: lastOut.error === first, causeIsTheLast: first.cause === last, first, last };
});
await rec.run('stream-server-1009-on-retry-surfaces-itself', `${SRC}:443`, { first: errorOf('first', { wsCloseCode: 1006 }), tooBig: errorOf('too big', { wsCloseCode: 1009 }) }, async () => {
  const h = harness();
  const first = make(errorOf('first', { wsCloseCode: 1006 }));
  const firstOut = await settle(h.attempts.streamFailed(first, { attemptIndex: 0, entry: fakeEntry(), midState: midState() }));
  const tooBig = make(errorOf('too big', { wsCloseCode: 1009 }));
  const out = await settle(h.attempts.streamFailed(tooBig, { attemptIndex: 1, entry: fakeEntry(), midState: midState({ attemptIndex: 1 }) }));
  return { firstOut, rejectedWithTooBig: out.error === tooBig, tooBig, progress: h.progress };
});
await rec.run('stream-stored-xai-anchor-carried-into-next-attempt', `${SRC}:464`, { stored: { auth: { type: 'xai' }, body: { store: true }, entry: { lastResponseId: 'resp_1', lastInputLen: 3, lastResponseItems: [{ id: 'msg_1' }] } }, notStored: { auth: { type: 'xai' }, body: { store: false }, entry: { lastResponseId: 'resp_2' } } }, async () => {
  const h = harness({ auth: { type: 'xai' }, body: { store: true } });
  const entry = fakeEntry({ lastResponseId: 'resp_1', lastInputLen: 3, lastResponseItems: [{ id: 'msg_1' }] });
  const stored = { out: await settle(h.attempts.streamFailed(make(errorOf('gone', { wsCloseCode: 1006 })), { attemptIndex: 0, entry, midState: midState() })), carryForwardCache: h.attempts.state.carryForwardCache };
  const h2 = harness({ auth: { type: 'xai' }, body: { store: false } });
  const notStored = { out: await settle(h2.attempts.streamFailed(make(errorOf('gone', { wsCloseCode: 1006 })), { attemptIndex: 0, entry: fakeEntry({ lastResponseId: 'resp_2' }), midState: midState() })), carryForwardCache: h2.attempts.state.carryForwardCache };
  return { stored, notStored };
});
await rec.run('exhausted-falls-back-to-first-error-or-unreachable-marker', `${SRC}:478`, { first: errorOf('first', { code: 'ECONNRESET' }) }, async () => {
  const h = harness();
  const unreachable = h.attempts.exhausted();
  const first = make(errorOf('first', { code: 'ECONNRESET' }));
  await h.attempts.handshakeFailed(first, handshakeInfo(0));
  const afterFirst = h.attempts.exhausted();
  return { unreachable, afterFirstIsTheFirstError: afterFirst === first, afterFirst, maxMidstreamRetries: h.attempts.maxMidstreamRetries, limit: LIMIT };
});
// ---- over a real loopback WebSocket ----
const completed = (id) => [{ type: 'response.created', response: { id, model: 'gpt-fixture' } }, { type: 'response.completed', response: { id, model: 'gpt-fixture', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } } }];
async function overSocket(plans, { refusals = [], poolKey, sendExtras = {}, body = { model: 'gpt-fixture', input: [{ type: 'message', role: 'user', content: 'hi' }] } }) {
  let connections = 0;
  world.reset({
    refuse: (_req, n) => refusals[n - 1],
    onFrame: (conn) => {
      const plan = plans[connections++];
      for (const frame of plan.frames) conn.send(frame);
      if (plan.close) (plan.close[0] === 1006 ? conn.terminate() : conn.close(plan.close[0], plan.close[1]));
    },
  });
  // The send's own backoff sleeps run on the virtual clock: every armed retry sleep is advanced to (a recorded step) until the send ends.
  const settled = sendViaWebSocket({
    auth: { type: 'xai', access_token: 'fixture-access-token' }, body, poolKey, cacheKey: 'send-attempts-ws', iteration: 0, useModel: 'gpt-fixture', traceProvider: 'xai', forceFresh: true,
    onStageChange: (stage, detail) => world.note({ event: 'stage', stage, detail }),
    onTextDelta: (chunk) => world.note({ event: 'text', chunk }),
    onStreamDelta: (kind) => world.note({ event: 'progress', kind }),
    ...sendExtras,
  }).then((result) => ({ result }), (error) => ({ error }));
  const outcome = await rec.clock.followRetries(settled);
  for (const conn of world.conns) conn.close(1000, 'recorder-end');
  await world.until((trace) => trace.every((e) => e.event !== 'open') || trace.filter((e) => e.event === 'closed').length >= trace.filter((e) => e.event === 'open').length, 'all sockets closed');
  return { ...outcome, events: world.trace.map((e) => ({ ...e })) };
}
await rec.run('ws-http-401-on-upgrade-surfaces-immediately', `${SRC}:86`, { refusals: [401] }, () => overSocket([], { refusals: [{ status: 401, headers: [['content-type', 'application/json']], body: '{"error":{"message":"unauthorized"}}' }], poolKey: 'sa-401' }));
await rec.run('ws-abnormal-close-before-output-retries-on-a-new-socket', `${SRC}:124`, { connections: ['frames: none, then the server drops the connection (1006)', 'completed'] }, () => overSocket([{ frames: [], close: [1006, ''] }, { frames: completed('resp_retry') }], { poolKey: 'sa-1006' }));
await rec.run('ws-cut-while-tool-input-streams-surfaces', `${SRC}:142`, { connections: ['created + function_call item added, then the drop (1006)'] }, () => overSocket([{ frames: [{ type: 'response.created', response: { id: 'resp_cut', model: 'gpt-fixture' } }, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' } }], close: [1006, ''] }], { poolKey: 'sa-cut' }));
await rec.run('ws-rate-limited-response-failed-waits-advised-time', `${SRC}:153`, { connections: ['response.failed rate_limit_exceeded "try again in 1.5s"', 'completed'] }, () => overSocket([{ frames: [{ type: 'response.failed', response: { id: 'resp_rl', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 1.5s.' } } }] }, { frames: completed('resp_after') }], { poolKey: 'sa-rl' }));
await rec.run('ws-relayed-text-then-drop-surfaces-without-replay', `${SRC}:374`, { connections: ['created + text delta, then the drop (1006)'] }, () => overSocket([{ frames: [{ type: 'response.created', response: { id: 'resp_t', model: 'gpt-fixture' } }, { type: 'response.output_text.delta', delta: 'half' }], close: [1006, ''] }], { poolKey: 'sa-text' }));
await rec.run('ws-server-1009-on-retry-surfaces-itself', `${SRC}:431`, { connections: ['drop (1006)', 'close 1009 message too big'] }, () => overSocket([{ frames: [], close: [1006, ''] }, { frames: [], close: [1009, 'too big'] }], { poolKey: 'sa-1009' }));
// ---- more state-machine cases over the socket (the Node tests build the failures by hand; the wire produces them) ----
await rec.run('ws-connection-reset-on-every-upgrade-spends-budget-then-surfaces-first-error', `${SRC}:111`, { refusals: 'every upgrade request: the server resets the connection', note: 'also covers :74 (a transient connect error spends the budget and retries)' }, () => overSocket([], { refusals: Array.from({ length: 12 }, () => ({ reset: true })), poolKey: 'sa-reset' }));
await rec.run('ws-policy-veto-503-on-upgrade-tagged-for-http-fallback', `${SRC}:97`, { refusals: [503], handshakeErrorPolicy: 'retry:false, httpFallback when classifier === http_503' }, () => overSocket([], { refusals: [{ status: 503, headers: [['content-type', 'application/json']], body: '{"error":{"message":"unavailable"}}' }], poolKey: 'sa-503', sendExtras: { handshakeErrorPolicy: ({ classifier }) => ({ retry: false, httpFallback: classifier === 'http_503' }) } }));
await rec.run('ws-long-advised-wait-announced-before-it-starts', `${SRC}:165`, { connections: ['response.failed rate_limit_exceeded "try again in 90s"', 'completed'] }, () => overSocket([{ frames: [{ type: 'response.failed', response: { id: 'resp_long', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 90s.' } } }] }, { frames: completed('resp_long_retry') }], { poolKey: 'sa-long' }));
await rec.run('ws-server-error-text-never-reaches-retry-stage', `${SRC}:214`, { connections: ['response.failed server_error with echoed prompt, token and account in the message', 'completed'] }, () => overSocket([{ frames: [{ type: 'response.failed', response: { id: 'resp_echo', error: { code: 'server_error', message: 'upstream echoed prompt "hi", token sk-LEAK-fixture and account acct-LEAK-fixture' } } }] }, { frames: completed('resp_echo_retry') }], { poolKey: 'sa-echo' }));
await rec.run('ws-duplicate-reasoning-rejection-strips-replay-once', `${SRC}:392`, { connections: ['response.failed: duplicate item rs_dup already exists', 'completed'], requestInput: 'a user message and a reasoning item rs_dup' }, () => overSocket([{ frames: [{ type: 'response.failed', response: { id: 'resp_dup', error: { code: 'invalid_request_error', message: 'Duplicate item found with id rs_dup. Reasoning item already exists.' } } }] }, { frames: completed('resp_dup_retry') }], { poolKey: 'sa-dup', body: { model: 'gpt-fixture', input: [{ type: 'message', role: 'user', content: 'hi' }, { type: 'reasoning', id: 'rs_dup', summary: [], encrypted_content: 'enc' }] } }));
await rec.finish();
