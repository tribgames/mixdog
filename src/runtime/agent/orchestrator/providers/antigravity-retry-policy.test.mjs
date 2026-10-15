import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravity429WaitMs } from './antigravity-retry-policy.mjs';

const fresh = () => ({ capacityRetries: 0, quickRetried: false });
const e429 = (fields) => Object.assign(new Error('x'), { status: 429, ...fields });

test('a quick RPM retry honors advice up to 60s in full', () => {
  assert.equal(antigravity429WaitMs(e429({ code: 'rate_limit_exceeded', retryAfterMs: 45_000 }), fresh()), 45_000);
  assert.equal(antigravity429WaitMs(e429({ code: 'rate_limit_exceeded', retryAfterMs: 60_000 }), fresh()), 60_000);
});

test('RPM advice beyond 60s surfaces so the pool can rotate', () => {
  const state = fresh();
  assert.equal(antigravity429WaitMs(e429({ code: 'rate_limit_exceeded', retryAfterMs: 60_001 }), state), null);
  assert.equal(state.quickRetried, false);
});

test('capacity follows the local 1s / 2s / 4s schedule without advice', () => {
  const state = fresh();
  for (const status of [429, 503, 529]) {
    const wait = antigravity429WaitMs(
      Object.assign(new Error('x'), { status, code: 'model_capacity_exhausted' }),
      state
    );
    assert.ok(wait <= 4400, `${status}: ${wait}`);
  }
  assert.equal(state.capacityRetries, 3);
  assert.equal(antigravity429WaitMs(e429({ code: 'model_capacity_exhausted' }), state), null);
});

test('capacity waits at least the advised RetryInfo delay', () => {
  const wait = antigravity429WaitMs(e429({ code: 'model_capacity_exhausted', retryAfterMs: 20_000 }), fresh());
  assert.equal(wait, 20_000);
  // Advice shorter than the local step keeps the local floor.
  const short = antigravity429WaitMs(e429({ code: 'model_capacity_exhausted', retryAfterMs: 10 }), fresh());
  assert.ok(short >= 900, `${short}`);
});

test('capacity advice beyond the retry budget surfaces with the reset time', () => {
  const state = fresh();
  const err = e429({ code: 'model_capacity_exhausted', retryAfterMs: 600_000 });
  const before = Date.now();
  assert.equal(antigravity429WaitMs(err, state), null);
  assert.equal(state.capacityRetries, 0);
  assert.ok(err.resetAt >= before + 600_000);
});

test('advised capacity waits accumulate against the budget', () => {
  const state = fresh();
  assert.equal(antigravity429WaitMs(e429({ code: 'model_capacity_exhausted', retryAfterMs: 40_000 }), state), 40_000);
  assert.equal(antigravity429WaitMs(e429({ code: 'model_capacity_exhausted', retryAfterMs: 40_000 }), state), null);
});

test('local steps apply when there is no advice', () => {
  assert.equal(antigravity429WaitMs(e429({ code: 'rate_limit_exceeded' }), fresh()), 1000);
  const wait = antigravity429WaitMs(e429({ code: 'model_capacity_exhausted' }), fresh());
  assert.ok(wait >= 900 && wait <= 1100);
});

test('a non-capacity 5xx is not a 429 verdict', () => {
  assert.equal(antigravity429WaitMs(Object.assign(new Error('x'), { status: 500 }), fresh()), null);
});

test('deterministic kinds never retry on a 429', () => {
  assert.equal(antigravity429WaitMs(e429({ code: 'cyber_policy' }), fresh()), null);
  assert.equal(antigravity429WaitMs(e429({ code: 'quota_exhausted' }), fresh()), null);
});
