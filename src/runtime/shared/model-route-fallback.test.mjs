import test from 'node:test';
import assert from 'node:assert/strict';
import { canFallbackRoute } from './model-route-fallback.mjs';

test('only explicit pre-generation provider refusals permit switching', () => {
  assert.equal(canFallbackRoute({ status: 429 }), true);
  assert.equal(canFallbackRoute({ status: 503 }), true);
  for (const error of [
    { status: 401 },
    { status: 403 },
    { status: 400 },
    { status: 402 },
    { code: 'ECONNRESET' },
    new Error('unknown failure'),
    { status: 429, name: 'AbortError' },
    { status: 503, partialContent: 'visible' },
    { status: 503, toolCallsStarted: true },
    { status: 503, toolCallsDispatched: 1 },
    { status: 503, streamStalled: true },
  ])
    assert.equal(canFallbackRoute(error), false);
  assert.equal(canFallbackRoute({ status: 429 }, { committed: true }), false);
  assert.equal(canFallbackRoute({ status: 429 }, { signal: AbortSignal.abort() }), false);
});
