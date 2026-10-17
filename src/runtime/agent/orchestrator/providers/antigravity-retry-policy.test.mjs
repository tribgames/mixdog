import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS,
  ANTIGRAVITY_RETRY,
  antigravity429WaitMs,
  antigravityFirstBytePolicy,
  antigravityFirstResponseBudget,
  resolveAntigravityRetryConfig,
} from './antigravity-retry-policy.mjs';
import { GEMINI_FIRST_BYTE_TIMEOUT_MS } from './gemini-stream.mjs';
import { PROVIDER_MAX_BEFORE_WARN_MS, firstByteWindowMs } from '../stall-policy.mjs';

test('the same-host ladder defaults to 4 attempts at 1s / 2s / 4s with one first-byte retry', () => {
  assert.deepEqual(resolveAntigravityRetryConfig({}), {
    maxAttempts: 4,
    backoffMs: [1000, 1000, 2000, 4000],
    firstByteRetries: 1,
  });
  assert.equal(ANTIGRAVITY_RETRY.maxAttempts, 4);
  assert.deepEqual([...ANTIGRAVITY_RETRY.backoffMs], [1000, 1000, 2000, 4000]);
});

test('the ladder is configurable and clamped', () => {
  const config = resolveAntigravityRetryConfig({
    MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS: '9',
    MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS: '500, 750,1500',
    MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES: '0',
  });
  assert.deepEqual(config, { maxAttempts: 6, backoffMs: [500, 750, 1500], firstByteRetries: 0 });
  assert.equal(resolveAntigravityRetryConfig({ MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS: '0' }).maxAttempts, 1);
  // A malformed list or count keeps the defaults.
  const bad = resolveAntigravityRetryConfig({
    MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS: 'many',
    MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS: '1000,soon',
  });
  assert.equal(bad.maxAttempts, 4);
  assert.deepEqual([...bad.backoffMs], [1000, 1000, 2000, 4000]);
});

// Catalog records as normalizeAntigravityCatalog produces them. The second
// Pro record's id says "flash" on purpose: the class comes from `family`.
const CATALOG = [
  { id: 'gemini-4-argon', family: 'gemini-pro', wire: 'gemini-4-argon' },
  { id: 'gemini-3.1-pro', family: 'gemini-pro', wire: { low: 'gemini-3.1-pro-low', high: 'gemini-3.1-pro-high' } },
  { id: 'labs-flash-preview', family: 'gemini-pro', wire: 'labs-flash-preview' },
  {
    id: 'gemini-3.8-flash',
    family: 'gemini-flash',
    wire: { low: 'gemini-3.8-flash-low', high: 'gemini-3.8-flash-high' },
  },
  { id: 'claude-sonnet-4-6', wire: 'claude-sonnet-4-6' },
];

test('Pro-class Gemini (Argon, Pro tiers) waits 300s clamped to the ceiling, one retry', () => {
  assert.equal(ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS, Math.min(300_000, PROVIDER_MAX_BEFORE_WARN_MS));
  const expected = { timeoutMs: ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS, maxMs: PROVIDER_MAX_BEFORE_WARN_MS, retries: 1 };
  // Picker id, tier wire id, and a Pro record whose name says "flash".
  for (const model of ['gemini-4-argon', 'gemini-3.1-pro-high', 'labs-flash-preview']) {
    assert.deepEqual(antigravityFirstBytePolicy(model, CATALOG), expected, model);
  }
  const policy = antigravityFirstBytePolicy('gemini-4-argon', CATALOG);
  const retryWindow = Math.min(ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS * 2, PROVIDER_MAX_BEFORE_WARN_MS);
  assert.equal(firstByteWindowMs(policy, 1), retryWindow);
  // Every attempt gets a window (a drop or 5xx can land just before it ends),
  // widened after the permitted timeout; backoff is 1s / 2s / 4s before attempts 2-4.
  assert.deepEqual(antigravityFirstResponseBudget(policy), {
    transportMs: ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS + 3 * retryWindow + 1000 + 2000 + 4000,
    semanticMs: 2 * ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS + 6 * retryWindow + 1000 + 2000 + 4000,
  });
});

test('the budget covers a mixed ladder: drops and 5xx first, then the permitted first-byte timeouts', () => {
  const policy = antigravityFirstBytePolicy('gemini-4-argon', CATALOG);
  const retryWindow = firstByteWindowMs(policy, 1);
  // Worst sequence for 4 attempts: timeout, timeout, then a drop and a 5xx
  // each arriving at the end of the widened window, behind all backoff steps.
  const mixed = 1000 + 2000 + 4000 + ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS + 3 * retryWindow;
  const timeoutsOnly = 1000 + ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS + retryWindow;
  const budget = antigravityFirstResponseBudget(policy);
  assert.equal(budget.transportMs, mixed);
  assert.ok(budget.transportMs > timeoutsOnly);
  // The last backoff step repeats for the attempts past the end of the list.
  assert.equal(
    antigravityFirstResponseBudget(policy, [0, 500]).transportMs,
    ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS + 3 * retryWindow + 3 * 500
  );
});

test('Flash-class Gemini waits the shared 60s window, one retry at double the window', () => {
  for (const model of ['gemini-3.8-flash', 'gemini-3.8-flash-low']) {
    assert.deepEqual(
      antigravityFirstBytePolicy(model, CATALOG),
      { timeoutMs: GEMINI_FIRST_BYTE_TIMEOUT_MS, maxMs: PROVIDER_MAX_BEFORE_WARN_MS, retries: 1 },
      model
    );
  }
  const policy = antigravityFirstBytePolicy('gemini-3.8-flash', CATALOG);
  const retryWindow = Math.min(GEMINI_FIRST_BYTE_TIMEOUT_MS * 2, PROVIDER_MAX_BEFORE_WARN_MS);
  assert.deepEqual(antigravityFirstResponseBudget(policy), {
    transportMs: GEMINI_FIRST_BYTE_TIMEOUT_MS + 3 * retryWindow + 1000 + 2000 + 4000,
    semanticMs: 2 * GEMINI_FIRST_BYTE_TIMEOUT_MS + 6 * retryWindow + 1000 + 2000 + 4000,
  });
});

test('models without a Gemini family keep the shared Gemini first-byte window on the ordinary ladder', () => {
  // An id the catalog does not list is not classed by its name.
  assert.equal(antigravityFirstBytePolicy('gemini-9-pro-unlisted', CATALOG).retries, null);
  const policy = antigravityFirstBytePolicy('claude-sonnet-4-6', CATALOG);
  assert.equal(policy.retries, null);
  assert.equal(firstByteWindowMs(policy, 3), GEMINI_FIRST_BYTE_TIMEOUT_MS);
});

test('an unclassed model budgets every attempt of the transport ladder it retries first-byte timeouts on', () => {
  // The default ladder (pinned above): 4 attempts, 1s / 2s / 4s before attempts 2-4.
  const backoff = 1000 + 2000 + 4000;
  const expected = {
    transportMs: 4 * GEMINI_FIRST_BYTE_TIMEOUT_MS + backoff,
    semanticMs: 8 * GEMINI_FIRST_BYTE_TIMEOUT_MS + backoff,
  };
  // A non-Gemini id and an id the catalog does not list.
  for (const model of ['claude-sonnet-4-6', 'gemini-9-pro-unlisted']) {
    assert.deepEqual(antigravityFirstResponseBudget(antigravityFirstBytePolicy(model, CATALOG)), expected, model);
  }
});

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
