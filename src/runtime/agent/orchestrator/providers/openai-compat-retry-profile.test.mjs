import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { COMPAT_RETRY_PROFILES, compatRetryOptions, withCompatRetryProfile } from './openai-compat-retry-profile.mjs';
import { isProviderRecoveryExhausted, isProviderRecoveryTerminal, withRetry } from './retry-classifier.mjs';

const httpError = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

// Runs `failure` through the provider's profile until it stops retrying and
// returns what the profiled loop did.
async function run(providerName, failure, { sleepFn } = {}) {
  const waits = [];
  let calls = 0;
  const error = await withRetry(
    withCompatRetryProfile(providerName, async () => {
      calls += 1;
      throw typeof failure === 'function' ? failure(calls) : failure;
    }),
    { ...compatRetryOptions(providerName), sleepFn: sleepFn || ((ms) => void waits.push(ms)) }
  ).then(
    () => assert.fail('expected rejection'),
    (caught) => caught
  );
  return { calls, waits, error };
}

const within = (value, base, ratio) => {
  assert.ok(value >= Math.floor(base * (1 - ratio)) && value <= Math.ceil(base * (1 + ratio)), `${value} vs ${base}`);
};

test('only xai asks withRetry to rebuild the HTTP pool after a 5xx', () => {
  assert.equal(compatRetryOptions('xai').recycleDispatcherOn5xx, true);
  for (const name of Object.keys(COMPAT_RETRY_PROFILES).filter((n) => n !== 'xai')) {
    assert.equal('recycleDispatcherOn5xx' in compatRetryOptions(name), false, name);
  }
  assert.equal('recycleDispatcherOn5xx' in compatRetryOptions('custom-gw'), false);
});

test('a provider without a profile keeps the shared defaults', async () => {
  assert.deepEqual(compatRetryOptions('custom-gw'), { maxRetryAfterMs: 60_000 });
  const { calls } = await run('custom-gw', httpError(503));
  assert.equal(calls, 5);
});

test('a provider without a profile waits out short advice but surfaces a lock-out at once', async () => {
  const short = await run('custom-gw', (n) =>
    n === 1 ? httpError(429, { headers: { 'retry-after': '20' } }) : httpError(401)
  );
  assert.equal(short.calls, 2);
  assert.deepEqual(short.waits, [20_000]);
  for (const failure of [
    httpError(429, { headers: { 'retry-after': '3600' } }),
    httpError(503, { retryAfterMs: 15 * 60_000 }),
  ]) {
    const locked = await run('custom-gw', failure);
    assert.equal(locked.calls, 1);
    assert.deepEqual(locked.waits, []);
    // Final for every outer layer, and the wait stays on it for the notice.
    assert.equal(isProviderRecoveryTerminal(locked.error), true);
    assert.equal(locked.error, failure);
  }
});

// DEFAULT_MAX_RETRIES (15) is the send budget: the classifier stops once
// `retry_count + 1 >= max_retries`, so 15 sends and 14 waits.
test('xai: 15 sends from 2s doubling to 30s with 20% jitter', async () => {
  const { calls, waits } = await run('xai', httpError(503));
  assert.equal(calls, 15);
  [2000, 4000, 8000, 16000, 30000, 30000].forEach((base, index) => within(waits[index], base, 0.2));
  assert.equal(waits.length, 14);
});

test('xai: outside a 429, Retry-After is capped at 30s and jittered; a 429 keeps the raw advice', async () => {
  const failOnce = (status, extra) => (n) => (n === 1 ? httpError(status, extra) : httpError(401));
  const capped = await run('xai', failOnce(503, { retryAfterMs: 120_000 }));
  assert.equal(capped.calls, 2);
  within(capped.waits[0], 30_000, 0.2);
  const short = await run('xai', failOnce(522, { headers: { 'retry-after': '10' } }));
  within(short.waits[0], 10_000, 0.2);
  const limited = await run('xai', failOnce(429, { retryAfterMs: 120_000 }));
  assert.deepEqual(limited.waits, [120_000]);
});

test('xai: a 429 is retried once, 520-524 and 529 are retried, 525/526 are not', async () => {
  const limited = await run('xai', httpError(429));
  assert.equal(limited.calls, 2);
  assert.equal(isProviderRecoveryExhausted(limited.error), true);
  for (const status of [520, 524, 529, 530])
    assert.equal((await run('xai', httpError(status))).calls, 15, String(status));
  for (const status of [525, 526]) assert.equal((await run('xai', httpError(status))).calls, 1, String(status));
});

test('xai: Retry-After replaces the backoff and x-should-retry false vetoes', async () => {
  const advised = await run('xai', (n) => (n === 1 ? httpError(429, { retryAfterMs: 7000 }) : httpError(401)));
  assert.deepEqual(advised.waits, [7000]);
  const vetoed = await run('xai', httpError(500, { headers: { 'x-should-retry': 'false' } }));
  assert.equal(vetoed.calls, 1);
});

test('xai: auth, permission and context overflow are never replayed', async () => {
  for (const failure of [httpError(401), httpError(403), httpError(400, { code: 'context_length_exceeded' })]) {
    assert.equal((await run('xai', failure)).calls, 1, String(failure.status));
  }
});

test('deepseek: five retries, 500ms doubling, 10% jitter', async () => {
  const { calls, waits } = await run('deepseek', httpError(500));
  assert.equal(calls, 6);
  [500, 1000, 2000, 4000, 8000].forEach((base, index) => within(waits[index], base, 0.1));
});

test('deepseek: 402 balance and context overflow are terminal, 429 is retried', async () => {
  assert.equal((await run('deepseek', httpError(402, { error: { message: 'Insufficient Balance' } }))).calls, 1);
  assert.equal((await run('deepseek', httpError(400, { code: 'context_length_exceeded' }))).calls, 1);
  assert.equal((await run('deepseek', httpError(429))).calls, 6);
  assert.equal((await run('deepseek', httpError(503, { error: { type: 'overloaded_error' } }))).calls, 6);
});

test('deepseek: Retry-After within 10s is waited, beyond 10s the error surfaces', async () => {
  const short = await run('deepseek', (n) => (n === 1 ? httpError(429, { retryAfterMs: 3000 }) : httpError(400)));
  assert.deepEqual(short.waits, [3000]);
  const long = await run('deepseek', httpError(429, { headers: { 'retry-after': '11' } }));
  assert.equal(long.calls, 1);
  assert.equal(isProviderRecoveryExhausted(long.error), true);
});

// One provider request is the HTTP transport layer: 6 sends, 500ms doubling,
// no jitter. The 10-retry / 8s-cap / downward-jitter schedule belongs to the
// session layer, which Mixdog's agent loop owns.
test('muse-code: six sends, 500ms doubling, no jitter', async () => {
  const { calls, waits } = await run('muse-code-oauth', httpError(502));
  assert.equal(calls, 6);
  assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000]);
});

test('muse-code: only 408, 429 and 5xx retry; other 4xx are terminal', async () => {
  for (const status of [408, 429, 500])
    assert.equal((await run('muse-code-oauth', httpError(status))).calls, 6, String(status));
  for (const status of [400, 401, 403, 404, 409, 425]) {
    assert.equal((await run('muse-code-oauth', httpError(status))).calls, 1, String(status));
  }
});

test('mimo: server budget of 8 retries, rate-limit budget of 5, 501/505 terminal', async () => {
  const server = await run('mimo-oauth', httpError(503));
  assert.equal(server.calls, 9);
  [2000, 4000, 8000, 16000, 30000].forEach((base, index) => within(server.waits[index], base, 0.1));
  assert.equal((await run('mimo-oauth', httpError(429))).calls, 6);
  for (const status of [501, 505, 402, 404, 401])
    assert.equal((await run('mimo-oauth', httpError(status))).calls, 1, String(status));
  assert.equal((await run('mimo-oauth', httpError(425))).calls, 9);
});

test('command-code: three sends for the gateway 5xx set only', async () => {
  const { calls, waits } = await run('command-code-oauth', httpError(502));
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  for (const status of [500, 503, 504, 520, 521, 522]) {
    assert.equal((await run('command-code-oauth', httpError(status))).calls, 3, String(status));
  }
  for (const status of [501, 505, 529, 524, 530]) {
    assert.equal((await run('command-code-oauth', httpError(status))).calls, 1, String(status));
  }
});

test('command-code: a slow failed attempt is returned, not replayed', async (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  const { calls, error } = await run('command-code-oauth', () => {
    clock += 16_000;
    return httpError(502);
  });
  assert.equal(calls, 1);
  assert.equal(isProviderRecoveryExhausted(error), true);
  mock.restoreAll();
});

test('xai and deepseek: 408, 409 and 425 are terminal client errors', async () => {
  for (const name of ['xai', 'deepseek']) {
    for (const status of [408, 409, 425]) {
      const { calls, error } = await run(name, httpError(status));
      assert.equal(calls, 1, `${name} ${status}`);
      assert.equal(isProviderRecoveryTerminal(error), true, `${name} ${status}`);
    }
  }
});

test('mimo: 408 and 409 are terminal, 425 stays retryable', async () => {
  for (const status of [408, 409]) assert.equal((await run('mimo-oauth', httpError(status))).calls, 1, String(status));
  assert.equal((await run('mimo-oauth', httpError(425))).calls, 9);
});

test('command-code: every 4xx including 429 is terminal', async () => {
  for (const status of [400, 401, 403, 404, 408, 409, 425, 429]) {
    const { calls, error } = await run('command-code-oauth', httpError(status));
    assert.equal(calls, 1, String(status));
    assert.equal(isProviderRecoveryTerminal(error), true, String(status));
  }
});

test('every profile stop decision is provider-terminal', async () => {
  const cases = [
    ['xai', httpError(429)],
    ['deepseek', httpError(429, { headers: { 'retry-after': '11' } })],
    ['muse-code-oauth', httpError(409)],
    ['mimo-oauth', httpError(501)],
    ['command-code-oauth', httpError(501)],
  ];
  for (const [name, failure] of cases) {
    const { error } = await run(name, failure);
    assert.equal(isProviderRecoveryTerminal(error), true, name);
  }
});

test('a non-positive Retry-After is no advice: the local backoff applies', async () => {
  const stamped = await run('xai', (n) => (n === 1 ? httpError(503, { retryAfterMs: 0 }) : httpError(401)));
  within(stamped.waits[0], 2000, 0.2);
  const headerObject = await run('xai', (n) =>
    n === 1 ? httpError(503, { headers: { 'retry-after': '0' } }) : httpError(401)
  );
  within(headerObject.waits[0], 2000, 0.2);
  const headersClass = await run('deepseek', (n) =>
    n === 1 ? httpError(503, { headers: new Headers({ 'retry-after': '0', 'retry-after-ms': '0' }) }) : httpError(401)
  );
  within(headersClass.waits[0], 500, 0.1);
  const both = await run('muse-code-oauth', (n) =>
    n === 1 ? httpError(503, { retryAfterMs: 0, headers: { 'retry-after': '0' } }) : httpError(401)
  );
  assert.ok(both.waits[0] > 0);
});

test('a positive Retry-After still replaces the backoff', async () => {
  const advised = await run('muse-code-oauth', (n) =>
    n === 1 ? httpError(503, { headers: { 'retry-after': '3' } }) : httpError(401)
  );
  assert.deepEqual(advised.waits, [3000]);
});

test('command-code: advice is a floor under the jittered backoff, never a replacement', async () => {
  const failOnce = (extra) => (n) => (n === 1 ? httpError(502, extra) : httpError(401));
  const tiny = await run('command-code-oauth', failOnce({ retryAfterMs: 1 }));
  within(tiny.waits[0], 400, 0.2);
  const long = await run('command-code-oauth', failOnce({ retryAfterMs: 2000 }));
  assert.deepEqual(long.waits, [2000]);
});

test('Retry-After ceilings: muse-code 60s, command-code 60s, mimo 300s', async () => {
  const wait = (seconds) => (n) =>
    n === 1 ? httpError(503, { headers: { 'retry-after': String(seconds) } }) : httpError(401);
  for (const [name, ceiling] of [
    ['muse-code-oauth', 60],
    ['command-code-oauth', 60],
    ['mimo-oauth', 300],
  ]) {
    const within_ = await run(name, wait(ceiling));
    assert.deepEqual(within_.waits, [ceiling * 1000], `${name} at ceiling`);
    const beyond = await run(name, httpError(503, { headers: { 'retry-after': String(ceiling + 1) } }));
    assert.equal(beyond.calls, 1, `${name} beyond ceiling`);
    assert.equal(isProviderRecoveryTerminal(beyond.error), true, name);
  }
});

// A completed turn with no text, no tool call and no reasoning.
const emptyTurn = (extra = {}) => ({
  content: '',
  toolCalls: [],
  stopReason: 'stop',
  reasoningContent: null,
  ...extra,
});

async function runResults(providerName, results) {
  let calls = 0;
  const result = await withRetry(
    withCompatRetryProfile(providerName, async () => results[Math.min(calls++, results.length - 1)]),
    { ...compatRetryOptions(providerName), sleepFn: () => {} }
  ).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  return { calls, ...result };
}

test('xai and deepseek: an empty normal-finish response is retried inside the profile ladder', async () => {
  for (const [name, attempts] of [
    ['xai', 15],
    ['deepseek', 6],
  ]) {
    const recovered = await runResults(name, [
      emptyTurn(),
      emptyTurn(),
      { content: 'ok', toolCalls: [], stopReason: 'stop' },
    ]);
    assert.equal(recovered.calls, 3, name);
    assert.equal(recovered.value.content, 'ok');
    const spent = await runResults(name, [emptyTurn()]);
    assert.equal(spent.calls, attempts, name);
    assert.equal(isProviderRecoveryExhausted(spent.error), true);
    assert.match(spent.error.message, /empty response/);
  }
});

test('muse-code: an empty normal finish is retried at most twice, then delivered as-is', async () => {
  const recovered = await runResults('muse-code-oauth', [
    emptyTurn(),
    emptyTurn(),
    { content: 'ok', toolCalls: [], stopReason: 'stop' },
  ]);
  assert.equal(recovered.calls, 3);
  assert.equal(recovered.value.content, 'ok');
  const spent = await runResults('muse-code-oauth', [emptyTurn()]);
  assert.equal(spent.calls, 3);
  assert.equal(spent.error, undefined);
  assert.equal(spent.value.content, '');
});

test('an empty response is accepted when anything was produced or the finish was not normal', async () => {
  const produced = [
    { content: 'text' },
    { toolCalls: [{ id: 'c1', name: 'x', arguments: {} }] },
    { reasoningContent: 'thinking' },
    { reasoningDetails: [{ type: 'reasoning.text', text: 'thinking' }] },
    { reasoningEmitted: true },
    { stopReason: 'length' },
    { stopReason: 'content_filter' },
  ];
  for (const extra of produced) {
    const { calls, value } = await runResults('xai', [emptyTurn(extra)]);
    assert.equal(calls, 1, JSON.stringify(extra));
    assert.ok(value, JSON.stringify(extra));
  }
  // A Responses turn completes with no stop reason at all.
  const responses = await runResults('deepseek', [emptyTurn({ stopReason: null })]);
  assert.equal(responses.calls, 6);
});

test('providers whose reference does not retry an empty response return it', async () => {
  for (const name of ['mimo-oauth', 'command-code-oauth', 'custom-gw']) {
    const { calls, value } = await runResults(name, [emptyTurn()]);
    assert.equal(calls, 1, name);
    assert.ok(value, name);
  }
});

test('profiles are frozen data', () => {
  assert.throws(() => {
    COMPAT_RETRY_PROFILES.xai.maxAttempts = 1;
  }, TypeError);
});
