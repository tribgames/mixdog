import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamSafetyStamps } from './retry-classifier.mjs';
import { createWsSendAttempts, MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT } from './openai-ws-send-attempts.mjs';

function harness(overrides = {}) {
  const progress = [];
  const spanEvents = [];
  const sleeps = [];
  const sendSpan = {
    retryBackoffMs: 0,
    poolAcquireMs: 0,
    poolOwnerWaitMs: 0,
    emit(kind, target) {
      spanEvents.push([kind, target ?? null]);
    },
  };
  const attempts = createWsSendAttempts({
    externalSignal: null,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
    sendSpan,
    emitReconnectProgress: (p) => progress.push(p),
    stampWarmup: (e) => {
      e.warmupStamped = true;
      return e;
    },
    safetyStamps: createStreamSafetyStamps(),
    handshakeErrorPolicy: null,
    retry429: true,
    stallRetryBudget: { allowStallRetry: () => true },
    trace: { poolKey: 'send-attempts-test', traceProvider: 'openai-oauth', useModel: 'gpt-5' },
    auth: null,
    body: {},
    ...overrides,
  });
  return { attempts, progress, spanEvents, sleeps, sendSpan };
}

function fakeEntry(extra = {}) {
  return {
    socket: { readyState: 3, close() {}, terminate() {} },
    busy: true,
    lastResponseId: null,
    ...extra,
  };
}

function midState(extra = {}) {
  return {
    attemptIndex: 0,
    sawResponseCreated: true,
    sawCompleted: false,
    emittedText: false,
    emittedToolCall: false,
    emittedReasoning: false,
    startedToolCall: false,
    ...extra,
  };
}

const handshakeInfo = (attemptIndex) => ({
  attemptIndex,
  handshakeStart: 0,
  handshakeRetries: 0,
  handshakeRetryClassifiers: [],
});

test('handshakeFailed: a transient connect error spends the stream budget and retries', async () => {
  const h = harness();
  const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  assert.equal(await h.attempts.handshakeFailed(err, handshakeInfo(0)), true);
  assert.equal(err.wsFailurePhase, 'handshake');
  assert.equal(err.midstreamClassifier, 'reset');
  assert.equal(err.warmupStamped, true);
  assert.deepEqual(h.progress, [{ attempt: 1, max: MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT, classifier: 'reset' }]);
  assert.equal(h.sleeps.length, 1);
  assert.equal(h.attempts.state.firstAttemptError, err);
  assert.equal(h.attempts.state.firstAttemptClassifier, 'reset');
});

test('handshakeFailed: HTTP 401 is surfaced to the caller immediately', async () => {
  const h = harness();
  const err = Object.assign(new Error('unauthorized'), { httpStatus: 401 });
  await assert.rejects(
    () => h.attempts.handshakeFailed(err, handshakeInfo(0)),
    (e) => e === err
  );
  assert.deepEqual(h.progress, []);
  assert.deepEqual(h.spanEvents, [['error', err]]);
});

test('handshakeFailed: a policy veto surfaces the error tagged for HTTP fallback', async () => {
  const h = harness({
    handshakeErrorPolicy: ({ classifier }) => ({ retry: false, httpFallback: classifier === 'http_503' }),
  });
  const err = Object.assign(new Error('unavailable'), { httpStatus: 503 });
  await assert.rejects(
    () => h.attempts.handshakeFailed(err, handshakeInfo(0)),
    (e) => e === err
  );
  assert.equal(err.wsHttpFallbackEligible, true);
  assert.equal(err.retryClassifier, 'http_503');
  assert.deepEqual(h.spanEvents, [['error', null]]);
});

test('handshakeFailed: once the budget is spent the first-attempt error surfaces as exhausted', async () => {
  const h = harness();
  const first = Object.assign(new Error('first reset'), { code: 'ECONNRESET' });
  assert.equal(await h.attempts.handshakeFailed(first, handshakeInfo(0)), true);
  const last = Object.assign(new Error('last reset'), { code: 'ECONNRESET' });
  await assert.rejects(
    () => h.attempts.handshakeFailed(last, handshakeInfo(MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT)),
    (e) => e === first
  );
  assert.equal(first.midstreamRetries, MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT);
  assert.equal(first.wsRetriesExhausted, true);
});

test('streamFailed: an abnormal close before any output releases the socket and retries', async () => {
  const h = harness();
  const entry = fakeEntry();
  let closed = false;
  entry.socket.close = () => {
    closed = true;
  };
  const err = Object.assign(new Error('gone'), { wsCloseCode: 1006 });
  assert.equal(await h.attempts.streamFailed(err, { attemptIndex: 0, entry, midState: midState() }), true);
  assert.equal(closed, true);
  assert.equal(entry.busy, false);
  assert.equal(err.wsFailurePhase, 'stream');
  assert.equal(err.midstreamClassifier, 'ws_1006');
  assert.equal(typeof err.streamOutcome, 'object');
  assert.deepEqual(h.progress, [{ attempt: 1, max: MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT, classifier: 'ws_1006' }]);
  assert.equal(h.sleeps.length, 1);
});

test('streamFailed: relayed text latches the no-replay marker and surfaces the error', async () => {
  const h = harness();
  const err = Object.assign(new Error('gone'), { wsCloseCode: 1006 });
  await assert.rejects(
    () =>
      h.attempts.streamFailed(err, { attemptIndex: 0, entry: fakeEntry(), midState: midState({ emittedText: true }) }),
    (e) => e === err
  );
  assert.equal(err.liveTextEmitted, true);
  assert.equal(err.unsafeToRetry, true);
  assert.deepEqual(h.progress, []);
  // The latch outlives the attempt: a later error of this send is stamped too.
  const later = new Error('later');
  await assert.rejects(
    () =>
      h.attempts.streamFailed(later, { attemptIndex: 1, entry: fakeEntry(), midState: midState({ attemptIndex: 1 }) }),
    (e) => e.liveTextEmitted === true
  );
});

test('streamFailed: a duplicate-reasoning rejection strips replay once without backoff', async () => {
  const h = harness();
  const err = Object.assign(new Error('Duplicate item rs_abc123 already exists'), { httpStatus: 400 });
  const entry = fakeEntry({ replayReasoning: true });
  assert.equal(await h.attempts.streamFailed(err, { attemptIndex: 0, entry, midState: midState() }), true);
  assert.equal(h.attempts.state.suppressReasoningReplay, true);
  assert.equal(err.midstreamClassifier, 'reasoning_replay_rejected');
  assert.deepEqual(h.progress, [
    { attempt: 1, max: MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT, classifier: 'reasoning_replay_rejected' },
  ]);
  assert.equal(h.sleeps.length, 0);
  // Second rejection of the same send is no longer eligible.
  const again = Object.assign(new Error('Duplicate item rs_def456 already exists'), { httpStatus: 400 });
  await assert.rejects(
    () => h.attempts.streamFailed(again, { attemptIndex: 1, entry, midState: midState({ attemptIndex: 1 }) }),
    (e) => e === err
  );
});

test('streamFailed: exhausted budget surfaces the first error with the last one attached as cause', async () => {
  const h = harness();
  const first = Object.assign(new Error('first'), { wsCloseCode: 1006 });
  assert.equal(
    await h.attempts.streamFailed(first, { attemptIndex: 0, entry: fakeEntry(), midState: midState() }),
    true
  );
  const last = Object.assign(new Error('last'), { wsCloseCode: 1006 });
  const idx = MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT;
  await assert.rejects(
    () =>
      h.attempts.streamFailed(last, {
        attemptIndex: idx,
        entry: fakeEntry(),
        midState: midState({ attemptIndex: idx }),
      }),
    (e) => e === first
  );
  assert.equal(first.cause, last);
  assert.equal(first.midstreamRetries, idx);
  assert.equal(first.wsRetriesExhausted, true);
  assert.equal(first.providerRecoveryExhausted, true);
  assert.equal(first.providerRecoveryOwner, 'openai-oauth-ws-midstream');
  assert.equal(first.providerRecoveryAttempts, idx + 1);
});

test('streamFailed: a stored xAI anchor is carried into the next attempt', async () => {
  const h = harness({ auth: { type: 'xai' }, body: { store: true } });
  const entry = fakeEntry({ lastResponseId: 'resp_1', lastInputLen: 3, lastResponseItems: [{ id: 'msg_1' }] });
  const err = Object.assign(new Error('gone'), { wsCloseCode: 1006 });
  assert.equal(await h.attempts.streamFailed(err, { attemptIndex: 0, entry, midState: midState() }), true);
  assert.equal(h.attempts.state.carryForwardCache.lastResponseId, 'resp_1');
  assert.equal(h.attempts.state.carryForwardCache.lastInputLen, 3);
  assert.deepEqual(h.attempts.state.carryForwardCache.lastResponseItems, [{ id: 'msg_1' }]);
  // A non-stored anchor is dropped so the retry cold-starts.
  const h2 = harness({ auth: { type: 'xai' }, body: { store: false } });
  const err2 = Object.assign(new Error('gone'), { wsCloseCode: 1006 });
  assert.equal(
    await h2.attempts.streamFailed(err2, {
      attemptIndex: 0,
      entry: fakeEntry({ lastResponseId: 'resp_2' }),
      midState: midState(),
    }),
    true
  );
  assert.equal(h2.attempts.state.carryForwardCache, null);
});

test('exhausted: falls back to the first-attempt error or an explicit unreachable marker', async () => {
  const h = harness();
  assert.match(h.attempts.exhausted().message, /unreachable/);
  const first = Object.assign(new Error('first'), { code: 'ECONNRESET' });
  await h.attempts.handshakeFailed(first, handshakeInfo(0));
  assert.equal(h.attempts.exhausted(), first);
  assert.equal(h.attempts.maxMidstreamRetries, MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT);
});
