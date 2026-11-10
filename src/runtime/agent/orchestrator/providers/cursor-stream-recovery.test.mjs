import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCursorCredentialRefresher,
  isCursorProtocolDrift,
  isRetryableCursorStreamError,
  resolveCursorStreamTuning,
  withCursorFailureHint,
} from './cursor-wire-guards.mjs';
import { __cursorWireInternals } from './cursor-wire.mjs';
import { classifyError, isCursorTransientTransportError, isProviderRecoveryExhausted } from './retry-classifier.mjs';

function cursorStreamAbort() {
  const error = new Error('Cursor stream was aborted');
  error.code = 'stream_aborted';
  error.cursorCode = 'stream_aborted';
  return error;
}

function fakeBridge() {
  let alive = true;
  let closeHandler = null;
  return {
    closeCalls: 0,
    get alive() {
      return alive;
    },
    write() {},
    close(error = null) {
      this.closeCalls += 1;
      if (!alive) return;
      alive = false;
      closeHandler?.(error);
    },
    onData() {},
    onClose(handler) {
      closeHandler = handler;
    },
  };
}

test('Cursor transport aborts are structurally transient before output exposure', () => {
  const abort = cursorStreamAbort();
  assert.equal(isCursorTransientTransportError(abort), true);
  assert.equal(classifyError(abort), 'transient');

  const reasoningAbort = cursorStreamAbort();
  reasoningAbort.emittedReasoning = true;
  assert.equal(isCursorTransientTransportError(reasoningAbort), true);
  assert.equal(classifyError(reasoningAbort), 'permanent');

  const refusal = cursorStreamAbort();
  refusal.status = 400;
  refusal.httpStatus = 400;
  assert.equal(isCursorTransientTransportError(refusal), false);
  assert.equal(classifyError(refusal), 'permanent');
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

function endStreamError(error, metadata) {
  return __cursorWireInternals.parseEndStream(new TextEncoder().encode(JSON.stringify({ error, metadata })));
}

// A stream whose restarts are recorded; sleeps are captured, not awaited.
// `sleep` overrides the recording stub; `read:false` leaves the body unread so
// a test can cancel it.
function retryHarness({ conversation = { checkpoint: null }, key, sleep = null, read = true }) {
  const bridges = [fakeBridge()];
  const delays = [];
  const stages = [];
  const restarts = [];
  const response = __cursorWireInternals.createStreamResponse({
    bridge: bridges[0],
    heartbeat: null,
    conversation,
    tools: [],
    cloudRule: undefined,
    model: 'cursor-test',
    key,
    onStageChange: (stage, detail) => stages.push({ stage, ...detail }),
    sleep:
      sleep ||
      (async (ms) => {
        delays.push(ms);
      }),
    restart: (options) => {
      restarts.push(options);
      const bridge = fakeBridge();
      bridges.push(bridge);
      return { bridge, heartbeat: null };
    },
  });
  return { bridges, delays, stages, restarts, response, body: read ? response.text() : null };
}

test('Cursor end-stream errors normalize every Connect code into the error contract', () => {
  const cases = [
    ['deadline_exceeded', 504],
    ['failed_precondition', 400],
    ['unavailable', 503],
    ['internal', 500],
    ['resource_exhausted', 429],
    ['unauthenticated', 401],
    ['invalid_argument', 400],
    ['unimplemented', 501],
  ];
  for (const [code, status] of cases) {
    const error = endStreamError({ code: code.toUpperCase(), message: `detail for ${code}` });
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.httpStatus, status);
    assert.match(error.message, new RegExp(`detail for ${code}`));
    assert.equal(error.cursorDetail, `detail for ${code}`);
  }
  const limited = endStreamError(
    { code: 'resource_exhausted', message: 'slow down' },
    { 'retry-after': ['3'], 'x-extra': 'v' }
  );
  assert.equal(limited.retryAfterMs, 3_000);
  assert.equal(limited.headers['retry-after'], '3');
  assert.equal(limited.headers['x-extra'], 'v');
});

test('Cursor resource_exhausted is request_too_large only on explicit catalog/payload wording', () => {
  const tooLarge = endStreamError({ code: 'resource_exhausted', message: 'The tool catalog is too large' });
  assert.equal(tooLarge.code, 'request_too_large');
  assert.equal(tooLarge.status, 413);
  assert.match(tooLarge.message, /tool catalog is too large/);
  assert.equal(
    endStreamError({ code: 'resource_exhausted', message: 'request payload exceeds the size limit' }).code,
    'request_too_large'
  );
  // No wording, no reclassification: a plain throttle stays a throttle.
  assert.equal(
    endStreamError({ code: 'resource_exhausted', message: 'Too many requests, slow down' }).code,
    'resource_exhausted'
  );
  assert.equal(
    endStreamError({ code: 'resource_exhausted', message: 'rate limit exceeded' }).code,
    'resource_exhausted'
  );
  assert.equal(endStreamError({ code: 'internal', message: 'tool catalog is too large' }).code, 'internal');
});

test('Cursor rate/quota wording on resource_exhausted stays a throttle even when it mentions the request', () => {
  for (const message of [
    'Your request exceeded the rate limit',
    'request exceeds quota limit',
    'Too many requests: request exceeded the maximum rate',
    'request throttled, size limit of your plan reached',
  ]) {
    const error = endStreamError({ code: 'resource_exhausted', message });
    assert.equal(error.code, 'resource_exhausted', message);
    assert.equal(error.status, 429, message);
  }
  // Explicit size wording without a rate cue is still terminal.
  assert.equal(
    endStreamError({ code: 'resource_exhausted', message: 'request payload exceeds the size limit' }).code,
    'request_too_large'
  );
});

test('Cursor providers disable the outer recovery cycles', async () => {
  const { CursorApiProvider, CursorOAuthProvider } = await import('./cursor.mjs');
  for (const Provider of [CursorApiProvider, CursorOAuthProvider]) {
    assert.deepEqual({ ...new Provider({}).retryPolicy }, { recoveryCycles: false });
  }
});

test('Cursor marks a throttle that spent its retry as recovery-exhausted, and leaves other errors unmarked', async () => {
  const tuning = resolveCursorStreamTuning();
  const { bridges, body } = retryHarness({ key: 'cursor-throttle-exhausted' });
  const throttle = () => endStreamError({ code: 'resource_exhausted', message: 'slow down' }, { 'retry-after': '2' });
  for (let attempt = 0; attempt < tuning.maxThrottleRetries; attempt += 1) {
    bridges[attempt].close(throttle());
    await tick();
  }
  bridges[tuning.maxThrottleRetries].close(throttle());
  await assert.rejects(body, (error) => {
    assert.equal(error.code, 'resource_exhausted');
    assert.equal(isProviderRecoveryExhausted(error), true);
    return true;
  });
  const fatal = retryHarness({ key: 'cursor-protocol-unmarked' });
  fatal.bridges[0].close(Object.assign(new Error('bad'), { code: 'protocol_error' }));
  await assert.rejects(fatal.body, (error) => isProviderRecoveryExhausted(error) === false);
});

test('Cursor treats the shared transient errno set as retryable', () => {
  for (const code of ['EHOSTUNREACH', 'ECONNABORTED', 'ENETRESET', 'ERR_HTTP2_INVALID_SESSION', 'ESOCKETTIMEDOUT']) {
    assert.equal(isRetryableCursorStreamError(Object.assign(new Error('x'), { code })), true, code);
  }
});

test('Cursor stream retry is limited to an explicit transient set', () => {
  const transient = [
    'unavailable',
    'internal',
    'deadline_exceeded',
    'incomplete_stream',
    'goaway',
    'stream_aborted',
    'ECONNRESET',
  ];
  for (const code of transient)
    assert.equal(isRetryableCursorStreamError(Object.assign(new Error('x'), { code })), true, code);
  const deterministic = [
    'protocol_error',
    'failed_precondition',
    'invalid_argument',
    'unauthenticated',
    'request_too_large',
    'resource_exhausted',
    'unknown',
  ];
  for (const code of deterministic)
    assert.equal(isRetryableCursorStreamError(Object.assign(new Error('x'), { code })), false, code);
  // The former blanket status-0 retry is gone.
  assert.equal(isRetryableCursorStreamError(new Error('decoder blew up')), false);
  assert.equal(isRetryableCursorStreamError(Object.assign(new Error('x'), { status: 502 })), false);
  assert.equal(
    isRetryableCursorStreamError(Object.assign(new Error('x'), { name: 'AbortError', code: 'unavailable' })),
    false
  );
});

test('Cursor separates incomplete framing from deterministic protocol errors', () => {
  const truncated = __cursorWireInternals.createFrameParser(
    () => {},
    () => {}
  );
  truncated(Buffer.from([0, 0, 0, 0, 9, 1]));
  assert.throws(
    () => truncated.finish(),
    (error) => error.code === 'incomplete_stream' && isRetryableCursorStreamError(error)
  );
  const compressed = __cursorWireInternals.createFrameParser(
    () => {},
    () => {}
  );
  assert.throws(
    () => compressed(__cursorWireInternals.connectFrame(Buffer.from('x'), 1)),
    (error) => error.code === 'protocol_error' && !isRetryableCursorStreamError(error)
  );
  const malformed = __cursorWireInternals.parseEndStream(new TextEncoder().encode('{broken'));
  assert.equal(malformed.code, 'protocol_error');
  assert.equal(isRetryableCursorStreamError(malformed), false);
});

test('Cursor transient retries back off instead of restarting immediately', async () => {
  const { bridges, delays, body } = retryHarness({ key: 'cursor-backoff' });
  bridges[0].close(cursorStreamAbort());
  await tick();
  assert.equal(bridges.length, 2);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] > 0);
  bridges[1].close(cursorStreamAbort());
  await tick();
  assert.equal(delays.length, 2);
  assert.ok(delays[1] > delays[0] * 0.9, 'backoff grows between attempts');
  bridges[2].close(Object.assign(new Error('bad'), { code: 'protocol_error' }));
  await assert.rejects(body, (error) => error.code === 'protocol_error');
  assert.equal(bridges.length, 3);
});

test('Cursor honors Retry-After on throttles within a bounded budget', async () => {
  const tuning = resolveCursorStreamTuning();
  const { bridges, delays, body } = retryHarness({ key: 'cursor-throttle' });
  const throttle = () => endStreamError({ code: 'resource_exhausted', message: 'slow down' }, { 'retry-after': '2' });
  for (let attempt = 0; attempt < tuning.maxThrottleRetries; attempt += 1) {
    bridges[attempt].close(throttle());
    await tick();
  }
  assert.deepEqual(delays, Array(tuning.maxThrottleRetries).fill(2_000));
  bridges[tuning.maxThrottleRetries].close(throttle());
  await assert.rejects(body, (error) => {
    assert.equal(error.code, 'resource_exhausted');
    assert.equal(error.retryAfterMs, 2_000);
    return true;
  });
  assert.equal(bridges.length, tuning.maxThrottleRetries + 1);
});

test('Cursor waits out the full Retry-After advice and reports the wait through the reconnecting stage', async () => {
  const tuning = resolveCursorStreamTuning();
  assert.equal(tuning.maxThrottleWaitMs, undefined, 'no wait cap on server advice');
  const long = retryHarness({ key: 'cursor-throttle-long' });
  long.bridges[0].close(endStreamError({ code: 'resource_exhausted', message: 'slow down' }, { 'retry-after': '600' }));
  await tick();
  assert.deepEqual(long.delays, [600_000]);
  assert.equal(long.bridges.length, 2);
  const reconnecting = long.stages.find((entry) => entry.stage === 'reconnecting');
  assert.equal(reconnecting.waitMs, 600_000);
  assert.ok(reconnecting.retryAt >= Date.now() + 599_000);
  assert.equal(reconnecting.attempt, 2);
  assert.equal(reconnecting.max, tuning.maxRetries + 1);
  assert.equal(long.stages.at(-1).stage, 'streaming');
  // The budget stays bounded: a throttle past maxThrottleRetries fails with the advice attached.
  for (let attempt = 1; attempt < tuning.maxThrottleRetries; attempt += 1) {
    long.bridges[attempt].close(
      endStreamError({ code: 'resource_exhausted', message: 'slow down' }, { 'retry-after': '600' })
    );
    await tick();
  }
  long.bridges[tuning.maxThrottleRetries].close(
    endStreamError({ code: 'resource_exhausted', message: 'slow down' }, { 'retry-after': '600' })
  );
  await assert.rejects(long.body, (error) => error.retryAfterMs === 600_000);
  assert.equal(long.bridges.length, tuning.maxThrottleRetries + 1);
});

test('Cursor idle watchdog does not run during an intentional Retry-After wait', async (t) => {
  const savedIdle = process.env.MIXDOG_CURSOR_STREAM_IDLE_TIMEOUT_MS;
  process.env.MIXDOG_CURSOR_STREAM_IDLE_TIMEOUT_MS = '180000';
  t.after(() => {
    if (savedIdle === undefined) delete process.env.MIXDOG_CURSOR_STREAM_IDLE_TIMEOUT_MS;
    else process.env.MIXDOG_CURSOR_STREAM_IDLE_TIMEOUT_MS = savedIdle;
    t.mock.timers.reset();
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const delays = [];
  const harness = retryHarness({
    key: 'cursor-throttle-watchdog',
    sleep: (ms) => {
      delays.push(ms);
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  });
  harness.bridges[0].close(
    endStreamError({ code: 'resource_exhausted', message: 'slow down' }, { 'retry-after': '600' })
  );
  assert.deepEqual(delays, [600_000]);

  // Past the 180s idle deadline, still inside the advised wait: the stream is
  // neither failed nor poked by the watchdog.
  t.mock.timers.tick(300_000);
  await tick();
  assert.equal(harness.bridges.length, 1);
  assert.equal(harness.bridges[0].closeCalls, 1, 'watchdog never fired on the waiting stream');

  t.mock.timers.tick(300_000);
  await tick();
  assert.equal(harness.bridges.length, 2, 'the full advice elapsed, then the run restarted');
  assert.equal(harness.stages.at(-1).stage, 'streaming');

  // The restarted run is watched again: real silence still counts.
  t.mock.timers.tick(180_000);
  assert.equal(harness.bridges[1].closeCalls, 1, 'the watchdog closed the silent restarted bridge');
});

test('Cursor honors server advice in full for transient (unavailable) retries, local backoff only without advice', async () => {
  const advised = retryHarness({ key: 'cursor-transient-advice' });
  advised.bridges[0].close(endStreamError({ code: 'unavailable', message: 'busy' }, { 'retry-after': '600' }));
  await tick();
  assert.deepEqual(advised.delays, [600_000]);
  assert.equal(advised.bridges.length, 2);
  assert.equal(advised.stages.find((entry) => entry.stage === 'reconnecting').waitMs, 600_000);

  const plain = retryHarness({ key: 'cursor-transient-noadvice' });
  plain.bridges[0].close(endStreamError({ code: 'unavailable', message: 'busy' }));
  await tick();
  assert.equal(plain.delays.length, 1);
  assert.ok(plain.delays[0] >= 200 && plain.delays[0] <= 300, `local backoff ${plain.delays[0]}`);
});

test('Cursor cancels a pending throttle wait through the abort signal', async () => {
  let waitSignal = null;
  const harness = retryHarness({
    key: 'cursor-throttle-cancel',
    read: false,
    sleep: (_ms, signal) => {
      waitSignal = signal;
      return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  harness.bridges[0].close(
    endStreamError({ code: 'resource_exhausted', message: 'slow down' }, { 'retry-after': '600' })
  );
  await tick();
  assert.equal(waitSignal.aborted, false);
  await harness.response.body.cancel();
  await tick();
  assert.equal(waitSignal.aborted, true);
  assert.equal(harness.bridges.length, 1, 'a cancelled stream never restarts');
});

test('Cursor retry constants keep the default retry budget', async () => {
  const tuning = resolveCursorStreamTuning({});
  assert.equal(tuning.maxRetries, 5, 'default stream idle retry budget');
  assert.equal(tuning.maxThrottleRetries, 1, 'a rate limit gets min(1, maxRetries)');
  assert.equal(tuning.retryBaseDelayMs, 250, 'default CURSOR_RETRY_BASE_MS');
  assert.equal(tuning.retryMaxDelayMs, 2_000, 'default CURSOR_RETRY_MAX_MS');
  const { bridges, delays } = retryHarness({ key: 'cursor-backoff-constants' });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    bridges[attempt].close(cursorStreamAbort());
    await tick();
  }
  // +-20% around 250, 500, 1000, 2000.
  [250, 500, 1_000, 2_000].forEach((base, index) => {
    assert.ok(delays[index] >= base * 0.8 && delays[index] <= base * 1.2, `delay ${index}: ${delays[index]}`);
  });
});

test('Cursor does not retry a transient code whose detail names a protocol mismatch', () => {
  const internal = (message) => endStreamError({ code: 'internal', message });
  assert.equal(isRetryableCursorStreamError(internal('')), true, 'empty internal stays retriable');
  assert.equal(isRetryableCursorStreamError(internal('request failed')), true);
  for (const detail of [
    'protobuf decode failed',
    'wire drift detected',
    'invalid argument: field 3',
    'protocol violation',
  ]) {
    const error = internal(detail);
    assert.equal(isCursorProtocolDrift(error), true, detail);
    assert.equal(isRetryableCursorStreamError(error), false, detail);
  }
  assert.equal(isRetryableCursorStreamError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), true);
});

test('Cursor final failures carry user guidance once and keep the Cursor detail', async () => {
  const auth = endStreamError({ code: 'unauthenticated', message: 'token expired' });
  const hinted = withCursorFailureHint(auth);
  assert.match(hinted.message, /token expired/);
  assert.match(hinted.message, /Open \/providers in Mixdog to sign in again\./);
  assert.equal(withCursorFailureHint(hinted).message, hinted.message, 'applied once');
  const drift = withCursorFailureHint(endStreamError({ code: 'internal', message: 'protobuf decode failed' }));
  assert.match(drift.message, /protobuf decode failed/);
  assert.match(drift.message, /wire protocol/);
  assert.equal(
    withCursorFailureHint(endStreamError({ code: 'unavailable', message: 'busy' })).message,
    'Cursor unavailable: busy'
  );

  const harness = retryHarness({ key: 'cursor-drift-final' });
  harness.bridges[0].close(endStreamError({ code: 'internal', message: 'protobuf decode failed' }));
  await assert.rejects(harness.body, /protobuf decode failed.*wire protocol/);
  assert.equal(harness.bridges.length, 1);
});

test('Cursor retries a rejected credential once, with a refresh signal', async () => {
  const harness = retryHarness({ key: 'cursor-auth-retry' });
  harness.bridges[0].close(endStreamError({ code: 'unauthenticated', message: 'token expired' }));
  await tick();
  assert.equal(harness.bridges.length, 2);
  assert.equal(harness.restarts[0].reason, 'auth');
  assert.equal(harness.restarts[0].error.code, 'unauthenticated');
  harness.bridges[1].close(endStreamError({ code: 'unauthenticated', message: 'token expired' }));
  await assert.rejects(harness.body, /token expired.*sign in again/);
  assert.equal(harness.bridges.length, 2, 'one refresh retry only');
});

test('Cursor force-refreshes credentials on every restart and only re-sends a rejected one with a new token', async () => {
  const calls = [];
  let issued = 0;
  const refresher = createCursorCredentialRefresher('t0', async (options) => {
    calls.push(options);
    issued += 1;
    return `t${issued}`;
  });
  assert.equal(await refresher.refresh('transient'), 't1');
  assert.equal(await refresher.refresh('auth'), 't2');
  assert.deepEqual(calls, [{ forceRefresh: true }, { forceRefresh: true }]);

  const failing = createCursorCredentialRefresher('t0', async () => {
    throw new Error('refresh endpoint down');
  });
  assert.equal(await failing.refresh('transient'), 't0', 'falls back to the previous token');
  const rejected = new Error('rejected');
  await assert.rejects(failing.refresh('auth', rejected), (error) => error === rejected);

  const none = createCursorCredentialRefresher('t0', null);
  assert.equal(await none.refresh('transient'), 't0');
  await assert.rejects(none.refresh('auth', rejected), (error) => error === rejected);
});

test('Cursor throttle retry restarts from the full request, not a checkpoint', async () => {
  const harness = retryHarness({
    key: 'cursor-throttle-reason',
    conversation: { checkpoint: { stateBytes: new Uint8Array(1) } },
  });
  harness.bridges[0].close(endStreamError({ code: 'resource_exhausted', message: 'slow down' }));
  await tick();
  assert.equal(harness.restarts[0].reason, 'throttle');
  assert.equal(harness.restarts[0].fromCheckpoint, false);
  harness.bridges[1].close(cursorStreamAbort());
  await tick();
  assert.equal(harness.restarts[1].reason, 'transient');
  assert.equal(harness.restarts[1].fromCheckpoint, true, 'transient recovery may still continue from the checkpoint');
});

test('Cursor closes a restarted bridge when the caller cancels during an async restart', async () => {
  let release = null;
  const bridges = [fakeBridge()];
  const response = __cursorWireInternals.createStreamResponse({
    bridge: bridges[0],
    heartbeat: null,
    conversation: { checkpoint: null },
    tools: [],
    cloudRule: undefined,
    model: 'cursor-test',
    key: 'cursor-async-restart-cancel',
    sleep: async () => {},
    restart: () =>
      new Promise((resolve) => {
        release = () => {
          const bridge = fakeBridge();
          bridges.push(bridge);
          resolve({ bridge, heartbeat: null });
        };
      }),
  });
  bridges[0].close(cursorStreamAbort());
  await tick();
  await response.body.cancel();
  release();
  await tick();
  assert.equal(bridges.length, 2);
  assert.equal(bridges[1].alive, false, 'the late bridge is closed, not attached');
});

test('Cursor does not retry an oversized request', async () => {
  const large = retryHarness({ key: 'cursor-too-large' });
  large.bridges[0].close(endStreamError({ code: 'resource_exhausted', message: 'tool catalog is too large' }));
  await assert.rejects(large.body, (error) => error.code === 'request_too_large');
  assert.equal(large.bridges.length, 1);
});

test('Cursor in-place retry exhaustion is owned by the provider', async () => {
  const bridges = [fakeBridge()];
  const tuning = resolveCursorStreamTuning();
  const response = __cursorWireInternals.createStreamResponse({
    bridge: bridges[0],
    heartbeat: null,
    conversation: { checkpoint: null },
    tools: [],
    cloudRule: undefined,
    model: 'cursor-test',
    key: 'cursor-retry-exhaustion',
    sleep: async () => {},
    restart: () => {
      const bridge = fakeBridge();
      bridges.push(bridge);
      return { bridge, heartbeat: null };
    },
  });
  const rejection = assert.rejects(response.text(), (error) => {
    assert.equal(isProviderRecoveryExhausted(error), true);
    assert.equal(error.providerRecoveryOwner, 'cursor-wire');
    assert.equal(error.providerRecoveryAttempts, tuning.maxRetries + 1);
    return true;
  });

  for (let attempt = 0; attempt <= tuning.maxRetries; attempt += 1) {
    bridges[attempt].close(cursorStreamAbort());
    await tick();
  }

  await rejection;
  assert.equal(bridges.length, tuning.maxRetries + 1);
});
