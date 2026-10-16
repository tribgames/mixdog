import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CODEX_REQUEST_RETRY_BACKOFF_MS,
  CODEX_RETRY_JITTER_RATIO,
  CODEX_STREAM_BACKOFF_MS,
} from './openai-retry-policy.mjs';
import { createOpenAiOAuthDispatch } from './openai-oauth-dispatch.mjs';
import { openHttpSseResponse } from './openai-http-sse-request.mjs';
import { OpenAIDirectProvider } from './openai-ws.mjs';
import { OpenAIOAuthProvider } from './openai-oauth.mjs';
import { _backoffFor, midstreamBackoffFor } from './openai-ws-send-attempts/policy.mjs';
import { applyErrorContract } from './openai-error-contract.mjs';

process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';

const noopTimeout = () => ({ signal: new AbortController().signal, cleanup() {} });
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const within = (value, base) =>
  value >= base * (1 - CODEX_RETRY_JITTER_RATIO) && value <= base * (1 + CODEX_RETRY_JITTER_RATIO);

function open(fetchFn, delays) {
  return openHttpSseResponse({
    auth: { type: 'openai-oauth' },
    body: { input: 'x' },
    headers: {},
    poolKey: 'wiring',
    turnId: 'turn',
    useModel: 'test-model',
    fetchFn,
    totalTimeout: noopTimeout(),
    _sleepFn: async (ms) => {
      delays.push(ms);
    },
  });
}

test('(1) HTTP request loop uses the shared request schedule (leading duplicate skipped)', async () => {
  const delays = [];
  await assert.rejects(open(async () => json(500, { error: { message: 'boom' } }), delays));
  assert.equal(delays.length, 4);
  for (const [i, base] of CODEX_REQUEST_RETRY_BACKOFF_MS.slice(1, 5).entries()) {
    assert.ok(within(delays[i], base), `${delays[i]} ~ ${base}`);
  }
});

test('(1) HTTP overload retries only with server advice', async () => {
  let calls = 0;
  const overloaded = { error: { code: 'server_is_overloaded', message: 'busy' } };
  const rejectOverloaded = async () => {
    calls += 1;
    return json(503, overloaded);
  };
  await assert.rejects(open(rejectOverloaded, []), (err) => err.status === 503);
  assert.equal(calls, 1, 'no advice: not retried');
  calls = 0;
  const delays = [];
  const response = await open(
    async () => (++calls === 1 ? json(503, overloaded, { 'retry-after': '7' }) : new Response('data: {}\n\n')),
    delays
  );
  assert.equal(response.status, 200);
  // Advice is the remaining time to the captured deadline (a few ms may have elapsed).
  assert.equal(delays.length, 1);
  assert.ok(delays[0] > 6900 && delays[0] <= 7000, `advice replaces the schedule step (${delays[0]})`);
});

test('(2) WS stream/handshake backoff follows the stream schedule, advice only for retryable kinds', (t) => {
  // Retry-After is a captured deadline: keep exact assertions independent of
  // the real clock advancing between error construction and policy lookup.
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  CODEX_STREAM_BACKOFF_MS.forEach((base, i) => {
    assert.ok(within(midstreamBackoffFor(i + 1), base));
    assert.ok(within(_backoffFor(i + 1), base));
  });
  assert.ok(within(midstreamBackoffFor(9), 3200), 'clamped to the last step');
  const advised = applyErrorContract(new Error('x'), { status: 503, headers: { 'retry-after': '12' } });
  assert.equal(midstreamBackoffFor(1, advised), 12_000);
  t.mock.timers.tick(1);
  assert.equal(midstreamBackoffFor(1, advised), 11_999, 'elapsed time is deducted from the captured deadline');
  const quota = applyErrorContract(new Error('x'), {
    status: 429,
    headers: { 'retry-after': '12' },
    error: { code: 'insufficient_quota' },
  });
  assert.ok(within(midstreamBackoffFor(1, quota), 200), 'a terminal kind ignores the advice');
});

test('(3) both OpenAI providers opt into the loop retry policy', () => {
  for (const provider of [new OpenAIDirectProvider({}), new OpenAIOAuthProvider({})]) {
    assert.deepEqual({ ...provider.retryPolicy }, { unboundedConnectionRetry: true, contentFilterRetryable: true });
  }
});

test('(4) a WS→HTTP switch starts HTTP with a fresh retry budget and still honors the retry deadline', async () => {
  const waits = [];
  const delays = [];
  let calls = 0;
  const exhausted = Object.assign(new Error('ws exhausted'), {
    wsRetriesExhausted: true,
    midstreamRetries: 5,
    status: 503,
  });
  applyErrorContract(exhausted, { status: 503, headers: { 'retry-after': '30' } });
  const dispatch = createOpenAiOAuthDispatch({
    provider: { _httpFallbackUntilByPoolKey: new Map() },
    opts: { _sleepFn: async (ms) => waits.push(ms) },
    authState: { tokens: { access_token: 't' } },
    poolKey: 'switch',
    sendHttp: async () => {
      const response = await open(
        async () => (++calls <= 2 ? json(500, { error: { message: 'x' } }) : new Response('data: {}\n\n')),
        delays
      );
      return { content: String(response.status), toolCalls: [] };
    },
    startedAt: Date.now(),
    httpFallbackEnabled: true,
  });
  assert.equal((await dispatch.dispatchHttp('ws exhausted', exhausted)).content, '200');
  assert.equal(waits.length, 1, 'the captured retry deadline is waited before the switch');
  assert.ok(waits[0] > 29_000 && waits[0] <= 30_000);
  assert.equal(delays.length, 2);
  assert.ok(within(delays[0], 200) && within(delays[1], 400), 'HTTP backoff restarts at the first step');
});
