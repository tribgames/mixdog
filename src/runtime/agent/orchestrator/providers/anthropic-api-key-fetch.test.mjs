import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { AnthropicProvider } from './anthropic.mjs';
import { createAnthropicApiKeyFetch } from './anthropic-api-key-fetch.mjs';
import { anthropicGzipLatch } from './lib/request-compression.mjs';
import { GatewayMessagesEngine } from './wire-gateway.mjs';

const OFFICIAL = 'https://api.anthropic.com/v1/messages';
const big = () => JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'x'.repeat(16 * 1024) }] });
const ok = () => new Response('{}', { status: 200 });

function recorder(responder = ok) {
  const calls = [];
  const baseFetch = async (url, init) => {
    calls.push({ url, init });
    return responder(calls.length, init);
  };
  return { calls, baseFetch };
}
const post = (body, headers = { 'content-type': 'application/json' }) => ({ method: 'POST', headers, body });

beforeEach(() => {
  anthropicGzipLatch.reset();
  delete process.env.MIXDOG_ANTHROPIC_REQ_GZIP;
});

test('official origin: large /v1/messages body is gzipped asynchronously', async () => {
  const body = big();
  const { calls, baseFetch } = recorder();
  const fetchFn = createAnthropicApiKeyFetch({ baseFetch });
  const response = await fetchFn(OFFICIAL, post(body));
  assert.equal(response.status, 200);
  assert.equal(calls[0].init.headers['Content-Encoding'], 'gzip');
  assert.deepEqual(Buffer.from(calls[0].init.body), gzipSync(Buffer.from(body)));
});

test('Headers-instance headers are supported and content-length dropped', async () => {
  const { calls, baseFetch } = recorder();
  const fetchFn = createAnthropicApiKeyFetch({ baseFetch });
  await fetchFn(`${OFFICIAL}?beta=true`, post(big(), new Headers({ 'content-length': '99', a: 'b' })));
  const sent = calls[0].init.headers;
  assert.equal(sent.get('content-encoding'), 'gzip');
  assert.equal(sent.has('content-length'), false);
  assert.equal(sent.get('a'), 'b');
});

test('small bodies, the kill switch and non-messages paths are not compressed', async () => {
  const { calls, baseFetch } = recorder();
  const fetchFn = createAnthropicApiKeyFetch({ baseFetch });
  await fetchFn(OFFICIAL, post('{"a":1}'));
  await fetchFn('https://api.anthropic.com/v1/messages/count_tokens', post(big()));
  process.env.MIXDOG_ANTHROPIC_REQ_GZIP = '0';
  await fetchFn(OFFICIAL, post(big()));
  for (const call of calls) assert.equal(call.init.headers['Content-Encoding'], undefined);
});

test('custom base URLs and look-alike origins are never compressed', async () => {
  const { calls, baseFetch } = recorder();
  const fetchFn = createAnthropicApiKeyFetch({ baseFetch });
  for (const url of [
    'https://proxy.example.com/v1/messages',
    'http://api.anthropic.com/v1/messages',
    'https://api.anthropic.com.evil.test/v1/messages',
    'https://api.anthropic.com:8443/v1/messages',
    'http://localhost:8080/v1/messages',
  ]) {
    await fetchFn(url, post(big()));
  }
  assert.equal(calls.length, 5);
  for (const call of calls) assert.equal(call.init.headers['Content-Encoding'], undefined);
});

test('provider wiring: official default compresses, custom baseURL and gateways do not', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return ok();
  };
  try {
    const official = new AnthropicProvider({ apiKey: 'k' });
    await official.client.fetch(OFFICIAL, post(big()));
    const custom = new AnthropicProvider({ apiKey: 'k', baseURL: 'https://proxy.example.com' });
    await custom.client.fetch('https://proxy.example.com/v1/messages', post(big()));
    const gateway = new GatewayMessagesEngine({
      apiKey: 'k',
      name: 'deepseek',
      baseURL: 'https://api.deepseek.com/anthropic',
    });
    await gateway.client.fetch('https://api.deepseek.com/anthropic/v1/messages', post(big()));
    const custom2 = new AnthropicProvider({ apiKey: 'k', name: 'custom-x', baseURL: 'https://api.anthropic.com' });
    await custom2.client.fetch(OFFICIAL, post(big()));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen[0].init.headers['Content-Encoding'], 'gzip');
  for (const call of seen.slice(1)) assert.equal(call.init.headers['Content-Encoding'], undefined);
});

for (const status of [400, 415]) {
  test(`${status} on a gzipped request: one plain resend, latch only after it succeeds`, async () => {
    const body = big();
    const { calls, baseFetch } = recorder((n) => new Response('{}', { status: n === 1 ? status : 200 }));
    const fetchFn = createAnthropicApiKeyFetch({ baseFetch });
    const response = await fetchFn(OFFICIAL, post(body));
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(gunzipSync(calls[0].init.body).toString('utf8'), body);
    assert.equal(calls[1].init.headers['Content-Encoding'], undefined);
    assert.equal(calls[1].init.body, body);
    await fetchFn(OFFICIAL, post(body));
    assert.equal(calls[2].init.headers['Content-Encoding'], undefined);
    assert.equal(calls.length, 3);
  });
}

test('no latch when the plain resend also fails; its response is returned', async () => {
  const body = big();
  const { calls, baseFetch } = recorder((n) => new Response('nope', { status: n === 1 ? 400 : 401 }));
  const fetchFn = createAnthropicApiKeyFetch({ baseFetch });
  const response = await fetchFn(OFFICIAL, post(body));
  assert.equal(response.status, 401);
  assert.equal(calls.length, 2);
  assert.equal(anthropicGzipLatch.disabled(), false);
  await fetchFn(OFFICIAL, post(body));
  assert.equal(calls[2].init.headers['Content-Encoding'], 'gzip');
});

test('compression that throws fails open to the plain body', async () => {
  const body = big();
  const { calls, baseFetch } = recorder();
  const fetchFn = createAnthropicApiKeyFetch({
    baseFetch,
    compress: async () => {
      throw new Error('boom');
    },
  });
  const response = await fetchFn(OFFICIAL, post(body));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['Content-Encoding'], undefined);
  assert.equal(calls[0].init.body, body);
});

test('a request that already has Content-Encoding is not double-encoded', async () => {
  const { calls, baseFetch } = recorder();
  const fetchFn = createAnthropicApiKeyFetch({ baseFetch });
  const headers = { 'content-encoding': 'br', 'content-type': 'application/json' };
  const body = big();
  await fetchFn(OFFICIAL, post(body, headers));
  assert.equal(calls[0].init.headers, headers);
  assert.equal(calls[0].init.body, body);
});

test('compression runs off the main thread (async compress is awaited)', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, baseFetch } = recorder();
  const fetchFn = createAnthropicApiKeyFetch({
    baseFetch,
    compress: async (raw) => {
      await gate;
      return gzipSync(raw);
    },
  });
  const pending = fetchFn(OFFICIAL, post(big()));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0, 'request is still waiting on compression; the event loop kept running');
  release();
  await pending;
  assert.equal(calls.length, 1);
});
