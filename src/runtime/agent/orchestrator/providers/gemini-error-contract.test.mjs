import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleGenerativeAIFetchError } from '@google/generative-ai';
import { geminiErrorContract, geminiPolicyFinishCode } from './gemini-error-contract.mjs';
import { geminiRestError } from './gemini.mjs';
import { normalizeGeminiSdkError } from './gemini-stream.mjs';
import { antigravityError } from './antigravity-transport.mjs';
import { geminiIncompleteError } from './gemini-response.mjs';
import { providerErrorKind } from './provider-error-kind.mjs';
import { isAntigravityCapacityError } from './antigravity-retry-policy.mjs';

const T = 'type.googleapis.com/google.rpc.';
const retryInfo = (retryDelay) => ({ '@type': `${T}RetryInfo`, retryDelay });
const quotaFailure = (...quotaIds) => ({
  '@type': `${T}QuotaFailure`,
  violations: quotaIds.map((quotaId) => ({ quotaId })),
});
const errorInfo = (reason, metadata = {}) => ({ '@type': `${T}ErrorInfo`, reason, domain: 'googleapis.com', metadata });

test('contract reads RetryInfo, QuotaFailure scope and ErrorInfo reason from details', () => {
  const fields = geminiErrorContract({
    details: [
      errorInfo('RATE_LIMIT_EXCEEDED'),
      quotaFailure('GenerateRequestsPerMinutePerProjectPerModel'),
      retryInfo('34.07s'),
    ],
    googleStatus: 'RESOURCE_EXHAUSTED',
  });
  assert.equal(fields.code, 'rate_limit_exceeded');
  assert.equal(fields.retryAfterMs, 34_070);
  assert.equal(fields.quotaScope, 'minute');
  assert.ok(Math.abs(fields.resetAt - (Date.now() + 34_070)) < 2_000);
});

test('contract reads SDK errorDetails, falls back to the Google status and keeps retry uncapped', () => {
  const fields = geminiErrorContract({
    errorDetails: [quotaFailure('GenerateRequestsPerDayPerProjectPerModel'), retryInfo({ seconds: '90000', nanos: 0 })],
    googleStatus: 'RESOURCE_EXHAUSTED',
  });
  assert.equal(fields.code, 'resource_exhausted');
  assert.equal(fields.quotaScope, 'day');
  assert.equal(fields.retryAfterMs, 90_000_000);
});

test('contract has no scope without per-minute/per-day evidence', () => {
  const fields = geminiErrorContract({ details: [quotaFailure('SomeOtherQuota')], googleStatus: 'UNAVAILABLE' });
  assert.deepEqual(fields, { code: 'unavailable' });
});

test('geminiRestError maps details/errorDetails into the contract fields', () => {
  const res = { status: 429, headers: new Headers() };
  const body = {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'quota',
      errorDetails: [errorInfo('QUOTA_EXHAUSTED'), quotaFailure('GenerateRequestsPerDayPerProjectPerModel'), retryInfo('3600s')],
    },
  };
  const err = geminiRestError(res, JSON.stringify(body), 'Gemini');
  assert.equal(err.status, 429);
  assert.equal(err.code, 'quota_exhausted');
  assert.equal(err.quotaScope, 'day');
  assert.equal(err.retryAfterMs, 3_600_000);
  assert.equal(err.geminiStatus, 'RESOURCE_EXHAUSTED');
  assert.equal(err.headers, res.headers);
});

test('geminiRestError lowercases the Google status when no ErrorInfo is present', () => {
  const err = geminiRestError(
    { status: 503, headers: new Headers() },
    JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'busy' } }),
    'Gemini'
  );
  assert.equal(err.code, 'unavailable');
});

test('normalizeGeminiSdkError reads errorDetails off the SDK fetch error', () => {
  const sdkErr = new GoogleGenerativeAIFetchError('[429 Too Many Requests] quota', 429, 'Too Many Requests', [
    errorInfo('RATE_LIMIT_EXCEEDED'),
    quotaFailure('GenerateRequestsPerMinutePerProjectPerModel'),
    retryInfo('12s'),
  ]);
  const err = normalizeGeminiSdkError(sdkErr, 'Gemini SDK');
  assert.equal(err.status, 429);
  assert.equal(err.code, 'rate_limit_exceeded');
  assert.equal(err.quotaScope, 'minute');
  assert.equal(err.retryAfterMs, 12_000);
});

test('antigravityError extracts ErrorInfo reason, quotaResetDelay and quotaResetTimeStamp', () => {
  const stamp = '2099-01-01T00:00:00Z';
  const err = antigravityError(
    { status: 429, headers: new Headers() },
    JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'exhausted',
        details: [
          errorInfo('QUOTA_EXHAUSTED', {
            quotaResetDelay: '373.803813ms',
            quotaResetTimeStamp: stamp,
            quotaId: 'RequestsPerDay',
          }),
        ],
      },
    }),
    'endpoint'
  );
  assert.equal(err.code, 'quota_exhausted');
  assert.equal(err.retryAfterMs, 374);
  assert.equal(err.resetAt, Date.parse(stamp));
  assert.equal(err.quotaScope, 'day');
});

for (const [name, body] of [
  [
    'ErrorInfo reason',
    { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'x', details: [errorInfo('MODEL_CAPACITY_EXHAUSTED')] },
  ],
  ['server busy message', { code: 503, status: 'UNAVAILABLE', message: 'The server is busy, try later' }],
  ['no capacity message', { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'No capacity available for model x' }],
]) {
  test(`antigravityError marks capacity (${name}) as model_capacity_exhausted`, () => {
    const err = antigravityError({ status: body.code, headers: new Headers() }, JSON.stringify({ error: body }), 'e');
    assert.equal(err.code, 'model_capacity_exhausted');
  });
}

test('safety and recitation finish reasons carry policy codes', () => {
  assert.equal(geminiPolicyFinishCode('SAFETY'), 'safety');
  assert.equal(geminiPolicyFinishCode('FINISH_REASON_SAFETY'), 'safety');
  assert.equal(geminiPolicyFinishCode('PROMPT_BLOCKLIST'), 'safety');
  assert.equal(geminiPolicyFinishCode('RECITATION'), 'recitation');
  assert.equal(geminiPolicyFinishCode('MAX_TOKENS'), null);
  const parsed = (finishReason) => ({ candidate: { finishReason }, content: '', toolCalls: undefined });
  assert.equal(geminiIncompleteError({}, parsed('SAFETY'), 'm').code, 'safety');
  assert.equal(geminiIncompleteError({}, parsed('RECITATION'), 'm').code, 'recitation');
  assert.equal(geminiIncompleteError({}, parsed('MAX_TOKENS'), 'm').code, 'PROVIDER_INCOMPLETE');
  assert.equal(
    geminiIncompleteError({ promptFeedback: { blockReason: 'SAFETY' } }, { candidate: null }, 'm').code,
    'safety'
  );
});

// ── Retry-policy alignment (Google error classification, account rotation) ──

test('per-minute quota without RetryInfo waits one 60s window (QuotaFailure and quota_limit)', () => {
  const byQuotaFailure = geminiErrorContract({
    details: [quotaFailure('GenerateRequestsPerMinutePerProjectPerModel')],
    googleStatus: 'RESOURCE_EXHAUSTED',
  });
  assert.equal(byQuotaFailure.quotaScope, 'minute');
  assert.equal(byQuotaFailure.retryAfterMs, 60_000);
  assert.ok(Math.abs(byQuotaFailure.resetAt - (Date.now() + 60_000)) < 2_000);
  const byMetadata = geminiErrorContract({
    details: [errorInfo('RATE_LIMIT_EXCEEDED', { quota_limit: 'RequestsPerMinutePerProject' })],
  });
  assert.equal(byMetadata.retryAfterMs, 60_000);
  assert.equal(geminiErrorContract({ details: [quotaFailure('X'), retryInfo('5s')] }).retryAfterMs, 5000);
});

test('long server advice alone is never quota evidence', () => {
  const long = geminiErrorContract({ details: [retryInfo('601s')] });
  assert.equal(long.quotaScope, undefined);
  assert.equal(long.retryAfterMs, 601_000);
  assert.equal(geminiErrorContract({ details: [retryInfo('300s')] }).quotaScope, undefined);
  const byMessage = geminiErrorContract({ message: 'Please retry in 400s' });
  assert.equal(byMessage.quotaScope, undefined);
  assert.equal(byMessage.retryAfterMs, 400_000);
});

test('zero RetryInfo is no advice: normal backoff, and the 60s window for a per-minute quota', () => {
  const none = geminiErrorContract({ details: [retryInfo('0s')], googleStatus: 'UNAVAILABLE' });
  assert.equal(none.retryAfterMs, undefined);
  assert.equal(none.resetAt, undefined);
  assert.equal(geminiErrorContract({ details: [retryInfo({ seconds: '0', nanos: 0 })] }).retryAfterMs, undefined);
  assert.equal(geminiErrorContract({ message: 'Please retry in 0s' }).retryAfterMs, undefined);
  const perMinute = geminiErrorContract({
    details: [quotaFailure('GenerateRequestsPerMinutePerProjectPerModel'), retryInfo('0s')],
  });
  assert.equal(perMinute.retryAfterMs, 60_000);
  assert.equal(geminiErrorContract({ details: [retryInfo('0s'), retryInfo('5s')] }).retryAfterMs, 5000);
  const err = geminiRestError(
    { status: 503, headers: new Headers() },
    JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'busy', details: [retryInfo('0s')] } }),
    'Gemini'
  );
  assert.equal(err.retryAfterMs, undefined);
  assert.equal(providerErrorKind(err).retryAfterMs, null);
});

test('ErrorInfo QUOTA_EXHAUSTED and "limit: 0" are spent quotas with no window', () => {
  assert.equal(geminiErrorContract({ details: [errorInfo('QUOTA_EXHAUSTED')] }).quotaScope, 'plan');
  assert.equal(geminiErrorContract({ details: [errorInfo('INSUFFICIENT_G1_CREDITS_BALANCE')] }).quotaScope, 'plan');
  const zeroLimit = { violations: [{ quotaId: 'GenerateContentFreeTierRequests', description: 'Quota exceeded, limit: 0, model: x' }] };
  assert.equal(geminiErrorContract({ details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', ...zeroLimit }] }).quotaScope, 'plan');
  assert.equal(
    geminiErrorContract({ details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaValue: '0' }] }] }).quotaScope,
    'plan'
  );
  assert.equal(
    geminiErrorContract({ details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ description: 'limit: 0.5 something' }] }] }).quotaScope,
    undefined
  );
});

test('"limit: 0" in message text alone is never quota evidence', () => {
  assert.equal(geminiErrorContract({ message: 'Quota exceeded, limit: 0, model: x' }).quotaScope, undefined);
  assert.equal(geminiErrorContract({ message: 'limit: 0.5 something' }).quotaScope, undefined);
});

test('a typed deterministic reason on a 503/529 is not restamped as capacity', () => {
  for (const status of [503, 529]) {
    const body = { error: { code: status, status: 'INVALID_ARGUMENT', message: 'bad request', details: [errorInfo('INVALID_ARGUMENT')] } };
    const err = antigravityError({ status, headers: new Headers() }, JSON.stringify(body), 'https://x');
    assert.notEqual(err.code, 'model_capacity_exhausted');
    assert.equal(isAntigravityCapacityError(err), false);
  }
  const plain = antigravityError({ status: 503, headers: new Headers() }, JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'busy' } }), 'https://x');
  assert.equal(plain.code, 'model_capacity_exhausted');
});

test('delay is read from the message when no RetryInfo is present', () => {
  assert.equal(geminiErrorContract({ message: 'Quota hit. Please retry in 2.5s.' }).retryAfterMs, 2500);
  assert.equal(geminiErrorContract({ message: 'Please retry in 900ms' }).retryAfterMs, 900);
  assert.equal(geminiErrorContract({ message: 'Your quota will reset after 2h1m1s' }).retryAfterMs, 7_261_000);
  assert.equal(geminiErrorContract({ details: [retryInfo('4s')], message: 'Please retry in 9s' }).retryAfterMs, 4000);
});

test('reset parsing accepts compound Go durations and bare seconds', () => {
  const meta = (quotaResetDelay) => geminiErrorContract({ details: [errorInfo('RATE_LIMIT_EXCEEDED', { quotaResetDelay })] });
  assert.equal(meta('1h16m0.667s').retryAfterMs, 4_560_667);
  assert.equal(meta('30').retryAfterMs, 30_000);
  assert.equal(meta('200ms').retryAfterMs, 200);
});

test('capacity is an overload, never a quota, and a typed reason outranks capacity wording', () => {
  const byReason = geminiErrorContract({
    details: [errorInfo('MODEL_CAPACITY_EXCEEDED'), retryInfo('900s')],
    googleStatus: 'RESOURCE_EXHAUSTED',
  });
  assert.equal(byReason.code, 'model_capacity_exhausted');
  assert.equal(byReason.quotaScope, undefined);
  const byMessage = geminiErrorContract({ message: 'You have exhausted your capacity on this model.' });
  assert.equal(byMessage.code, 'model_capacity_exhausted');
  const quota = geminiErrorContract({
    details: [errorInfo('QUOTA_EXHAUSTED')],
    message: 'You have exhausted your capacity on this model. Your quota will reset after 3h44m.',
  });
  assert.equal(quota.code, 'quota_exhausted');
  assert.equal(quota.quotaScope, 'plan');
  assert.equal(quota.retryAfterMs, 13_440_000);
  assert.equal(geminiErrorContract({ details: [quotaFailure('PerMinute')], message: 'capacity exceeded' }).code, undefined);
});

for (const [name, status, body, expected] of [
  ['503 is capacity by status', 503, { code: 503, status: 'UNAVAILABLE', message: 'try later' }, 'model_capacity_exhausted'],
  ['529 is capacity by status', 529, { code: 529, message: 'Overloaded' }, 'model_capacity_exhausted'],
  ['429 "overloaded" wording is capacity', 429, { code: 429, message: 'The model is overloaded' }, 'model_capacity_exhausted'],
  ['429 "per minute" wording is an RPM limit', 429, { code: 429, message: 'Too many requests per minute' }, 'rate_limit_exceeded'],
  ['429 "quota" wording alone is not a typed quota refusal', 429, { code: 429, message: 'You exceeded your current quota' }, undefined],
]) {
  test(`antigravityError: ${name}`, () => {
    const err = antigravityError({ status, headers: new Headers() }, JSON.stringify({ error: body }), 'e');
    assert.equal(err.code, expected);
    if (expected === undefined) assert.equal(err.quotaScope, undefined);
  });
}

test('antigravityError: a typed ErrorInfo reason outranks message wording on a 429', () => {
  const err = antigravityError(
    { status: 429, headers: new Headers() },
    JSON.stringify({
      error: { code: 429, message: 'capacity exhausted', details: [errorInfo('RATE_LIMIT_EXCEEDED')] },
    }),
    'e'
  );
  assert.equal(err.code, 'rate_limit_exceeded');
});

test('a rejected API key on an INVALID_ARGUMENT 400 is an auth failure, not a request refusal', () => {
  for (const reason of ['API_KEY_INVALID', 'API_KEY_EXPIRED']) {
    const body = {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [errorInfo(reason)],
      },
    };
    const err = geminiRestError({ status: 400, headers: new Headers() }, JSON.stringify(body), 'Gemini');
    assert.equal(providerErrorKind(err).kind, 'auth', reason);
  }
  const disabled = geminiRestError(
    { status: 403, headers: new Headers() },
    JSON.stringify({
      error: {
        code: 403,
        message: 'API has not been used',
        status: 'PERMISSION_DENIED',
        details: [errorInfo('SERVICE_DISABLED')],
      },
    }),
    'Gemini'
  );
  assert.equal(providerErrorKind(disabled).kind, 'permission');
  // An ordinary INVALID_ARGUMENT stays a request refusal.
  const invalid = geminiRestError(
    { status: 400, headers: new Headers() },
    JSON.stringify({ error: { code: 400, message: 'bad field', status: 'INVALID_ARGUMENT' } }),
    'Gemini'
  );
  assert.equal(providerErrorKind(invalid).kind, 'invalid_request');
});
