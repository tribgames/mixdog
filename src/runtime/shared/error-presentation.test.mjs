import assert from 'node:assert/strict';
import test from 'node:test';
import { describeError, safeErrorDetails } from './error-presentation.mjs';
import { anthropicQuotaError } from '../agent/orchestrator/providers/anthropic-oauth-request/initial-status.mjs';
import { presentErrorText } from './err-text.mjs';
import { DETERMINISTIC_KINDS, providerErrorKind } from '../agent/orchestrator/providers/provider-error-kind.mjs';

const providerFailure = (index) =>
  new Error(
    `Anthropic OAuth API 400: ${JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `messages.11.content.${index}.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests`,
      },
    })}`
  );

test('prefixed provider JSON becomes a short actionable summary without discarding diagnostics', () => {
  const failure = providerFailure(54);
  const result = describeError(failure);
  assert.equal(result.kind, 'image-size');
  assert.equal(result.summary, 'An attached image exceeds the provider limit.');
  assert.match(result.recovery, /image dimensions or number/);
  assert.match(result.details, /content\.54/);
  assert.equal(result.fingerprint, describeError(providerFailure(62)).fingerprint);
  assert.equal(presentErrorText(failure), result.summary);
});

test('typed failures distinguish sign-in, rate, request and connection recovery', () => {
  for (const [status, kind] of [
    [401, 'authentication'],
    [429, 'rate-limit'],
    [400, 'request'],
    [413, 'payload-size'],
    [503, 'connection'],
  ]) {
    const result = describeError(Object.assign(new Error('upstream rejected the request'), { status }));
    assert.equal(result.kind, kind);
    assert.ok(result.recovery);
  }
  assert.equal(
    describeError(new Error('ordinary failure A')).fingerprint ===
      describeError(new Error('ordinary failure B')).fingerprint,
    false
  );
});

test('an Anthropic 429 is a usage limit only when the quota headers say so', () => {
  const body = '{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}';
  const rejected = anthropicQuotaError(429, new Map(), body);
  assert.equal(rejected.code, 'rate_limit_error');
  assert.equal(rejected.name, 'ProviderRequestRejectedError');
  assert.equal(rejected.providerQuota, false);
  assert.equal(describeError(rejected).kind, 'request');
  assert.equal(describeError(rejected.message).kind, 'request');
  assert.equal(presentErrorText(rejected), 'The provider rejected this request.');

  const quota = anthropicQuotaError(
    429,
    new Map([['anthropic-ratelimit-unified-representative-claim', 'five_hour']]),
    body
  );
  assert.equal(quota.code, 'rate_limit_error');
  assert.equal(quota.name, 'ProviderQuotaError');
  assert.equal(quota.providerQuota, true);
  // The rejected quota headers (providerQuota) are explicit quota evidence and
  // outrank the generic rate_limit_error code: usage-limit wording.
  assert.equal(describeError(quota).providerKind, 'quota_exhausted');
  assert.equal(describeError(quota).kind, 'quota');
  assert.match(presentErrorText(quota), /usage limit/i);
});

test('each provider kind gets its own message and next step; a persisted descriptor beats wording', () => {
  const kinds = {
    overloaded: [/busy right now/, /another model/],
    rate_limited: [/rate-limiting/, /Try again shortly/],
    quota_exhausted: [/usage limit was reached/, /reset or choose another account/],
    entitlement: [/isn't included in your plan/, /Upgrade your plan/],
    billing: [/out of credits/, /billing/],
    permission: [/don't have access/, /permissions/],
    context_overflow: [/too long/, /Compact/],
    request_too_large: [/size limit/, /Reduce the attachments/],
    policy: [/safety policy/, /Rephrase/],
  };
  for (const [kind, [summary, recovery]] of Object.entries(kinds)) {
    // Text that would otherwise read as a usage limit never overrides the descriptor.
    const result = describeError({ message: 'usage limit rate limit exceeded', errorKind: { kind } });
    assert.match(result.summary, summary, kind);
    assert.match(result.recovery, recovery, kind);
    assert.equal(result.providerKind, kind);
    if (kind !== 'quota_exhausted') assert.doesNotMatch(result.summary + result.recovery, /usage limit/i, kind);
  }
  for (const kind of ['overloaded', 'rate_limited', 'entitlement', 'billing', 'permission', 'policy']) {
    assert.doesNotMatch(describeError({ message: 'x', errorKind: { kind } }).recovery, /wait for the limit to reset/i);
  }
  assert.equal(describeError({ message: 'x', errorKind: { kind: 'permission' } }).recovery.includes('sign'), false);
});

test('typed codes classify errors; the wait and reset time are shown when known', () => {
  const overloaded = Object.assign(new Error('Overloaded'), { status: 529 });
  assert.equal(describeError(overloaded).providerKind, 'overloaded');
  assert.equal(presentErrorText(overloaded), 'Provider is busy at capacity.');
  const limited = Object.assign(new Error('slow down'), {
    status: 429,
    code: 'rate_limit_exceeded',
    retryAfterMs: 90_000,
  });
  const rate = describeError(limited);
  assert.equal(rate.kind, 'rate-limit');
  assert.equal(rate.recovery, 'Try again in 2m.');
  assert.equal(rate.recoveryTemplate, 'Try again in {{wait}}.');
  assert.equal(presentErrorText(limited), 'Provider is rate-limited (retry in 90s).');
  const resetAt = Date.now() + 3_600_000;
  const quota = describeError({ message: 'out', errorKind: { kind: 'quota_exhausted', resetAt } });
  assert.equal(quota.resetAt, resetAt);
  assert.match(quota.recovery, /^It resets at (?:\d+\/\d+ )?\d{2}:\d{2}\. Switch accounts or providers/);
  assert.equal(describeError({ message: 'x', errorKind: { kind: 'quota_exhausted' } }).params, null);
  assert.equal(describeError(Object.assign(new Error('forbidden'), { status: 403 })).providerKind, 'permission');
  assert.equal(describeError(Object.assign(new Error('nope'), { status: 400, code: 'cyber_policy' })).kind, 'policy');
  assert.equal(
    describeError(Object.assign(new Error('x'), { code: 'context_length_exceeded', status: 400 })).kind,
    'context-overflow'
  );
  assert.equal(presentErrorText({ message: 'x', errorKind: { kind: 'billing' } }), 'Out of credits or at spend limit.');
  assert.equal(presentErrorText({ message: 'x', errorKind: { kind: 'entitlement' } }), 'Not included in your plan.');
  assert.equal(describeError('The provider usage limit was reached.').kind, 'quota');
  // A bare message has no typed evidence: its wording keeps the legacy line and parsed wait.
  assert.equal(
    presentErrorText(new Error('Anthropic OAuth API 429 quota/rate limit retryAfter=214641s')),
    'Anthropic quota/rate limit hit; retry after 2d 11h 37m.'
  );
});

test('a 403 keeps its account-permission reading: no model-proxy gate kind exists', () => {
  assert.equal(providerErrorKind(Object.assign(new Error('forbidden'), { status: 403 })).kind, 'permission');
  assert.equal(DETERMINISTIC_KINDS.has('model_proxy_permission'), false);
  assert.equal(DETERMINISTIC_KINDS.has('model_proxy_wait'), false);
});

test('a persisted kind beats auth wording in the text', () => {
  const item = { message: 'Overloaded: invalid API key echoed', errorKind: { kind: 'overloaded' } };
  const result = describeError(item);
  assert.equal(result.kind, 'overloaded');
  assert.equal(result.providerKind, 'overloaded');
  // Legacy items without a descriptor keep the wording heuristic.
  assert.equal(describeError('invalid API key').kind, 'authentication');
});

test('typed kinds skip every wording heuristic; wording only serves untyped items', () => {
  const typedOverloaded = describeError({ message: 'invalid_grant', errorKind: { kind: 'overloaded' } });
  assert.equal(typedOverloaded.kind, 'overloaded');
  assert.equal(typedOverloaded.summary, 'The provider is busy right now.');
  for (const providerKind of ['policy', 'billing', 'quota_exhausted']) {
    const rejected = describeError({
      message: 'Anthropic OAuth API 429 request rejected',
      errorKind: { kind: providerKind, status: 429 },
    });
    assert.equal(rejected.providerKind, providerKind);
    assert.notEqual(rejected.kind, 'request', `${providerKind} must not read as a retryable rejection`);
  }
  assert.equal(
    describeError({
      message: 'Anthropic OAuth API 429 request rejected',
      errorKind: { kind: 'rate_limited', status: 429 },
    }).kind,
    'request'
  );
  // Legacy untyped wording still reads as sign-in expiry.
  assert.equal(describeError('refresh failed: invalid_grant').kind, 'reauth');
  assert.equal(describeError({ message: 'refresh failed: invalid_grant' }).kind, 'reauth');
});

test('a persisted descriptor presents exactly like the live error it came from', () => {
  const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: bad' } });
  const live = {
    overloaded: Object.assign(new Error('Overloaded'), { status: 529 }),
    rate_limited: Object.assign(new Error('slow down'), { status: 429, retryAfterMs: 90_000 }),
    rejected_429: anthropicQuotaError(429, {}, 'nope'),
    quota_exhausted: Object.assign(new Error('out'), { code: 'quota_exceeded', resetAt: Date.now() + 3_600_000 }),
    entitlement: Object.assign(new Error('no plan'), { code: 'usage_not_included' }),
    billing: Object.assign(new Error('pay'), { status: 402 }),
    auth: Object.assign(new Error('bad key'), { status: 401 }),
    permission: Object.assign(new Error('nope'), { status: 403 }),
    context_overflow: Object.assign(new Error('too long'), { code: 'context_length_exceeded' }),
    request_too_large: Object.assign(new Error('big'), { status: 413 }),
    policy: Object.assign(new Error('refused'), { code: 'content_policy_violation' }),
    invalid_request: Object.assign(new Error(`Anthropic OAuth API 400: ${body}`), { status: 400 }),
    transient_503: Object.assign(new Error('Anthropic OAuth API 503: upstream'), { status: 503 }),
    transient_errno: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    transient_text: new TypeError('fetch failed'),
    service_tier_unavailable: Object.assign(new Error('flex unavailable'), { status: 429, code: 'flex_unavailable' }),
    unknown: new Error('boom'),
  };
  for (const [name, err] of Object.entries(live)) {
    const persisted = { message: err.message, errorKind: providerErrorKind(err) };
    assert.deepEqual(describeError(persisted), describeError(err), name);
  }
  const tier = describeError(live.service_tier_unavailable);
  assert.equal(tier.kind, 'service-tier');
  assert.equal(tier.providerKind, 'service_tier_unavailable');
  assert.equal(tier.summary, 'The requested service tier is unavailable right now.');
  assert.equal(
    describeError({ message: 'invalid_grant', errorKind: { kind: 'service_tier_unavailable' } }).kind,
    'service-tier'
  );
  assert.equal(describeError({ message: 'x', errorKind: providerErrorKind(live.invalid_request) }).kind, 'request');
  assert.equal(describeError({ message: 'x', errorKind: providerErrorKind(live.transient_503) }).kind, 'connection');
});

test('legacy persisted quota string keeps its parsed wait in the notice', () => {
  const result = describeError('Anthropic OAuth API 429 quota/rate limit retryAfter=214641s');
  assert.notEqual(result.recovery, 'Try again shortly.');
  assert.equal(result.retryAfterMs, 214_641_000);
  assert.equal(result.recovery, 'Try again in 59h 38m.');
});

test('WebSocket disconnect notices wrap the summary and preserve the original diagnostic', () => {
  const raw = 'OpenAI OAuth WS closed before response.completed (code=1006)';
  for (const error of [Object.assign(new Error(raw), { wsCloseCode: 1006 }), raw]) {
    const result = describeError(error);
    assert.equal(result.kind, 'connection');
    assert.equal(result.summary, 'Connection to the provider was lost');
    assert.equal(result.recovery, 'Check the connection, then try again.');
    assert.equal(result.details, raw);
  }
});

test('both summaries and details redact credentials while retaining useful context', () => {
  const secret = 'test-password-123';
  const raw = `Failed at https://user:${secret}@example.test/path?token=abcdef&safe=1\nAuthorization: Bearer verysecret123\n{"api_key":"sk-123456789012345678901234","password":"${secret}"}\nhttps://example.test/?code=oauthcode`;
  const result = describeError(new Error(raw));
  for (const text of [result.summary, result.details, safeErrorDetails(raw), presentErrorText(new Error(raw))]) {
    assert.doesNotMatch(text, /test-password-123|verysecret123|abcdef|oauthcode|sk-1234567890/);
  }
  assert.match(result.details, /example\.test/);
  assert.match(result.details, /safe=1/);
});

test('diagnostic payloads and display summaries have bounded size', () => {
  const result = describeError(new Error(`Failure ${'x'.repeat(40_000)}`));
  assert.ok(result.summary.length <= 180);
  assert.ok(result.details.length <= 12_002);
  assert.doesNotMatch(safeErrorDetails(`{"data":"${'a'.repeat(1000)}"}`), /a{256}/);
});

test('runtime summaries retain their recovery classification after persistence', () => {
  for (const error of [providerFailure(1), Object.assign(new Error('large request'), { status: 413 })]) {
    const first = describeError(error);
    assert.equal(describeError(first.summary).kind, first.kind);
  }
});

test('dead OAuth grants are classified as reauth, transient failures are not', () => {
  const sample = 'token refresh 400: {"error": "invalid_grant", "error_description": "Refresh token expired"}';
  for (const input of [
    new Error(sample),
    sample,
    Object.assign(new Error('whatever'), { reauthRequired: true }),
    'Anthropic OAuth refresh token not available. Open /providers in mixdog to sign in again.',
  ]) {
    const result = describeError(input);
    assert.equal(result.kind, 'reauth');
    assert.equal(result.summary, 'Sign-in expired.');
    assert.equal(result.recovery, 'Sign in again from Providers.');
    assert.equal(result.fingerprint, 'reauth:');
  }
  assert.match(describeError(sample).details, /invalid_grant/);
  assert.equal(describeError(describeError(sample).summary).kind, 'reauth');
  for (const [text, status] of [
    ['forbidden', 403],
    ['too many requests', 429],
    ['fetch failed ECONNRESET', 0],
  ]) {
    assert.notEqual(describeError(Object.assign(new Error(text), { status })).kind, 'reauth');
  }
});

const failure = (message, fields = {}) => Object.assign(new Error(message), fields);

test('an unknown, retired or unoffered model names the model as the problem and the next step', () => {
  const anthropicBody = JSON.stringify({
    type: 'error',
    error: { type: 'not_found_error', message: 'model: claude-x' },
  });
  for (const error of [
    failure(`Anthropic API 404: ${anthropicBody}`, { status: 404, code: 'not_found_error' }),
    failure('The model `gpt-x` does not exist or you do not have access to it.', {
      status: 404,
      code: 'model_not_found',
    }),
    failure('models/gemini-9.5-pro is not found for API version v1beta', { status: 404, code: 'not_found' }),
    failure('The requested model is not supported.', { status: 400, code: 'model_not_supported' }),
    failure('acme/foo is not a valid model ID', { status: 400 }),
    failure('The model claude-2 has been deprecated', { status: 410 }),
    failure('model "llama9" not found, try pulling it first', { status: 404 }),
    failure('This model is not available in your region', { status: 403 }),
    'HTTP 404 Not Found: model not found',
  ]) {
    const result = describeError(error);
    assert.equal(result.kind, 'model-unavailable', String(error.message ?? error));
    assert.equal(result.summary, "This model isn't available for this account.");
    assert.match(result.recovery, /Choose another model/);
    assert.equal(presentErrorText(error), result.summary);
    // Persisted descriptor and persisted summary both keep the reading.
    if (typeof error === 'object') {
      assert.deepEqual(describeError({ message: error.message, errorKind: providerErrorKind(error) }), result);
    }
    assert.equal(describeError(result.summary).kind, 'model-unavailable');
  }
  // Typed kinds that are not request refusals never read as a missing model.
  for (const error of [
    failure('model overloaded, not available right now', { status: 529 }),
    failure('model gpt-x: rate limit, not available for 20s', { status: 429 }),
    failure('Invalid API key for model gpt-x is not supported', { status: 401 }),
  ]) {
    assert.notEqual(describeError(error).kind, 'model-unavailable', error.message);
  }
});

test('model wording counts only when the refusal is about the model itself', () => {
  for (const [message, status] of [
    ['For model gpt-4, tool lookup: route not found', 400],
    ["Tool 'model_search' not found", 400],
    ['File models/config.json not found while preparing the request', 400],
    ['Using model gpt-4: the requested route was not found', 400],
    ['The model selector tool is not available in this workspace; file not found', 400],
  ]) {
    assert.notEqual(describeError(failure(message, { status })).kind, 'model-unavailable', message);
  }
  // A 404 whose text only mentions a model elsewhere stays a not-found notice.
  const route = describeError(failure('For model gpt-4, tool lookup: route not found', { status: 404 }));
  assert.equal(route.kind, 'not-found');
  assert.equal(route.summary, 'For model gpt-4, tool lookup: route not found');
  assert.equal(describeError(failure('Not Found: /v1/chat/completionz', { status: 404 })).kind, 'not-found');
  // The typed codes and subject wordings still read as the model.
  const anthropicBody = JSON.stringify({
    type: 'error',
    error: { type: 'not_found_error', message: 'model: claude-x' },
  });
  for (const error of [
    failure('route not found', { status: 404, code: 'model_not_found' }),
    failure('Unknown model: gpt-x', { status: 400 }),
    failure('Error: model gpt-x is not available for your account', { status: 403 }),
    failure(
      "OpenAI OAuth HTTP fallback 400: The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
      { status: 400, code: 'invalid_request_error' }
    ),
    failure(
      'Publisher Model `projects/p/locations/us-central1/publishers/google/models/gemini-9-pro` was not found or your project does not have access to it.',
      { status: 404, code: 'not_found' }
    ),
    failure('Publisher Model `gemini-9-pro` was not found or your project does not have access to it.', {
      status: 400,
    }),
    failure('No endpoints found for anthropic/claude-x.', { status: 404 }),
    failure('The model gpt-x is currently unavailable.', { status: 400 }),
    failure(`Anthropic API 404: ${anthropicBody}`, { status: 404, code: 'not_found_error' }),
  ]) {
    assert.equal(describeError(error).kind, 'model-unavailable', error.message);
  }
});

test('a 404 without model wording keeps the provider words and points at the model and endpoint', () => {
  const result = describeError(failure('No endpoints found matching your data policy', { status: 404 }));
  assert.equal(result.kind, 'not-found');
  assert.equal(result.summary, 'No endpoints found matching your data policy');
  assert.match(result.recovery, /model and endpoint in Providers/);
  const bare = describeError(failure('<html><body>404</body></html>', { status: 404 }));
  assert.equal(bare.summary, "The provider couldn't find the requested model or endpoint.");
  assert.equal(describeError(bare.summary).kind, 'not-found');
});

test('a refused tool schema names the tool definition instead of a generic rejection', () => {
  for (const message of [
    "Invalid schema for function 'mcp__x__search': In context=(), 'additionalProperties' is required",
    'tools.3.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12',
    'Invalid JSON payload received. Unknown name "exclusiveMinimum" at \'tools[0].function_declarations[3].parameters.properties[1]\'',
  ]) {
    const error = failure(message, { status: 400, code: 'invalid_request_error' });
    const result = describeError(error);
    assert.equal(result.kind, 'tool-schema', message);
    assert.equal(result.summary, 'The provider rejected a tool definition.');
    assert.match(result.recovery, /MCP server named in the details/);
    assert.equal(presentErrorText(error), result.summary);
    assert.equal(describeError(result.summary).kind, 'tool-schema');
  }
  // An ordinary 400 keeps the generic rejection.
  assert.equal(describeError(failure('messages: bad', { status: 400 })).kind, 'request');
});
