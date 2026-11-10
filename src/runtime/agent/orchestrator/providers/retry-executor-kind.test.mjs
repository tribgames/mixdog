import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProviderRecoveryTerminal, withRetry } from './retry-executor.mjs';
import { classifyHandshakeError, classifyMidstreamError, midstreamRetryDelayMs } from './retry-midstream.mjs';
import { AnthropicFallbackTriggeredError, ModelFallbackTriggeredError, midstreamBackoffFor } from './retry-backoff.mjs';
import { PROVIDER_RETRY_BACKOFF_MS } from '../stall-policy.mjs';
import { CODEX_RETRY_JITTER_RATIO, CODEX_STREAM_BACKOFF_MS } from './openai-retry-policy.mjs';

const err = (message, props = {}) => Object.assign(new Error(message), props);
const noSleep = async () => {};

async function attempts(makeError, opts = {}) {
  let calls = 0;
  const waits = [];
  const result = await withRetry(
    async () => {
      calls += 1;
      throw makeError(calls);
    },
    { maxAttempts: 3, backoffMs: [0, 0, 0], sleepFn: noSleep, onRetry: ({ delayMs }) => waits.push(delayMs), ...opts }
  ).catch((error) => error);
  return { calls, waits, result };
}

test('explicit quota / billing / plan refusals are never retried, even with Retry-After', async () => {
  for (const code of ['usage_limit_reached', 'insufficient_quota', 'usage_not_included', 'credit_balance_exhausted']) {
    const { calls } = await attempts(() => err('limit', { status: 429, code, headers: { 'retry-after': '1' } }));
    assert.equal(calls, 1, code);
  }
  const daily = await attempts(() =>
    err('limit', { status: 429, code: 'resource_exhausted', quotaScope: 'day', retryAfterMs: 5 })
  );
  assert.equal(daily.calls, 1, 'a spent daily quota is not a retry window');
  const minute = await attempts(() =>
    err('limit', { status: 429, code: 'resource_exhausted', quotaScope: 'minute', retryAfterMs: 5 })
  );
  assert.equal(minute.calls, 3, 'a per-minute limit retries');
});

test('rate limits and overloads wait the full server advice within the attempt budget', async () => {
  const { calls, waits } = await attempts(() =>
    err('slow', { status: 429, code: 'rate_limit_exceeded', retryAfterMs: 7_200_000 })
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [7_200_000, 7_200_000], 'advice is never capped');
  const overloaded = await attempts(() => err('busy', { status: 429, code: 'server_is_overloaded' }));
  assert.equal(overloaded.calls, 3);
});

test('the overload fallback fires through a positive x-should-retry and shares a counter across the send', async () => {
  const overload = () => err('overloaded', { status: 529, headers: { 'x-should-retry': 'true' } });
  const opts = { model: 'a', fallbackModel: 'b', overloadFallbackAfter: 3, maxAttempts: 10 };
  const { calls, result } = await attempts(overload, opts);
  assert.equal(calls, 3);
  assert.ok(result instanceof AnthropicFallbackTriggeredError);

  const overloadState = {};
  const first = await attempts(overload, { ...opts, maxAttempts: 2, overloadState });
  assert.equal(first.calls, 2);
  assert.ok(!(first.result instanceof AnthropicFallbackTriggeredError));
  const second = await attempts(overload, { ...opts, maxAttempts: 2, overloadState });
  assert.equal(second.calls, 1, 'the shared count reaches the threshold on the next withRetry');
  assert.ok(second.result instanceof AnthropicFallbackTriggeredError);
});

test('subscribers ignore a positive x-should-retry for every status', async () => {
  const positive = { headers: { 'x-should-retry': 'true' } };
  const sub = await attempts(() => err('bad', { status: 400, ...positive }), {
    honorShouldRetryTrue: true,
    retry429: false,
  });
  assert.equal(sub.calls, 1);
  const payg = await attempts(() => err('bad', { status: 408, ...positive }), { honorShouldRetryTrue: true });
  assert.equal(payg.calls, 3);
  const vetoed = await attempts(() => err('bad', { status: 409, ...positive, headers: { 'x-should-retry': 'false' } }));
  assert.equal(vetoed.calls, 1, 'without honorShouldRetryTrue only the negative header counts');
  const deterministic = await attempts(() => err('bad', { status: 400, ...positive }), { honorShouldRetryTrue: true });
  assert.equal(deterministic.calls, 1, 'a positive header never overrides a deterministic refusal');
});

test('an overload is retried ahead of x-should-retry:false', async () => {
  const { calls } = await attempts(() => err('overloaded', { status: 529, headers: { 'x-should-retry': 'false' } }), {
    honorShouldRetryTrue: true,
  });
  assert.equal(calls, 3);
  const vetoed = await attempts(() => err('boom', { status: 500, headers: { 'x-should-retry': 'false' } }));
  assert.equal(vetoed.calls, 1, 'the veto still holds for non-overload statuses');
});

test('stopAfterRepeated529 ends the loop on the third consecutive 529', async () => {
  const { calls, result } = await attempts(() => err('overloaded', { status: 529 }), {
    maxAttempts: 10,
    overloadFallbackAfter: 3,
    stopAfterRepeated529: true,
  });
  assert.equal(calls, 3);
  assert.equal(result.message, 'Repeated 529 Overloaded errors');
  assert.equal(result.repeated529, true);
  assert.equal(result.cause.status, 529);
  assert.equal(isProviderRecoveryTerminal(result), true, 'the stop is a provider verdict');
  const plain = await attempts(() => err('overloaded', { status: 529 }), { maxAttempts: 5 });
  assert.equal(plain.calls, 5, 'without the opt the attempt budget is spent');
});

test('deterministic kinds veto before any status, header or overload rule', async () => {
  const opts = { honorShouldRetryTrue: true, maxAttempts: 4 };
  const yes = { 'x-should-retry': 'true' };
  const cases = {
    '429 + cyber_policy': { status: 429, code: 'cyber_policy' },
    '529 + invalid_api_key': { status: 529, code: 'invalid_api_key' },
    '401 + x-should-retry:true': { status: 401, headers: yes },
    '403 + x-should-retry:true': { status: 403, headers: yes },
    '400 + x-should-retry:true': { status: 400, headers: yes },
    '503 + invalid_request_error': { status: 503, code: 'invalid_request_error', headers: yes },
    '503 + permission_denied': { status: 503, code: 'permission_denied', retryAfterMs: 1 },
    '529 + typed quota': { status: 529, code: 'usage_limit_reached', headers: yes },
    '429 + header quota, subscriber': { status: 429, providerQuota: true, headers: yes },
    '429 + typed billing + header quota': {
      status: 429,
      code: 'insufficient_quota',
      providerQuota: true,
      headers: yes,
    },
  };
  for (const [name, props] of Object.entries(cases)) {
    const subscriber = name.includes('subscriber') ? { retry429: false } : {};
    assert.equal((await attempts(() => err('no', props), { ...opts, ...subscriber })).calls, 1, name);
  }
  assert.equal((await attempts(() => err('closed', { status: 499 }), { retry499: true })).calls, 3, '499 opt-in');
  assert.equal((await attempts(() => err('x', { status: 401, code: 'server_error' }))).calls, 3, 'typed transient');
});

test('retry499 re-issues only a status-only 499; a typed deterministic code stays final', async () => {
  const opts = { retry499: true };
  assert.equal((await attempts(() => err('bad', { status: 499, code: 'invalid_argument' }), opts)).calls, 1);
  assert.equal((await attempts(() => err('no', { status: 499, code: 'permission_denied' }), opts)).calls, 1);
  // An RPC status that names no kind keeps the 499 status-only.
  assert.equal((await attempts(() => err('closed', { status: 499, geminiStatus: 'CANCELLED' }), opts)).calls, 3);
});

test('525/526 are terminal whatever retry header, advice or overload code they carry', async () => {
  const opts = { honorShouldRetryTrue: true, maxAttempts: 4 };
  for (const status of [525, 526]) {
    const cases = {
      'overload code': { status, code: 'overloaded_error' },
      'x-should-retry:true': { status, headers: { 'x-should-retry': 'true' } },
      'retry-after': { status, headers: { 'retry-after': '1' } },
      'typed transient': { status, code: 'server_error', retryAfterMs: 1 },
    };
    for (const [name, props] of Object.entries(cases)) {
      assert.equal((await attempts(() => err('tls', props), opts)).calls, 1, `${status} ${name}`);
    }
  }
});

test('flex_unavailable is final at the HTTP, handshake and mid-stream classifiers', async () => {
  assert.equal((await attempts(() => err('flex', { status: 429, code: 'flex_unavailable' }))).calls, 1);
  assert.equal(
    (await attempts(() => err('flex', { status: 503, code: 'flex_unavailable', retryAfterMs: 1 }))).calls,
    1
  );
  assert.equal(
    classifyHandshakeError(err('flex', { httpStatus: 503, code: 'flex_unavailable', retryAfterMs: 1 })),
    null
  );
  const flex = () => err('flex', { status: 429, httpStatus: 429, code: 'flex_unavailable' });
  assert.equal(classifyMidstreamError(flex(), { attemptIndex: 0 }, { mode: 'sse' }), null);
  assert.equal(classifyMidstreamError(flex(), { attemptIndex: 0, sawResponseCreated: true }, { mode: 'ws' }), null);
});

test('the overload counter counts overloads only; intervening failures never reset it', async () => {
  const seq = [529, 500, 529, 500, 529, 529];
  const { calls, result } = await attempts((n) => err('x', { status: seq[n - 1] }), {
    maxAttempts: 6,
    overloadFallbackAfter: 3,
    stopAfterRepeated529: true,
  });
  assert.equal(calls, 5, 'the third overload of the send stops the loop');
  assert.equal(result.name, 'Repeated529Error');
  const fallback = await attempts((n) => err('x', { status: seq[n - 1] }), {
    maxAttempts: 6,
    overloadFallbackAfter: 3,
    model: 'a',
    fallbackModel: 'b',
  });
  assert.equal(fallback.calls, 5);
  assert.ok(fallback.result instanceof ModelFallbackTriggeredError);
});

test('finalOnExhaust marks the spent ladder provider-terminal', async () => {
  const unavailable = () => err('unavailable', { status: 503 });
  const plain = await attempts(unavailable);
  assert.equal(plain.calls, 3);
  assert.equal(isProviderRecoveryTerminal(plain.result), false);
  const final = await attempts(unavailable, { finalOnExhaust: true });
  assert.equal(final.calls, 3);
  assert.equal(isProviderRecoveryTerminal(final.result), true);
});

test('zero Retry-After is no advice: the local backoff applies', async () => {
  const { waits } = await attempts(() => err('slow', { status: 503, response: { headers: { 'retry-after': '0' } } }), {
    backoffMs: [40, 40, 40],
    retryJitterRatio: 0,
  });
  assert.equal(waits.length, 2);
  assert.ok(
    waits.every((ms) => ms > 0),
    `waits ${waits}`
  );
});

test('an advice-gated overload denial is a provider-terminal verdict', async () => {
  const { calls, result } = await attempts(() => err('busy', { status: 503, code: 'server_is_overloaded' }), {
    overloadRetryRequiresAdvice: true,
  });
  assert.equal(calls, 1);
  assert.equal(isProviderRecoveryTerminal(result), true);
});

test('withRetry without overloadFallbackAfter never triggers a model fallback', async () => {
  const { calls, result } = await attempts(() => err('overloaded', { status: 529 }), {
    model: 'a',
    fallbackModel: 'b',
    maxAttempts: 5,
  });
  assert.equal(calls, 5);
  assert.ok(!(result instanceof ModelFallbackTriggeredError));
  assert.equal(
    AnthropicFallbackTriggeredError,
    ModelFallbackTriggeredError,
    'the old export name stays the same class'
  );
});

test('handshake: every deterministic kind is final despite a 5xx and advice', () => {
  for (const code of ['cyber_policy', 'invalid_api_key', 'permission_denied', 'invalid_request_error']) {
    assert.equal(
      classifyHandshakeError(err('x', { httpStatus: 503, code, headers: { 'retry-after': '1' } })),
      null,
      code
    );
  }
  assert.equal(classifyHandshakeError(err('x', { httpStatus: 503, headers: { 'retry-after': '1' } })), 'http_503');
  const sse = { mode: 'sse', defaultRetries: 3, perClassifierGate: false };
  assert.equal(
    classifyMidstreamError(err('x', { status: 503, code: 'invalid_request_error' }), { attemptIndex: 0 }, sse),
    null
  );
  const ws = { mode: 'ws', transientCloseRetries: 5, defaultRetries: 5 };
  assert.equal(
    classifyMidstreamError(
      err('x', { httpStatus: 503, code: 'invalid_request_error' }),
      { attemptIndex: 0, sawResponseCreated: true },
      ws
    ),
    null
  );
});

test('header-derived quota evidence on a 429 retries for non-subscribers only', async () => {
  const flagged = () => err('limit', { status: 429, code: 'rate_limit_error', providerQuota: true });
  assert.equal((await attempts(flagged)).calls, 3);
  assert.equal((await attempts(flagged, { retry429: false })).calls, 1);
  const typed = () => err('limit', { status: 429, code: 'insufficient_quota', providerQuota: true });
  assert.equal((await attempts(typed)).calls, 1, 'a typed billing code is never retried');
});

test('advice-gate opts: overload / generic 429 retried in withRetry only with advice; 408 and typed rate limits retry', async () => {
  const adviceGated = { overloadRetryRequiresAdvice: true, generic429RetryRequiresAdvice: true };
  assert.equal(
    (await attempts(() => err('busy', { status: 503, code: 'server_is_overloaded' }), adviceGated)).calls,
    1
  );
  assert.equal(
    (await attempts(() => err('busy', { status: 503, code: 'server_is_overloaded', retryAfterMs: 1 }), adviceGated))
      .calls,
    3
  );
  assert.equal((await attempts(() => err('slow', { status: 429 }), adviceGated)).calls, 1);
  assert.equal((await attempts(() => err('slow', { status: 429, retryAfterMs: 1 }), adviceGated)).calls, 3);
  assert.equal((await attempts(() => err('slow', { status: 429, code: 'rate_limit_exceeded' }), adviceGated)).calls, 3);
  assert.equal((await attempts(() => err('slow', { status: 429, code: 'slow_down' }), adviceGated)).calls, 3);
  assert.equal((await attempts(() => err('timeout', { status: 408 }), adviceGated)).calls, 3);
  assert.equal(
    (await attempts(() => err('limit', { status: 429, code: 'usage_limit_reached' }), adviceGated)).calls,
    1
  );
});

test('advice jitter opts: advice jitter, advice at least backoff, and 499 retry', async () => {
  const advised = () => err('slow', { status: 429, code: 'rate_limit_exceeded', retryAfterMs: 1000 });
  const plain = await attempts(advised, { backoffMs: [0, 5000, 5000] });
  assert.deepEqual(plain.waits, [1000, 1000], 'default: advice as-is');
  const floored = await attempts(advised, {
    backoffMs: [0, 5000, 5000],
    retryJitterRatio: 0,
    adviceAtLeastBackoff: true,
  });
  assert.deepEqual(floored.waits, [5000, 5000], 'advice never undercuts the backoff step');
  const jittered = await attempts(advised, { retryAfterJitterRatio: 0.2 });
  for (const wait of jittered.waits) assert.ok(wait >= 1000 && wait <= 1200, `positive jitter ${wait}`);
  const down = await attempts(() => err('x', { status: 503 }), {
    backoffMs: [0, 1000, 1000],
    retryJitterRatio: 0.3,
    retryJitterMode: 'negative',
  });
  for (const wait of down.waits) assert.ok(wait >= 700 && wait <= 1000, `withRetry negative jitter ${wait}`);
  assert.equal((await attempts(() => err('closed', { status: 499 }))).calls, 1, '499 is terminal by default');
  assert.equal((await attempts(() => err('closed', { status: 499 }), { retry499: true })).calls, 3);
});

test('midstream: 429 overload/rate limit retries under budget, quota never; explicit pre-created failures retry', () => {
  const ws = { mode: 'ws', transientCloseRetries: 5, defaultRetries: 5 };
  const adviceWs = { ...ws, overloadRetryRequiresAdvice: true, generic429RetryRequiresAdvice: true };
  const state = { attemptIndex: 0, sawResponseCreated: true };
  const overloaded429 = (extra = {}) => err('busy', { httpStatus: 429, code: 'server_is_overloaded', ...extra });
  const overloadEvent = (extra = {}) =>
    err('overloaded', { responseFailed: { response: { error: { code: 'server_is_overloaded' } } }, ...extra });
  // Default policy: overloads and generic 429s retry with ordinary backoff.
  assert.equal(classifyMidstreamError(overloaded429(), state, ws), 'http_429');
  assert.equal(classifyMidstreamError(err('slow', { httpStatus: 429 }), state, ws), 'http_429');
  assert.equal(classifyMidstreamError(overloadEvent(), state, ws), 'response_failed_retryable');
  // Advice-gated policy: they retry only on server advice.
  assert.equal(classifyMidstreamError(overloaded429(), state, adviceWs), null);
  assert.equal(classifyMidstreamError(overloaded429({ retryAfterMs: 2000 }), state, adviceWs), 'http_429');
  assert.equal(classifyMidstreamError(err('slow', { httpStatus: 429 }), state, adviceWs), null);
  assert.equal(
    classifyMidstreamError(err('slow', { httpStatus: 429, headers: { 'retry-after': '2' } }), state, adviceWs),
    'http_429'
  );
  assert.equal(
    classifyMidstreamError(err('slow', { httpStatus: 429, code: 'rate_limit_exceeded' }), state, adviceWs),
    'http_429'
  );
  assert.equal(classifyMidstreamError(overloadEvent(), state, adviceWs), null, 'statusless overload without advice');
  assert.equal(
    classifyMidstreamError(overloadEvent({ retryAfterMs: 1000 }), state, adviceWs),
    'response_failed_retryable'
  );
  assert.equal(classifyMidstreamError(err('limit', { httpStatus: 429, code: 'usage_limit_reached' }), state, ws), null);
  assert.equal(
    classifyMidstreamError(err('busy', { httpStatus: 429, code: 'rate_limit_exceeded' }), state, {
      ...ws,
      retry429: false,
    }),
    null
  );
  const preCreated = { attemptIndex: 0, sawResponseCreated: false };
  const failed = (code, status) =>
    err('failed', { responseFailed: { response: { error: { code, ...(status ? { status } : {}) } } } });
  assert.equal(classifyMidstreamError(failed('server_error'), preCreated, ws), 'response_failed_retryable');
  assert.equal(
    classifyMidstreamError(failed('insufficient_quota', 500), preCreated, ws),
    null,
    'deterministic beats 5xx'
  );
  assert.equal(classifyMidstreamError(failed('cyber_policy', 500), state, ws), null);
  // Anthropic SSE keeps the defaults: 529 / overloaded_error and
  // a generic 429 retry WITHOUT advice under the bounded budget.
  const sse = { mode: 'sse', defaultRetries: 3, perClassifierGate: false };
  const adviceSse = { ...sse, overloadRetryRequiresAdvice: true, generic429RetryRequiresAdvice: true };
  const s0 = () => ({ attemptIndex: 0 });
  assert.equal(classifyMidstreamError(err('x', { status: 529, code: 'overloaded_error' }), s0(), sse), 'http_529');
  assert.equal(classifyMidstreamError(err('x', { error: { type: 'overloaded_error' } }), s0(), sse), 'connection');
  assert.equal(classifyMidstreamError(err('x', { status: 429, code: 'rate_limit_error' }), s0(), sse), 'http_429');
  assert.equal(classifyMidstreamError(err('x', { status: 529, code: 'overloaded_error' }), s0(), adviceSse), null);
  assert.equal(classifyMidstreamError(err('x', { error: { type: 'overloaded_error' } }), s0(), adviceSse), null);
  assert.equal(classifyMidstreamError(err('x', { status: 429, code: 'rate_limit_error' }), s0(), adviceSse), null);
  assert.equal(
    classifyMidstreamError(err('x', { status: 429, code: 'rate_limit_error', retryAfterMs: 5 }), s0(), adviceSse),
    'http_429'
  );
  assert.equal(classifyMidstreamError(err('x', { status: 503 }), s0(), adviceSse), 'http_503', '5xx unchanged');
  // rate_limit_exceeded without header advice waits its message delay, else backoff.
  assert.equal(midstreamRetryDelayMs(err('try again in 3s', { status: 429, code: 'rate_limit_exceeded' }), 250), 3000);
  assert.equal(midstreamRetryDelayMs(err('slow', { status: 429, code: 'rate_limit_exceeded' }), 250), 250);
  assert.equal(
    classifyMidstreamError(err('x', { status: 429, code: 'insufficient_quota' }), { attemptIndex: 0 }, sse),
    null
  );
  assert.equal(classifyHandshakeError(err('x', { httpStatus: 429, code: 'usage_limit_reached' })), null);
  assert.equal(classifyHandshakeError(err('x', { httpStatus: 429, code: 'rate_limit_exceeded' })), 'http_429');
  const adviceHandshake = { overloadRetryRequiresAdvice: true, generic429RetryRequiresAdvice: true };
  assert.equal(classifyHandshakeError(err('x', { httpStatus: 429 })), 'http_429', 'default unchanged');
  assert.equal(classifyHandshakeError(err('x', { httpStatus: 429 }), adviceHandshake), null);
  assert.equal(classifyHandshakeError(err('x', { httpStatus: 429, retryAfterMs: 1000 }), adviceHandshake), 'http_429');
  assert.equal(classifyHandshakeError(err('x', { httpStatus: 529 }), adviceHandshake), null);
  assert.equal(classifyHandshakeError(err('x', { httpStatus: 503 }), adviceHandshake), 'http_503');
  assert.equal(classifyHandshakeError(err('x', { httpStatus: 429 }), { ...adviceHandshake, retry429: false }), null);
});

test('midstream wait honors advice in full for retryable kinds only', () => {
  assert.equal(midstreamRetryDelayMs(err('x', { status: 429, retryAfterMs: 90_000 }), 250), 90_000);
  assert.equal(midstreamRetryDelayMs(err('x', { status: 503 }), 250), 250);
  assert.equal(
    midstreamRetryDelayMs(err('x', { status: 429, code: 'insufficient_quota', retryAfterMs: 90_000 }), 250),
    250
  );
  // The shared schedule honors advice when given the failure, uncapped.
  assert.equal(
    midstreamBackoffFor(1, undefined, err('x', { status: 529, headers: { 'retry-after': '3600' } })),
    3_600_000
  );
  const step = midstreamBackoffFor(1, [1000], err('x', { code: 'ECONNRESET' }));
  assert.ok(step >= 800 && step <= 1200, 'no advice keeps the jittered step');
  assert.ok(midstreamBackoffFor(1, [1000]) <= 1200, 'without err the signature is unchanged');
  // OpenAI schedule: 200/400/800/1600/3200 ms ±10%.
  assert.deepEqual([...CODEX_STREAM_BACKOFF_MS], [200, 400, 800, 1600, 3200]);
  for (const [index, base] of CODEX_STREAM_BACKOFF_MS.entries()) {
    const wait = midstreamBackoffFor(index + 1, CODEX_STREAM_BACKOFF_MS, null, CODEX_RETRY_JITTER_RATIO);
    assert.ok(wait >= base * 0.9 && wait <= base * 1.1, `${base}: ${wait}`);
  }
  assert.deepEqual([...PROVIDER_RETRY_BACKOFF_MS], [250, 1000, 2000, 4000, 8000], 'the default schedule is unchanged');
  // Downward-only jitter: base × (1 − ratio·rand), never above the base.
  for (let i = 0; i < 50; i += 1) {
    const wait = midstreamBackoffFor(1, [1000], null, 0.3, 'negative');
    assert.ok(wait >= 700 && wait <= 1000, `negative ${wait}`);
  }
  // A boundary-captured deadline survives a transport switch.
  const advised = midstreamRetryDelayMs(
    err('x', { status: 429, code: 'rate_limit_exceeded', retryAfterAt: Date.now() + 5000 }),
    1
  );
  assert.ok(advised > 4000 && advised <= 5000);
  assert.equal(
    midstreamRetryDelayMs(err('x', { status: 503, retryAfterAt: Date.now() - 10 }), 1),
    0,
    'an elapsed deadline waits nothing'
  );
});
