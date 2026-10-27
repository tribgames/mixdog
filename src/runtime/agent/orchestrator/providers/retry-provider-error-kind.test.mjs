import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DETERMINISTIC_KINDS, QUOTA_KINDS, providerErrorKind, retryAfterMsFromError } from './provider-error-kind.mjs';
import {
  classifyError,
  isContextOverflowError,
  isPermanentQuotaError,
  isRetryableWireErrorEvent,
  isServerUnavailable,
} from './retry-classification.mjs';

const err = (message, props = {}) => Object.assign(new Error(message), props);
const kindOf = (props, message = 'x') => providerErrorKind(err(message, props)).kind;

test('every kind maps from its typed code', () => {
  const cases = {
    overloaded: [
      { code: 'server_is_overloaded' },
      { error: { type: 'overloaded_error' } },
      { code: 'model_capacity_exhausted' },
    ],
    rate_limited: [{ code: 'rate_limit_exceeded' }, { code: 'slow_down' }, { error: { type: 'rate_limit_error' } }],
    quota_exhausted: [{ code: 'usage_limit_reached' }, { code: 'quota_exceeded' }],
    entitlement: [{ code: 'usage_not_included' }],
    billing: [
      { code: 'insufficient_quota' },
      { code: 'credit_balance_exhausted' },
      { code: 'organization_spend_limit_exceeded' },
      { code: 'project_spend_limit_exceeded' },
      { code: 'organization_usage_limit_exceeded' },
      { status: 402 },
    ],
    auth: [{ code: 'invalid_api_key' }, { status: 401 }, { reauthRequired: true }],
    permission: [{ code: 'permission_denied' }, { status: 403 }],
    context_overflow: [{ code: 'context_length_exceeded' }, { code: 'context_window_exceeded' }],
    request_too_large: [{ code: 'request_too_large' }, { status: 413 }],
    policy: [
      { code: 'cyber_policy' },
      { code: 'bio_policy' },
      { code: 'misalignment_policy_violation' },
      { code: 'content_policy_violation' },
      { code: 'safety', providerIncomplete: true },
      { code: 'recitation', providerIncomplete: true },
      { code: 'content_filter' },
    ],
    invalid_request: [{ status: 400 }, { code: 'invalid_request_error' }, { status: 422 }],
    transient: [
      { status: 503 },
      { code: 'ECONNRESET' },
      { status: 'DEADLINE_EXCEEDED' },
      { code: 'deadline_exceeded' },
      { code: 'malformed_stream' },
      { responseFailed: { response: { error: { code: 'server_error' } } } },
    ],
    unknown: [{}],
    // Google / Antigravity codes.
    _gemini: [],
  };
  for (const [kind, list] of Object.entries(cases)) {
    for (const props of list) assert.equal(kindOf(props), kind, `${kind}: ${JSON.stringify(props)}`);
  }
});

test('Google / Antigravity typed codes', () => {
  assert.equal(kindOf({ status: 429, code: 'quota_exhausted' }), 'quota_exhausted');
  assert.equal(kindOf({ status: 429, code: 'insufficient_g1_credits_balance' }), 'billing');
  assert.equal(kindOf({ status: 503, code: 'model_capacity_exceeded' }), 'overloaded');
  assert.equal(kindOf({ status: 429, code: 'model_capacity_exhausted' }), 'overloaded');
});

test('typed code wins over HTTP status', () => {
  assert.equal(kindOf({ status: 429, code: 'server_is_overloaded' }), 'overloaded');
  assert.equal(kindOf({ status: 403, code: 'cyber_policy' }), 'policy');
  assert.equal(kindOf({ status: 400, code: 'context_length_exceeded' }), 'context_overflow');
  assert.equal(kindOf({ status: 500, code: 'insufficient_quota' }), 'billing');
  // A specific code beats its envelope type.
  assert.equal(
    kindOf({ error: { type: 'invalid_request_error', code: 'context_length_exceeded' } }),
    'context_overflow'
  );
  assert.equal(kindOf({ status: 529 }), 'overloaded');
  assert.equal(kindOf({ status: 429 }), 'rate_limited');
});

test('quota scope, reset time and pool evidence decide quota vs rate limit', () => {
  assert.equal(kindOf({ status: 429, code: 'usage_limit_reached', quotaScope: 'minute' }), 'rate_limited');
  assert.equal(kindOf({ status: 429, code: 'resource_exhausted', quotaScope: 'minute' }), 'rate_limited');
  assert.equal(kindOf({ status: 429, code: 'resource_exhausted', quotaScope: 'day' }), 'quota_exhausted');
  assert.equal(kindOf({ status: 429, code: 'resource_exhausted' }), 'rate_limited');
  // A window reset alone is not quota evidence (rate-limit 429s carry it too).
  assert.equal(kindOf({ status: 429, code: 'rate_limit_error', resetAt: Date.now() + 60_000 }), 'rate_limited');
  assert.equal(kindOf({ status: 429, code: 'rate_limit_exceeded', quotaScope: 'plan' }), 'quota_exhausted');
  assert.equal(kindOf({ status: 429, providerQuota: true }), 'quota_exhausted');
  // Explicit quota evidence outranks a generic rate-limit code.
  assert.equal(kindOf({ status: 429, code: 'rate_limit_error', providerQuota: true }), 'quota_exhausted');
  assert.equal(kindOf({ status: 429, code: 'rate_limit_error', quotaExceeded: true }), 'quota_exhausted');
  assert.equal(kindOf({ status: 429, code: 'rate_limit_exceeded', providerQuota: true }), 'quota_exhausted');
  assert.equal(kindOf({ status: 429, code: 'rate_limit_error', quotaExhausted: { provider: 'p' } }), 'quota_exhausted');
  assert.equal(kindOf({ status: 429, code: 'rate_limit_error', quotaScope: 'day' }), 'quota_exhausted');
  assert.equal(
    kindOf({ status: 429, code: 'rate_limit_error', providerQuota: true, quotaScope: 'minute' }),
    'rate_limited'
  );
  assert.equal(kindOf({ status: 529, code: 'overloaded_error', providerQuota: true }), 'overloaded');
  assert.equal(kindOf({ status: 429, code: 'rate_limit_error', resetAt: Date.now() + 60_000 }), 'rate_limited');
  assert.equal(kindOf({ quotaExhausted: { provider: 'p', model: 'm', resetAt: 5 } }), 'quota_exhausted');
  const described = providerErrorKind(
    err('x', { status: 429, code: 'usage_limit_reached', resetAt: 1234, retryAfterMs: 50 })
  );
  assert.deepEqual(described, {
    kind: 'quota_exhausted',
    code: 'usage_limit_reached',
    status: 429,
    retryAfterMs: 50,
    resetAt: 1234,
  });
});

test('message wording only for untyped errors', () => {
  assert.equal(kindOf({ status: 429 }, 'Codex is at capacity, please try again later'), 'overloaded');
  assert.equal(kindOf({}, 'Our servers are currently overloaded'), 'unknown');
  assert.equal(kindOf({ code: 'server_error' }, 'quota_exceeded'), 'transient');
  assert.equal(kindOf({ status: 400 }, 'prompt is too long: 210000 tokens'), 'context_overflow');
  assert.equal(kindOf({ status: 400 }, 'Request payload size exceeds the limit: 20971520 bytes.'), 'request_too_large');
  assert.equal(providerErrorKind(err('Codex is at capacity', { status: 429 }), { text: false }).kind, 'rate_limited');
});

test('quota wording never yields a quota kind; only the legacy presentation option reads it on untyped errors', () => {
  const legacy = (props, message) => providerErrorKind(err(message, props), { legacyQuotaWording: true }).kind;
  for (const message of [
    'You exceeded your current quota, please check your plan',
    'insufficient_quota',
    'You have hit your usage limit',
  ]) {
    assert.equal(kindOf({}, message), 'unknown', message);
    assert.equal(kindOf({ status: 429 }, message), 'rate_limited', message);
    assert.equal(kindOf({ status: 500 }, message), 'transient', message);
  }
  assert.equal(legacy({}, 'You exceeded your current quota'), 'billing');
  assert.equal(legacy({}, 'You have hit your usage limit'), 'quota_exhausted');
  // Typed errors are never upgraded by wording, even under the option.
  assert.equal(legacy({ status: 429 }, 'You exceeded your current quota'), 'rate_limited');
  assert.equal(legacy({ code: 'rate_limit_exceeded' }, 'hit your usage limit'), 'rate_limited');
  assert.equal(legacy({ retryAfterMs: 1000 }, 'hit your usage limit'), 'unknown');
  assert.equal(legacy({}, 'Too many requests'), 'unknown');
});

test('classification follows the typed kind; 413 compaction needs token-context evidence', () => {
  assert.equal(classifyError(err('x', { status: 401, code: 'server_error' })), 'transient');
  assert.equal(classifyError(err('x', { status: 503, code: 'invalid_request_error' })), 'permanent');
  assert.equal(classifyError(err('x', { status: 499 })), 'permanent');
  assert.equal(classifyError(err('x', { status: 499 }), { retry499: true }), 'transient');
  assert.equal(classifyError(err('x', { status: 499, code: 'invalid_argument' }), { retry499: true }), 'permanent');
  for (const status of [525, 526]) {
    assert.equal(classifyError(err('x', { status, code: 'overloaded_error' })), 'permanent', `${status} overload code`);
  }
  const flex = providerErrorKind(err('x', { status: 429, code: 'flex_unavailable' }));
  assert.equal(flex.kind, 'service_tier_unavailable');
  assert.ok(DETERMINISTIC_KINDS.has(flex.kind) && !QUOTA_KINDS.has(flex.kind));
  assert.equal(classifyError(err('x', { status: 429, code: 'flex_unavailable' })), 'permanent');
  for (const props of [
    { status: 413 },
    { status: 413, code: 'payload_too_large' },
    { status: 413, code: 'request_entity_too_large' },
  ]) {
    assert.equal(isContextOverflowError(err('Request entity too large', props)), false, JSON.stringify(props));
  }
  assert.equal(
    isContextOverflowError(err('wrapped', { cause: err('Request entity too large', { status: 413 }) })),
    false
  );
  assert.equal(isContextOverflowError(err('prompt is too long: 300000 tokens', { status: 413 })), true);
  assert.equal(isContextOverflowError(err('x', { status: 413, code: 'context_length_exceeded' })), true);
  // An unlabelled byte-size wording (no status, no code) still routes to compaction.
  assert.equal(isContextOverflowError(err('request entity too large')), true);
});

test('retryAfterMsFromError reads stamped, nested wire, RetryInfo and slow_down advice', () => {
  assert.equal(retryAfterMsFromError(err('x', { retryAfterMs: 7_200_000 })), 7_200_000);
  assert.equal(
    retryAfterMsFromError(
      err('x', { responseFailed: { response: { error: { code: 'x', headers: { 'Retry-After': '3' } } } } })
    ),
    3000
  );
  assert.equal(retryAfterMsFromError(err('x', { error: { headers: { 'retry-after-ms': '250' } } })), 250);
  assert.equal(
    retryAfterMsFromError(
      err('x', { errorDetails: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] })
    ),
    12_000
  );
  assert.equal(retryAfterMsFromError(err('Slow down: please wait 5 seconds', { code: 'slow_down' })), 5000);
  assert.equal(retryAfterMsFromError(err('try again in 1.5s', { code: 'rate_limit_exceeded' })), 1500);
  // A quota reset time is reported separately, never as retry advice.
  assert.equal(retryAfterMsFromError(err('x', { resetAt: Date.now() + 3_600_000 })), null);
  const resetSec = String(Math.ceil(Date.now() / 1000) + 120);
  assert.equal(retryAfterMsFromError(err('x', { headers: { 'anthropic-ratelimit-unified-reset': resetSec } })), null);
});

test('zero or non-positive advice is no advice from every source', () => {
  const e = (props) => Object.assign(new Error('slow'), props);
  const none = {
    stamped: e({ retryAfterMs: 0 }),
    'retry-after': e({ headers: { 'retry-after': '0' } }),
    'retry-after-ms': e({ headers: { 'retry-after-ms': '0' } }),
    'response.headers': e({ response: { headers: { 'retry-after': '0' } } }),
    'error.headers': e({ error: { headers: { 'retry-after': '0' } } }),
    'past date': e({ headers: { 'retry-after': new Date(Date.now() - 60_000).toUTCString() } }),
    'RetryInfo 0s': e({ details: [{ retryDelay: '0s' }] }),
    'RetryInfo object': e({ details: [{ retryDelay: { seconds: 0, nanos: 0 } }] }),
    'typed message': e({ code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 0s.' }),
  };
  for (const [name, error] of Object.entries(none)) assert.equal(retryAfterMsFromError(error), null, name);
  assert.equal(
    retryAfterMsFromError(e({ headers: { 'retry-after-ms': '0', 'retry-after': '5' } })),
    5_000,
    'a later positive source still counts'
  );
});

test('classifiers consume the kind', () => {
  assert.equal(classifyError(err('x', { status: 429, code: 'server_is_overloaded' })), 'transient');
  assert.equal(classifyError(err('x', { status: 403, code: 'cyber_policy' })), 'permanent');
  assert.equal(classifyError(err('x', { status: 503, code: 'insufficient_quota' })), 'permanent');
  assert.equal(isPermanentQuotaError(err('x', { status: 429, code: 'usage_not_included' })), true);
  assert.equal(isPermanentQuotaError(err('x', { status: 429, code: 'resource_exhausted', retryAfterMs: 1000 })), false);
  assert.equal(isPermanentQuotaError(err('x', { status: 429, code: 'quota_exceeded', quotaScope: 'minute' })), false);
  assert.equal(isServerUnavailable(err('x', { status: 429, code: 'server_is_overloaded' })), true);
  assert.equal(isServerUnavailable(err('x', { status: 503, code: 'insufficient_quota' })), false);
  assert.equal(isServerUnavailable(err('x', { providerWireError: true, code: 'rate_limit_exceeded' })), false);
  // Deterministic wire codes outrank a numeric 5xx.
  for (const code of [
    'credit_balance_exhausted',
    'cyber_policy_violation',
    'flex_unavailable',
    'request_too_large',
    'content_filter',
  ]) {
    assert.equal(isRetryableWireErrorEvent(err('x', { providerWireError: true, status: 500, code })), false, code);
  }
  assert.equal(isRetryableWireErrorEvent(err('x', { providerWireError: true, code: 'server_error' })), true);
  // Typed byte-size refusals do not route to compaction.
  assert.equal(isContextOverflowError(err('x', { status: 413, code: 'request_too_large' })), false);
  assert.equal(isContextOverflowError(err('x', { status: 413 })), false);
});
