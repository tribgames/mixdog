import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamSafetyStamps } from './retry-classifier.mjs';
import { createWsSendAttempts, MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT } from './openai-ws-send-attempts.mjs';
import { createWsSendContext } from './openai-ws-send/send-context.mjs';
import { retryReasonClass, safeRetryErrorCode } from './provider-error-kind.mjs';
import { providerTimeoutError } from '../stall-policy.mjs';
import { emitProviderRetryStage } from './retry-executor.mjs';

function harness(overrides = {}) {
  const progress = [];
  const details = [];
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
    emitReconnectProgress: (p) => {
      progress.push({ attempt: p.attempt, max: p.max, classifier: p.classifier });
      details.push(p);
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
  return { attempts, progress, details, spanEvents, sleeps, sendSpan };
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

test('streamFailed: a cut while a tool input streams surfaces instead of re-sending the request', async () => {
  const h = harness();
  const err = Object.assign(new Error('gone'), { wsCloseCode: 1006, pendingToolUse: true });
  await assert.rejects(
    () => h.attempts.streamFailed(err, { attemptIndex: 0, entry: fakeEntry(), midState: midState() }),
    (e) => e === err
  );
  assert.deepEqual(h.progress, []);
  assert.equal(h.sleeps.length, 0);
});

test('streamFailed: a rate-limited response.failed waits the server-advised time', async () => {
  const h = harness();
  const err = Object.assign(new Error('rate limited'), {
    responseFailed: {
      response: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 1.5s.' } },
    },
  });
  assert.equal(await h.attempts.streamFailed(err, { attemptIndex: 0, entry: fakeEntry(), midState: midState() }), true);
  assert.equal(err.midstreamClassifier, 'response_failed_rate_limited');
  assert.deepEqual(h.sleeps, [1500]);
});

test('streamFailed: a long server-advised wait is announced with its cause and length before it starts', async () => {
  const h = harness();
  const err = Object.assign(new Error('OpenAI OAuth WS error: Rate limit reached. Please try again in 210s.'), {
    responseFailed: {
      type: 'error',
      error: { code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 210s.' },
    },
  });
  const pre = midState({ sawResponseCreated: false });
  assert.equal(await h.attempts.streamFailed(err, { attemptIndex: 0, entry: fakeEntry(), midState: pre }), true);
  assert.deepEqual(h.sleeps, [210_000]);
  assert.equal(h.details.length, 1);
  assert.equal(h.details[0].error, err);
  assert.equal(h.details[0].waitMs, 210_000);
});

test('the WS reconnect stage names the failure and counts down the advised wait', () => {
  const stages = [];
  const ctx = createWsSendContext({
    auth: { type: 'xai' },
    body: {},
    sendOpts: {},
    onStageChange: (stage, detail) => stages.push([stage, detail]),
    externalSignal: null,
    poolKey: 'send-context-test',
    cacheKey: null,
    iteration: 0,
    useModel: 'gpt-6.1-sol',
    traceProvider: 'xai',
    _sendSpanTraceFn: () => {},
  });
  const err = Object.assign(new Error('Rate limit reached. Please try again in 210s.'), { code: 'rate_limit_exceeded' });
  const before = Date.now();
  ctx.emitReconnectProgress({ attempt: 1, max: 5, classifier: 'http_429', error: err, waitMs: 210_000 });
  assert.equal(stages.length, 1);
  const [stage, detail] = stages[0];
  assert.equal(stage, 'reconnecting');
  assert.equal(detail.waitMs, 210_000);
  assert.ok(detail.retryAt >= before + 210_000);
  assert.equal(detail.reason, 'Rate limited by the provider');
  assert.equal(detail.reasonClass, 'rate_limited');
  assert.equal(detail.message, 'Rate limited by the provider · retry 1/5 in 210s');
  // A retry without a known failure keeps the bare counter.
  ctx.emitReconnectProgress({ attempt: 2, max: 5, classifier: 'ws_1006' });
  assert.equal(stages[1][1].message, 'Reconnecting... 2/5');
});

test('server error text (echoed prompt, token, account) never reaches the retry trace or the status', async () => {
  const markers = ['PROMPT_MARKER_7f3a', 'sk-TOKEN_MARKER_9b2c', 'acct_ACCOUNT_MARKER_44d1'];
  const serverText = `Rate limit reached for "${markers[0]}" (key ${markers[1]}, account ${markers[2]}). Please try again in 3s.`;
  const stages = [];
  const traces = [];
  const ctx = createWsSendContext({
    auth: { type: 'xai' },
    body: {},
    sendOpts: {},
    onStageChange: (stage, detail) => stages.push([stage, detail]),
    externalSignal: null,
    poolKey: 'redaction-test',
    cacheKey: null,
    iteration: 0,
    useModel: 'gpt-6.1-sol',
    traceProvider: 'xai',
    _sleepFn: async () => {},
    _sendSpanTraceFn: () => {},
    _agentTraceFn: (row) => traces.push(row),
  });
  const cases = [
    // Typed rate limit carrying the text in the wire error and the message.
    Object.assign(new Error(`OpenAI OAuth WS error: ${serverText}`), {
      responseFailed: { type: 'error', status: 429, error: { code: 'rate_limit_exceeded', message: serverText } },
      httpStatus: 429,
    }),
    // A server "code" that is itself free text must not pass as a code.
    Object.assign(new Error(serverText), {
      responseFailed: { response: { error: { code: `bad ${markers[0]}`, message: serverText } } },
    }),
    // Nor may an identifier-shaped code that is not a known provider code.
    Object.assign(new Error(serverText), {
      responseFailed: { response: { error: { code: 'acct_private-123', message: serverText } } },
    }),
  ];
  for (const [index, err] of cases.entries()) {
    const entry = fakeEntry();
    assert.equal(
      await ctx.attempts.streamFailed(err, { attemptIndex: index, entry, midState: midState({ attemptIndex: index }) }),
      true
    );
  }
  assert.equal(traces.filter((row) => row.kind === 'ws_retry').length, 3);
  assert.equal(stages.filter(([stage]) => stage === 'reconnecting').length, 3);
  const visible = JSON.stringify({ traces, stages });
  for (const marker of [...markers, 'acct_private-123']) assert.ok(!visible.includes(marker), `${marker} leaked`);
  assert.ok(!visible.includes('Rate limit reached for'), 'server text leaked');
  const [first, second, third] = traces.filter((row) => row.kind === 'ws_retry');
  assert.equal(first.code, 'rate_limit_exceeded');
  assert.equal(first.reason, 'rate_limited');
  assert.equal(first.http_status, 429);
  assert.equal(first.wait_ms, 3_000);
  for (const row of [second, third]) {
    assert.equal(row.code, null);
    assert.ok(['rate_limited', 'overloaded', 'server_error', 'auth', 'other'].includes(row.reason));
  }
});

test('safeRetryErrorCode keeps only known provider error codes', () => {
  const coded = (code) => Object.assign(new Error('x'), { responseFailed: { error: { code } } });
  for (const code of ['rate_limit_exceeded', 'usage_limit_reached', 'server_is_overloaded', 'model_not_found']) {
    assert.equal(safeRetryErrorCode(coded(code)), code);
  }
  for (const code of ['acct_private-123', 'user_12345', 'sk-abc', 'prompt words']) {
    assert.equal(safeRetryErrorCode(coded(code)), null, code);
  }
});

test('the retry stage takes a reason class, never caller text', () => {
  const stages = [];
  emitProviderRetryStage((stage, detail) => stages.push(detail), {
    attempt: 1,
    maxAttempts: 5,
    lastErr: new Error('x'),
    delayMs: 1_000,
    reason: 'INJECTED_REASON_TEXT',
    reasonClass: 'INJECTED_CLASS text',
  });
  emitProviderRetryStage((stage, detail) => stages.push(detail), {
    attempt: 1,
    maxAttempts: 5,
    lastErr: new Error('x'),
    delayMs: 1_000,
    reasonClass: 'overloaded',
  });
  assert.ok(!JSON.stringify(stages).includes('INJECTED'));
  assert.equal(stages[0].reason, 'Connection interrupted');
  assert.equal(stages[0].reasonClass, 'other');
  assert.equal(stages[1].message, 'Provider overloaded · retry 1/5 in 1s');
});

function stageFor(lastErr, extra = {}) {
  const stages = [];
  emitProviderRetryStage((stage, detail) => stages.push(detail), {
    attempt: 1,
    maxAttempts: 5,
    lastErr,
    delayMs: 1_000,
    ...extra,
  });
  return stages[0];
}

test('typed timeouts keep their own wording in the retry stage', () => {
  // Cursor's unary timeout, stamped through the shared helper.
  const cursor = stageFor(providerTimeoutError('Cursor request', 5_000));
  assert.equal(cursor.reasonClass, 'first_response_timeout');
  assert.equal(cursor.reason, 'No first response 5s');
  // Anthropic first-message watchdog stamp.
  const anthropic = stageFor(
    Object.assign(new Error('Anthropic SSE stream produced no message_start within 45000ms'), {
      code: 'EEMPTYSTREAM',
      isEmptyStream: true,
      firstByteTimeout: true,
    })
  );
  assert.equal(anthropic.reasonClass, 'first_response_timeout');
  assert.equal(anthropic.reason, 'No first response 45s');
  // OpenAI WS pre-stream watchdog stamp.
  const ws = stageFor(
    Object.assign(new Error('WS stream: no first server event within 10000ms'), { firstByteTimeout: true })
  );
  assert.equal(ws.reason, 'No first response 10s');
  // OpenAI WS inter-chunk / first-meaningful watchdog: a named stall.
  const stall = stageFor(
    Object.assign(new Error('Responses WS timed out after 60000ms of inactivity'), { name: 'StreamStalledError' })
  );
  assert.equal(stall.reasonClass, 'stalled');
  assert.equal(stall.reason, 'No progress 1m');
});

test('a token-refresh timeout classifies as auth, not a model timeout', () => {
  const refresh = Object.assign(new Error('OpenAI OAuth token refresh timed out after 30000ms'), {
    timeoutPhase: 'auth',
  });
  assert.equal(retryReasonClass(refresh), 'auth');
  assert.equal(stageFor(refresh).reason, 'Provider rejected the sign-in');
});

test('an injected provider label or unknown code never reaches the retry stage', () => {
  const err = Object.assign(new Error('first byte timed out after 60000ms'), {
    timeoutPhase: 'headers',
    providerLabel: 'INJECTED_LABEL',
    code: 'acct_INJECTED_CODE',
  });
  const detail = stageFor(err);
  assert.equal(detail.reason, 'Model still thinking: no output in 1m; the provider sent nothing yet');
  assert.equal(detail.classifier, null);
  assert.ok(!JSON.stringify(detail).includes('INJECTED'));
  assert.equal(stageFor(err, { providerLabel: 'Antigravity' }).reason.includes('Antigravity'), true);
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

test('streamFailed: a server 1009 on a retry surfaces itself, not the earlier transient', async () => {
  const h = harness();
  const first = Object.assign(new Error('first'), { wsCloseCode: 1006 });
  assert.equal(
    await h.attempts.streamFailed(first, { attemptIndex: 0, entry: fakeEntry(), midState: midState() }),
    true
  );
  const tooBig = Object.assign(new Error('too big'), { wsCloseCode: 1009 });
  await assert.rejects(
    () =>
      h.attempts.streamFailed(tooBig, {
        attemptIndex: 1,
        entry: fakeEntry(),
        midState: midState({ attemptIndex: 1 }),
      }),
    (e) => e === tooBig
  );
  assert.deepEqual(h.progress, [{ attempt: 1, max: MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT, classifier: 'ws_1006' }]);
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
