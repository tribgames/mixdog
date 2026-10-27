import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _FAST_MODE_POLICY,
  clearFastModeCooldown,
  fastModeAvailable,
  fastModeCooldownRemainingMs,
  fastModeDisabledReason,
  fastModeDowngraded,
  noteFastModeCapacityError,
} from './anthropic-fast-mode.mjs';
import { judgeInitialStatus } from './anthropic-oauth-request/initial-status.mjs';

const CREDITS_BODY =
  '{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for fast mode."}}';

test.beforeEach(() => clearFastModeCooldown());
test.after(() => clearFastModeCooldown());

test('non-capacity failures and standard-speed requests leave fast mode alone', () => {
  assert.equal(noteFastModeCapacityError({ httpStatus: 429 }, { fast: false }), 'ignored');
  assert.equal(noteFastModeCapacityError({ httpStatus: 500 }, { fast: true }), 'ignored');
  assert.equal(noteFastModeCapacityError({ httpStatus: 401 }, { fast: true }), 'ignored');
  assert.equal(fastModeAvailable(), true);
});

test('a short server window keeps fast mode so the cache prefix survives', () => {
  const decision = noteFastModeCapacityError(
    { httpStatus: 429, retryAfterMs: _FAST_MODE_POLICY.SHORT_RETRY_THRESHOLD_MS - 1 },
    { fast: true }
  );
  assert.equal(decision, 'retry-fast');
  assert.equal(fastModeAvailable(), true);
});

test('a long window downgrades to standard speed for at least the cooldown floor', () => {
  const now = 1_000_000;
  const retryAfterMs = 20_000;
  assert.equal(noteFastModeCapacityError({ httpStatus: 429, retryAfterMs }, { fast: true, now }), 'downgrade');
  assert.equal(fastModeAvailable(now), false);
  // 20s window is below the floor, so the floor wins.
  assert.equal(fastModeCooldownRemainingMs(now), _FAST_MODE_POLICY.MIN_COOLDOWN_MS);
  assert.equal(fastModeAvailable(now + _FAST_MODE_POLICY.MIN_COOLDOWN_MS), true);
});

test('a long window longer than the floor is honored verbatim', () => {
  const now = 2_000_000;
  const retryAfterMs = _FAST_MODE_POLICY.MIN_COOLDOWN_MS * 3;
  noteFastModeCapacityError({ httpStatus: 529, retryAfterMs }, { fast: true, now });
  assert.equal(fastModeCooldownRemainingMs(now), retryAfterMs);
});

test('a 529 with no window uses the default cooldown', () => {
  const now = 3_000_000;
  assert.equal(noteFastModeCapacityError({ httpStatus: 529 }, { fast: true, now }), 'downgrade');
  assert.equal(fastModeCooldownRemainingMs(now), _FAST_MODE_POLICY.DEFAULT_COOLDOWN_MS);
});

test('cooldowns never shrink an existing longer cooldown', () => {
  const now = 4_000_000;
  noteFastModeCapacityError({ httpStatus: 429, retryAfterMs: 600_000 }, { fast: true, now });
  noteFastModeCapacityError({ httpStatus: 429, retryAfterMs: 60_000 }, { fast: true, now });
  assert.equal(fastModeCooldownRemainingMs(now), 600_000);
});

test('an overage-disabled header turns fast mode off for the process', () => {
  const decision = noteFastModeCapacityError(
    {
      httpStatus: 429,
      headers: new Map([[_FAST_MODE_POLICY.OVERAGE_DISABLED_HEADER, 'no_overage']]),
      retryAfterMs: 1,
    },
    { fast: true }
  );
  assert.equal(decision, 'disabled');
  assert.equal(fastModeDisabledReason(), 'no_overage');
  assert.equal(fastModeAvailable(Date.now() + 86_400_000), false);
  clearFastModeCooldown();
  assert.equal(fastModeAvailable(), true);
});

test('plain-object headers resolve case-insensitively', () => {
  noteFastModeCapacityError(
    {
      httpStatus: 429,
      response: { headers: { 'ANTHROPIC-RateLimit-Unified-Overage-Disabled-Reason': 'billing' } },
    },
    { fast: true }
  );
  assert.equal(fastModeDisabledReason(), 'billing');
});

test('a "usage credits required" body is an ordinary fast-pool refusal: default cooldown, not a process disable', () => {
  const now = 9_000_000;
  const decision = noteFastModeCapacityError({ httpStatus: 429, message: CREDITS_BODY }, { fast: true, now });
  assert.equal(decision, 'downgrade');
  assert.equal(fastModeDisabledReason(), null);
  assert.equal(fastModeCooldownRemainingMs(now), _FAST_MODE_POLICY.DEFAULT_COOLDOWN_MS);
});

test('reference thresholds: short <20s, cooldown floor 10min, default hold 30min', () => {
  assert.deepEqual(
    [
      _FAST_MODE_POLICY.SHORT_RETRY_THRESHOLD_MS,
      _FAST_MODE_POLICY.MIN_COOLDOWN_MS,
      _FAST_MODE_POLICY.DEFAULT_COOLDOWN_MS,
    ],
    [20_000, 600_000, 1_800_000]
  );
});

test('an empty overage header still disables; a wallet-empty reason only drops this request', () => {
  const header = (value) => ({
    httpStatus: 429,
    headers: new Headers({ [_FAST_MODE_POLICY.OVERAGE_DISABLED_HEADER]: value }),
  });
  assert.equal(noteFastModeCapacityError(header('out_of_credits'), { fast: true }), 'downgrade');
  assert.equal(fastModeAvailable(), true, 'no cooldown and no disable');
  assert.equal(noteFastModeCapacityError(header(''), { fast: true }), 'disabled');
  assert.equal(fastModeAvailable(), false);
});

test('an initial fast-pool 429 drops speed and flags a standard-speed replay', async () => {
  const requestBody = { speed: 'fast' };
  const result = { response: { status: 429, headers: new Map(), text: async () => CREDITS_BODY } };
  await assert.rejects(
    judgeInitialStatus(result, requestBody, { provider: { scrubTokens: (s) => s }, cleanupCancelHandler: () => {} }),
    (err) => err.fastDowngraded === true && err.httpStatus === 429
  );
  assert.equal(requestBody.speed, undefined);
});

test('retry headers are parsed with the shared delay helper', () => {
  const short = noteFastModeCapacityError(
    { httpStatus: 429, headers: new Headers({ 'retry-after': '3' }) },
    { fast: true }
  );
  assert.equal(short, 'retry-fast');
  assert.equal(fastModeAvailable(), true);
  const shortMs = noteFastModeCapacityError(
    { httpStatus: 529, response: { headers: { 'retry-after-ms': '250' } } },
    { fast: true }
  );
  assert.equal(shortMs, 'retry-fast');
  const now = 5_000_000;
  const long = noteFastModeCapacityError(
    { httpStatus: 429, headers: new Headers({ 'retry-after': '600' }) },
    { fast: true, now }
  );
  assert.equal(long, 'downgrade');
  assert.equal(fastModeCooldownRemainingMs(now), 600_000);
});

test('"Fast mode is not enabled" disables fast mode for the process', () => {
  const decision = noteFastModeCapacityError(
    { httpStatus: 400, message: 'Fast mode is not enabled for this organization.' },
    { fast: true }
  );
  assert.equal(decision, 'disabled');
  assert.equal(fastModeDisabledReason(), 'fast_mode_not_enabled');
  clearFastModeCooldown();
  assert.equal(
    noteFastModeCapacityError({ httpStatus: 400, message: 'max_tokens too large' }, { fast: true }),
    'ignored'
  );
  assert.equal(fastModeAvailable(), true);
});

test('only an explicit downgrade or disable drops speed', () => {
  assert.equal(fastModeDowngraded('downgrade'), true);
  assert.equal(fastModeDowngraded('disabled'), true);
  assert.equal(fastModeDowngraded('retry-fast'), false);
  assert.equal(fastModeDowngraded('ignored'), false);
});

test('an initial 529 follows the same fast-pool rule as a 429', async () => {
  const judge = (headers, requestBody) =>
    judgeInitialStatus({ response: { status: 529, headers, text: async () => 'overloaded' } }, requestBody, {
      provider: { scrubTokens: (s) => s },
      cleanupCancelHandler: () => {},
    });
  const long = { speed: 'fast' };
  await assert.rejects(judge(new Headers({ 'retry-after': '3600' }), long), (err) => {
    assert.equal(err.fastDowngraded, true);
    assert.equal(err.status, 529);
    assert.equal(err.code, 'overloaded_error');
    return true;
  });
  assert.equal(long.speed, undefined);

  clearFastModeCooldown();
  const short = { speed: 'fast' };
  await assert.rejects(judge(new Headers({ 'retry-after-ms': '100' }), short), (err) => err.fastDowngraded === false);
  assert.equal(short.speed, 'fast');

  const standard = {};
  await assert.rejects(judge(new Headers(), standard), (err) => err.fastDowngraded === false);
});

test('a standard-speed 429 is not flagged for replay', async () => {
  const requestBody = {};
  const result = { response: { status: 429, headers: new Map(), text: async () => 'rate limited' } };
  await assert.rejects(
    judgeInitialStatus(result, requestBody, { provider: { scrubTokens: (s) => s }, cleanupCancelHandler: () => {} }),
    (err) => err.fastDowngraded === false
  );
  assert.equal(fastModeAvailable(), true);
});
