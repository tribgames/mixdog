import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { _resetOpenaiReqZstdLatchForTest, openHttpSseResponse } from './openai-http-sse-request.mjs';

const noopTimeout = () =>
  new (class {
    signal = new AbortController().signal;
    cleanup() {}
  })();

function open(auth, fetchFn, delays = []) {
  return openHttpSseResponse({
    auth,
    body: { input: 'x' },
    headers: {},
    poolKey: 'http-error-contract',
    turnId: 'turn',
    useModel: 'test-model',
    fetchFn,
    totalTimeout: noopTimeout(),
    _sleepFn: async (ms) => {
      delays.push(ms);
    },
  });
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('HTTP error body is parsed once into the full error contract, beyond the 200-char diagnostic', async () => {
  const message = 'q'.repeat(500);
  const fetchFn = async () =>
    json(
      429,
      { error: { type: 'usage_limit_reached', code: 'Usage_Limit_Reached', message, resets_at: 1893456000 } },
      { 'retry-after': '120' }
    );
  await assert.rejects(open({ type: 'openai-oauth' }, fetchFn), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.httpStatus, 429);
    assert.equal(err.code, 'usage_limit_reached');
    assert.equal(err.resetAt, 1893456000 * 1000);
    assert.equal(err.retryAfterMs, 120_000);
    assert.equal(err.headers.get('retry-after'), '120');
    assert.equal(err.providerError.message, message, 'structured body is not truncated');
    assert.ok(err.message.length < 260, 'diagnostic message stays bounded');
    return true;
  });
});

test('the api-key route is not labelled OAuth', async () => {
  const fetchFn = async () => json(400, { error: { code: 'invalid_prompt', message: 'bad' } });
  await assert.rejects(open({ type: 'openai-direct', apiKey: 'k' }, fetchFn), (err) => {
    assert.match(err.message, /^OpenAI HTTP fallback 400: bad$/u);
    assert.equal(err.code, 'invalid_prompt');
    return true;
  });
  await assert.rejects(open({ type: 'openai-oauth' }, fetchFn), /^Error: OpenAI OAuth HTTP fallback 400: bad$/u);
});

test('429 and 408 are not retried at the request layer; the outer layer owns them', async () => {
  for (const status of [429, 408]) {
    let calls = 0;
    const delays = [];
    const fetchFn = async () => {
      calls++;
      return json(status, { error: { code: 'rate_limit_exceeded', message: 'slow down' } }, { 'retry-after': '2' });
    };
    await assert.rejects(open({ type: 'openai-direct', apiKey: 'k' }, fetchFn, delays), (err) => {
      assert.equal(err.status, status);
      assert.equal(err.retryAfterMs, 2000);
      return true;
    });
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  }
});

test('5xx retries 4 times with 200/400/800/1600ms backoff (±10%) then surfaces the error', async () => {
  let calls = 0;
  const delays = [];
  const fetchFn = async () => {
    calls++;
    return json(500, { error: { message: 'boom' } });
  };
  await assert.rejects(open({ type: 'openai-oauth' }, fetchFn, delays), (err) => err.status === 500);
  assert.equal(calls, 5);
  assert.equal(delays.length, 4);
  [200, 400, 800, 1600].forEach((base, i) => {
    assert.ok(delays[i] >= base * 0.9 && delays[i] <= base * 1.1, `delay ${i} ${delays[i]} within ±10% of ${base}`);
  });
});
test('a long Retry-After is waited in full (uncapped) and reported as a reconnecting stage', async () => {
  let calls = 0;
  const delays = [];
  const stages = [];
  const fetchFn = async () =>
    ++calls === 1
      ? json(503, { error: { message: 'busy' } }, { 'retry-after': '3600' })
      : new Response('data: {}\n\n', { status: 200 });
  const response = await openHttpSseResponse({
    auth: { type: 'openai-oauth' },
    body: { input: 'x' },
    headers: {},
    poolKey: 'long-retry-after',
    turnId: 'turn',
    useModel: 'test-model',
    fetchFn,
    totalTimeout: noopTimeout(),
    onStageChange: (stage, detail) => stages.push([stage, detail]),
    _sleepFn: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(response.status, 200);
  // The advice is captured as a deadline, so a millisecond may elapse before
  // the wait is computed from it.
  const nearHour = (ms) => ms > 3_600_000 - 1000 && ms <= 3_600_000;
  assert.equal(delays.length, 1);
  assert.ok(nearHour(delays[0]), `waited ${delays[0]}`);
  const reconnecting = stages.filter(([stage]) => stage === 'reconnecting');
  assert.equal(reconnecting.length, 1);
  assert.ok(nearHour(reconnecting[0][1].waitMs), `reported ${reconnecting[0][1].waitMs}`);
  assert.equal(reconnecting[0][1].attempt, 2);
});

test('the retry wait stops when the request is aborted', async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return json(503, { error: { message: 'down' } }, { 'retry-after': '3600' });
  };
  const pending = openHttpSseResponse({
    auth: { type: 'openai-oauth' },
    body: { input: 'x' },
    headers: {},
    poolKey: 'abort-wait',
    turnId: 'turn',
    useModel: 'test-model',
    fetchFn,
    externalSignal: controller.signal,
    totalTimeout: noopTimeout(),
    // A real hour-long wait that only the abort signal can end.
    _sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
  });
  setTimeout(() => controller.abort(new Error('user cancelled')), 20);
  await assert.rejects(pending, /user cancelled|aborted/u);
  assert.equal(calls, 1);
});

test('quota codes and resetAt stay non-retryable even with Retry-After advice', async () => {
  let calls = 0;
  const delays = [];
  const fetchFn = async () => {
    calls++;
    return json(
      429,
      { error: { code: 'rate_limit_exceeded', message: 'weekly', resets_at: 1893456000 } },
      { 'retry-after': '5' }
    );
  };
  await assert.rejects(open({ type: 'openai-oauth' }, fetchFn, delays), (err) => err.resetAt === 1893456000 * 1000);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

for (const code of ['insufficient_quota', 'usage_limit_reached', 'billing_hard_limit_reached', 'quota_exceeded']) {
  test(`a 429 ${code} is never retried`, async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return json(429, { error: { code, message: 'no' } }, { 'retry-after': '1' });
    };
    await assert.rejects(open({ type: 'openai-direct', apiKey: 'k' }, fetchFn), (err) => err.code === code);
    assert.equal(calls, 1);
  });
}

for (const code of [
  'insufficient_quota',
  'usage_limit_reached',
  'billing_hard_limit_reached',
  'usage_not_included',
  'cyber_policy',
  'invalid_api_key',
  'permission_denied',
  'invalid_request_error',
]) {
  test(`a 503 ${code} with Retry-After is terminal: one request, no wait`, async () => {
    let calls = 0;
    const delays = [];
    const fetchFn = async () => {
      calls++;
      return json(503, { error: { code, message: 'no' } }, { 'retry-after': '600' });
    };
    await assert.rejects(open({ type: 'openai-direct', apiKey: 'k' }, fetchFn, delays), (err) => err.status === 503);
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  });
}

for (const status of [525, 526]) {
  test(`an edge ${status} origin-TLS failure is terminal: one request, no wait`, async () => {
    let calls = 0;
    const delays = [];
    const fetchFn = async () => {
      calls++;
      return new Response('origin tls', { status });
    };
    await assert.rejects(open({ type: 'openai-oauth' }, fetchFn, delays), (err) => err.status === status);
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  });
}

test('a zstd 400 on the last attempt still replays uncompressed and surfaces a real response', {
  skip: typeof zlib.zstdCompressSync !== 'function',
}, async () => {
  const seen = [];
  const fetchFn = async (_url, init) => {
    const compressed = init.headers['Content-Encoding'] === 'zstd';
    seen.push(compressed);
    if (compressed && seen.length <= 4) return new Response('boom', { status: 503 });
    if (compressed) return new Response('bad encoding', { status: 400 });
    return new Response('data: {}\n\n', { status: 200 });
  };
  const response = await openHttpSseResponse({
    auth: { type: 'openai-oauth' },
    body: { input: 'x'.repeat(16 * 1024) },
    headers: {},
    poolKey: 'zstd-last-attempt',
    turnId: 'turn',
    useModel: 'test-model',
    fetchFn,
    totalTimeout: new (class {
      signal = new AbortController().signal;
      cleanup() {}
    })(),
    _sleepFn: async () => {},
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [true, true, true, true, true, false]);
});

const zstdSkip = { skip: typeof zlib.zstdCompress !== 'function' };
const openBig = (fetchFn, auth = { type: 'openai-oauth' }, headers = {}) =>
  openHttpSseResponse({
    auth,
    body: { input: 'x'.repeat(16 * 1024) },
    headers,
    poolKey: 'zstd-policy',
    turnId: 'turn',
    useModel: 'test-model',
    fetchFn,
    totalTimeout: noopTimeout(),
    _sleepFn: async () => {},
  });

for (const status of [400, 415]) {
  test(
    `zstd ${status}: one plain resend without consuming an attempt; latch only after it succeeds`,
    zstdSkip,
    async () => {
      _resetOpenaiReqZstdLatchForTest();
      const seen = [];
      const fetchFn = async (_url, init) => {
        const compressed = init.headers['Content-Encoding'] === 'zstd';
        seen.push(compressed);
        return compressed ? new Response('bad', { status }) : new Response('data: {}\n\n', { status: 200 });
      };
      assert.equal((await openBig(fetchFn)).status, 200);
      assert.deepEqual(seen, [true, false]);
      assert.equal((await openBig(fetchFn)).status, 200);
      assert.deepEqual(seen, [true, false, false], 'latched off after the successful resend');
      _resetOpenaiReqZstdLatchForTest();
    }
  );
}

test('zstd: no latch when the plain resend also fails; its error surfaces', zstdSkip, async () => {
  _resetOpenaiReqZstdLatchForTest();
  const seen = [];
  const fetchFn = async (_url, init) => {
    const compressed = init.headers['Content-Encoding'] === 'zstd';
    seen.push(compressed);
    return new Response('{"error":{"message":"bad"}}', { status: compressed ? 400 : 422 });
  };
  await assert.rejects(openBig(fetchFn), (err) => err.status === 422);
  assert.deepEqual(seen, [true, false]);
  const again = [];
  await assert.rejects(
    openBig(async (_url, init) => {
      again.push(init.headers['Content-Encoding']);
      return new Response('x', { status: 422 });
    })
  );
  assert.deepEqual(again, ['zstd'], 'still compressing: not latched');
  _resetOpenaiReqZstdLatchForTest();
});

test('zstd: a throwing compressor fails open; existing Content-Encoding is not double-encoded', zstdSkip, async () => {
  _resetOpenaiReqZstdLatchForTest();
  const original = zlib.zstdCompress;
  zlib.zstdCompress = (_buf, cb) => cb(new Error('boom'));
  const sent = [];
  const fetchFn = async (_url, init) => {
    sent.push(init.headers);
    return new Response('data: {}\n\n', { status: 200 });
  };
  try {
    assert.equal((await openBig(fetchFn)).status, 200);
  } finally {
    zlib.zstdCompress = original;
  }
  assert.equal(sent[0]['Content-Encoding'], undefined);
  const preset = { 'content-encoding': 'br' };
  await openBig(fetchFn, undefined, preset);
  assert.equal(sent[1], preset);
});

test('zstd: openai-direct is never compressed', zstdSkip, async () => {
  const sent = [];
  await openBig(
    async (_url, init) => {
      sent.push(init.headers['Content-Encoding']);
      return new Response('data: {}\n\n', { status: 200 });
    },
    { type: 'openai-direct', apiKey: 'k' }
  );
  assert.deepEqual(sent, [undefined]);
});

test(
  'zstd compression is asynchronous: the sync API is never used and the event loop keeps running',
  zstdSkip,
  async () => {
    _resetOpenaiReqZstdLatchForTest();
    const originalAsync = zlib.zstdCompress;
    const originalSync = zlib.zstdCompressSync;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    zlib.zstdCompressSync = () => {
      throw new Error('sync zstd must not be used');
    };
    zlib.zstdCompress = (buf, cb) => {
      gate.then(() => originalAsync(buf, cb));
    };
    let fetched = 0;
    try {
      const pending = openBig(async () => {
        fetched++;
        return new Response('data: {}\n\n', { status: 200 });
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fetched, 0, 'request waits on the threadpool compression while the loop is free');
      release();
      assert.equal((await pending).status, 200);
      assert.equal(fetched, 1);
    } finally {
      zlib.zstdCompress = originalAsync;
      zlib.zstdCompressSync = originalSync;
    }
  }
);
