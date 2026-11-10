import assert from 'node:assert/strict';
import test from 'node:test';

import { failTurn, turnDoneItem } from './turn.mjs';
import { createTurnStream } from './turn-stream.mjs';

function failedCtx(error) {
  let state = { spinner: null };
  const stream = createTurnStream({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    isCurrentTurn: () => true,
  });
  const ctx = {
    turn: {
      startedAt: Date.now(),
      submittedIds: [],
      completionVerb: 'Done',
      routeMeta: { provider: 'route-provider', model: 'route-model' },
    },
    stream,
    cards: { aggregates: { finalizeToolHeaders() {} }, toolCards: [] },
    getState: () => state,
    nextId: () => 1,
    pushNotice() {},
  };
  failTurn(ctx, error);
  return ctx;
}

function failedItem(error) {
  return turnDoneItem(failedCtx(error));
}

const usageLimited = (error) => failedCtx(error).turn.usageLimited;

test('a quota-exhausted failure carries quota on the failed turndone', () => {
  const error = Object.assign(new Error('limit'), {
    quotaExhausted: { provider: 'openai-oauth', model: 'gpt-x', resetAt: 123 },
  });
  const item = failedItem(error);
  assert.equal(item.status, 'failed');
  assert.deepEqual(item.quota, { provider: 'openai-oauth', model: 'gpt-x', resetAt: 123 });
});

test('quota falls back to the route and a null reset', () => {
  const item = failedItem(Object.assign(new Error('limit'), { quotaExhausted: {} }));
  assert.deepEqual(item.quota, { provider: 'route-provider', model: 'route-model', resetAt: null });
});

test('a generic usage-limit failure has no quota field', () => {
  const item = failedItem(Object.assign(new Error('Too many requests'), { status: 429 }));
  assert.equal(item.status, 'failed');
  assert.equal('quota' in item, false);
});

test('provider overload is an ordinary failure, never a usage limit', () => {
  const message = 'Codex is at capacity, please try again later';
  const cases = {
    '429 at capacity': Object.assign(new Error(message), { httpStatus: 429 }),
    '429 untyped rate limit text': Object.assign(new Error('Rate limit reached, too many requests'), { status: 429 }),
    '503 server_is_overloaded': Object.assign(new Error(message), { httpStatus: 503, code: 'server_is_overloaded' }),
    '503 at capacity, no code': Object.assign(new Error(message), { httpStatus: 503 }),
    'response.failed server_is_overloaded': Object.assign(new Error(message), {
      responseFailed: { response: { error: { code: 'server_is_overloaded', message } } },
    }),
    '429 rate_limit_exceeded': Object.assign(new Error('Rate limit reached'), {
      httpStatus: 429,
      code: 'rate_limit_exceeded',
    }),
    slow_down: Object.assign(new Error('slow down'), { code: 'slow_down' }),
    'server_error with quota flag text': Object.assign(new Error('quota'), { code: 'server_error' }),
  };
  for (const [name, error] of Object.entries(cases)) {
    const ctx = failedCtx(error);
    assert.equal(ctx.turn.usageLimited, false, name);
    assert.equal(turnDoneItem(ctx).status, 'failed', name);
  }
  assert.match(failedCtx(cases['429 at capacity']).turn.failureDetail, /at capacity/);
});

test('typed quota exhaustion is a usage limit', () => {
  assert.equal(usageLimited(Object.assign(new Error('limit'), { httpStatus: 429, code: 'usage_limit_reached' })), true);
  assert.equal(
    usageLimited(
      Object.assign(new Error('limit'), {
        responseFailed: { response: { error: { code: 'usage_limit_reached', message: 'limit' } } },
      })
    ),
    true
  );
  assert.equal(usageLimited(Object.assign(new Error('x'), { httpStatus: 429, code: 'insufficient_quota' })), true);
  assert.equal(usageLimited(Object.assign(new Error('x'), { code: 'usage_not_included' })), true);
  assert.equal(usageLimited(Object.assign(new Error('x'), { code: 'quota_exceeded' })), true);
  assert.equal(usageLimited(Object.assign(new Error('x'), { providerQuota: true })), true);
  assert.equal(usageLimited(Object.assign(new Error('x'), { quotaExceeded: true })), true);
});

test('billing and plan-gated refusals are usage limits; minute-scoped quota is not', () => {
  assert.equal(usageLimited(Object.assign(new Error('x'), { status: 402 })), true);
  assert.equal(usageLimited(Object.assign(new Error('x'), { code: 'credit_balance_exhausted' })), true);
  assert.equal(usageLimited(Object.assign(new Error('x'), { code: 'quota_exceeded', quotaScope: 'minute' })), false);
  assert.equal(usageLimited(Object.assign(new Error('x'), { status: 403, code: 'cyber_policy' })), false);
});

test('the failed turndone carries the error kind descriptor', () => {
  const item = failedItem(
    Object.assign(new Error('busy'), { status: 429, code: 'server_is_overloaded', retryAfterMs: 2000 })
  );
  assert.deepEqual(item.errorKind, {
    kind: 'overloaded',
    code: 'server_is_overloaded',
    status: 429,
    retryAfterMs: 2000,
    resetAt: null,
  });
});

test('a provider-named quota reset reaches the quota metadata', () => {
  const resetAt = Date.now() + 3_600_000;
  const typed = failedItem(Object.assign(new Error('limit'), { status: 429, code: 'usage_limit_reached', resetAt }));
  assert.deepEqual(typed.quota, { provider: 'route-provider', model: 'route-model', resetAt });
  const pooled = failedItem(
    Object.assign(new Error('limit'), { quotaExhausted: { provider: 'p', model: 'm' }, resetAt })
  );
  assert.deepEqual(pooled.quota, { provider: 'p', model: 'm', resetAt });
  const throttled = failedItem(Object.assign(new Error('slow'), { status: 429, code: 'rate_limit_exceeded' }));
  assert.equal('quota' in throttled, false);
  // A rate-limit window reset is not spent usage.
  const burst = failedCtx(Object.assign(new Error('slow'), { status: 429, code: 'rate_limit_error', resetAt }));
  assert.equal(burst.turn.usageLimited, false);
  assert.equal('quota' in turnDoneItem(burst), false);
  assert.equal(turnDoneItem(burst).errorKind.resetAt, resetAt);
});

test('untyped errors fall back only to unambiguous quota wording', () => {
  assert.equal(usageLimited(new Error('You exceeded your current quota, please check your plan')), true);
  assert.equal(usageLimited(new Error('insufficient_quota')), true);
  assert.equal(usageLimited(new Error('Too many requests')), false);
});
