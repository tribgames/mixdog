import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// The shared HTTP pool is rebuilt only for a failure that will actually be
// retried, and a 5xx rebuilds it only for a caller that opts in.
let recycles = 0;
mock.module(new URL('../../../shared/llm/http-agent.mjs', import.meta.url).href, {
  namedExports: {
    getLlmDispatcher: () => undefined,
    preconnect: () => {},
    recycleLlmDispatcher: () => {
      recycles += 1;
      return true;
    },
  },
});
const { withRetry } = await import('./retry-executor.mjs');

const err = (message, props = {}) => Object.assign(new Error(message), props);

async function countRecycles(makeError, opts = {}) {
  recycles = 0;
  let calls = 0;
  await withRetry(
    async () => {
      calls += 1;
      throw makeError();
    },
    { maxAttempts: 3, backoffMs: [0, 0, 0], sleepFn: async () => {}, ...opts }
  ).catch(() => {});
  return { calls, recycles };
}

test('a vetoed failure never rebuilds the shared HTTP pool', async () => {
  const refused = () => err('bad', { status: 503, code: 'invalid_request_error' });
  assert.deepEqual(await countRecycles(refused, { recycleDispatcherOn5xx: true }), { calls: 1, recycles: 0 });
  const tls = () => err('tls', { status: 525 });
  assert.deepEqual(await countRecycles(tls, { recycleDispatcherOn5xx: true }), { calls: 1, recycles: 0 });
});

test('a retried 5xx rebuilds the pool only under recycleDispatcherOn5xx', async () => {
  const unavailable = () => err('down', { status: 503 });
  assert.deepEqual(await countRecycles(unavailable), { calls: 3, recycles: 0 });
  assert.deepEqual(await countRecycles(unavailable, { recycleDispatcherOn5xx: true }), { calls: 3, recycles: 2 });
});

test('a retried stale keep-alive socket rebuilds the pool for every caller', async () => {
  const reset = () => err('socket reset', { code: 'ECONNRESET' });
  assert.deepEqual(await countRecycles(reset), { calls: 3, recycles: 2 });
});
