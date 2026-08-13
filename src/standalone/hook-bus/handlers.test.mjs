import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';

import {
  MAX_HTTP_HOOK_RESPONSE_BYTES,
  runHttpHandler,
} from './handlers.mjs';

test('public HTTP hooks use the DNS-pinned fetch lane', async () => {
  let publicCalls = 0;
  let privateCalls = 0;
  const result = await runHttpHandler(
    { type: 'http', url: 'https://example.com/hook' },
    { ok: true },
    'Stop',
    {
      publicFetch: async (_url, options) => {
        publicCalls += 1;
        assert.equal(options.redirect, 'error');
        return new Response('ok');
      },
      privateFetch: async () => {
        privateCalls += 1;
        return new Response('wrong lane');
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(publicCalls, 1);
  assert.equal(privateCalls, 0);
});

test('explicit private HTTP hooks preserve their opt-in fetch lane', async () => {
  let publicCalls = 0;
  let privateCalls = 0;
  const result = await runHttpHandler(
    { type: 'http', url: 'http://127.0.0.1/hook', allowPrivateHosts: true },
    { ok: true },
    'Stop',
    {
      publicFetch: async () => {
        publicCalls += 1;
        return new Response('wrong lane');
      },
      privateFetch: async () => {
        privateCalls += 1;
        return new Response('local');
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'local');
  assert.equal(publicCalls, 0);
  assert.equal(privateCalls, 1);
});

test('public HTTP hooks reject private DNS answers before connecting', async () => {
  const originalLookup = dns.promises.lookup;
  dns.promises.lookup = async () => [{ address: '127.0.0.1', family: 4 }];
  try {
    const result = await runHttpHandler(
      { type: 'http', url: 'https://rebinding.example/hook' },
      { ok: true },
      'Stop',
    );
    assert.equal(result.exitCode, -1);
    assert.match(result.stderr, /private address/);
  } finally {
    dns.promises.lookup = originalLookup;
  }
});

test('HTTP hook responses enforce the shared memory cap', async () => {
  const result = await runHttpHandler(
    { type: 'http', url: 'https://example.com/hook' },
    { ok: true },
    'Stop',
    {
      publicFetch: async () => new Response('x', {
        headers: { 'content-length': String(MAX_HTTP_HOOK_RESPONSE_BYTES + 1) },
      }),
    },
  );
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /byte limit/);
});
