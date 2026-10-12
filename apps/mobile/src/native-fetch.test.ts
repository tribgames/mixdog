import assert from 'node:assert/strict';
import test from 'node:test';

import { createNativeFetch, NATIVE_HTTP_TIMEOUT_MS } from './native-fetch.ts';

test('an aborted signal rejects a native request that never answers', async () => {
  const fetcher = createNativeFetch(() => new Promise(() => {}));
  const pending = new AbortController();
  setTimeout(() => pending.abort(), 20);
  await assert.rejects(fetcher('https://r.example/x', { signal: pending.signal }), (e: Error) => e.name === 'AbortError');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetcher('https://r.example/x', { signal: controller.signal }), (e: Error) => e.name === 'AbortError');
});

test('native requests carry connect and read timeouts and return the response', async () => {
  let seen: { connectTimeout?: number; readTimeout?: number; data?: unknown } = {};
  const fetcher = createNativeFetch(async (options) => {
    seen = options;
    return { status: 201, data: { ok: true } };
  });
  const response = await fetcher('https://r.example/x', { method: 'POST', body: '{"a":1}' });
  assert.equal(response.status, 201);
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(seen.connectTimeout, NATIVE_HTTP_TIMEOUT_MS);
  assert.equal(seen.readTimeout, NATIVE_HTTP_TIMEOUT_MS);
  assert.deepEqual(seen.data, { a: 1 });
});
