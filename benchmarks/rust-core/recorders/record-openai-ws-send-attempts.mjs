#!/usr/bin/env node
// openai-ws-send-attempts.test.mjs (19 tests): the real `createWsSendAttempts` (handshakeFailed / streamFailed / exhausted), the real
// `createWsSendContext` reconnect stage, `emitProviderRetryStage`, `retryReasonClass`, `safeRetryErrorCode` and `providerTimeoutError`. The
// retry sleep is the test's injected `sleepFn` (it records the requested ms and returns at once), the progress / stage / trace callbacks
// record every argument, and the clock is the virtual clock (`retryAt` is `Date.now()` of it plus the advised wait).
//   node benchmarks/rust-core/recorders/record-openai-ws-send-attempts.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-ws-send-attempts',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/openai-ws-send-attempts.mjs createWsSendAttempts(opts) / openai-ws-send/send-context.mjs createWsSendContext(opts), provider-error-kind.mjs retryReasonClass / safeRetryErrorCode, retry-executor.mjs emitProviderRetryStage, stall-policy.mjs providerTimeoutError. Every failure is a scripted Error (own properties are the inputs); `attempts.state` and the error objects are read after each call.',
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
const SRC = 'src/runtime/agent/orchestrator/providers/openai-ws-send-attempts.test.mjs';

function harness(overrides = {}) {
  const progress = [];
  const details = [];
  const spanEvents = [];
  const sleeps = [];
  const sendSpan = { retryBackoffMs: 0, poolAcquireMs: 0, poolOwnerWaitMs: 0, emit(kind, target) { spanEvents.push([kind, target ?? null]); } };
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
await rec.run('reconnect-stage-names-failure-and-counts-down-advised-wait', `${SRC}:180`, { create: { auth: { type: 'xai' }, useModel: 'gpt-6.1-sol', traceProvider: 'xai' }, progress: [{ attempt: 1, max: 5, classifier: 'http_429', error: errorOf('Rate limit reached. Please try again in 210s.', { code: 'rate_limit_exceeded' }), waitMs: 210000 }, { attempt: 2, max: 5, classifier: 'ws_1006' }] }, () => {
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
await rec.run('safe-retry-error-code-keeps-only-known-codes', `${SRC}:284`, { known: ['rate_limit_exceeded', 'usage_limit_reached', 'server_is_overloaded', 'model_not_found'], unknown: ['acct_private-123', 'user_12345', 'sk-abc', 'prompt words'] }, () => {
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
await rec.run('token-refresh-timeout-classifies-as-auth', `${SRC}:354`, {}, () => {
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
await rec.finish();
