#!/usr/bin/env node
// gemini-error-contract.test.mjs (24 tests; 29 rows with the loops): the real Google error contract (`geminiErrorContract`,
// `geminiPolicyFinishCode`, `geminiRestError`, `antigravityError`, `geminiIncompleteError`, `providerErrorKind`,
// `isAntigravityCapacityError`) over scripted error envelopes. Time is the virtual clock (resetAt = clock + retry), so it is recorded exactly.
//   node benchmarks/rust-core/recorders/record-gemini-error-contract.mjs --tree <exact export of b6f10295a>
import { T0, startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  pure: {
    'safety-recitation-finish-codes': 'mixdog-ai/src/providers/google/decode.rs:193 GeminiDecoder (pub; the policy finish codes are what `feed` returns for a SAFETY / RECITATION finishReason chunk)',
    '*': 'mixdog-ai/src/providers/google/error.rs:336 classify(&ErrorResponse, ErrorDialect) -> ProviderError (pub fn; `pub mod error` at providers/google/mod.rs:20), with `in_band` :386 for an in-body error chunk',
  },
  set: 'provider-gemini-error-contract',
  net: false,
  entry: 'gemini-error-contract.mjs geminiErrorContract / geminiPolicyFinishCode, gemini.mjs geminiRestError(res, bodyText, "Gemini"), antigravity-transport.mjs antigravityError(res, bodyText, endpoint), gemini-response.mjs geminiIncompleteError, provider-error-kind.mjs providerErrorKind, antigravity-retry-policy.mjs isAntigravityCapacityError, over scripted bodies. Not run: a network call.',
  compare: 'feed `input` (the error status and body, as `classify` receives them as an ErrorResponse) to the public classify / in_band and compare `result`/`error` whole (typed code, retry advice, scope, resetAt); resetAt is the recorded virtual clock (clockStartMs) plus the advice. The contract-field rows (geminiErrorContract over details arrays) are reached through a body carrying those details.',
  replay: "PURE (every case, see `levels`): mixdog-ai/src/providers/google/error.rs:336 `pub fn classify(response: &ErrorResponse, dialect: ErrorDialect) -> ProviderError` (status + body bytes in, typed error with retry advice, quota scope and reset out) and :386 `pub fn in_band`; the finish-reason case through the public GeminiDecoder (google/decode.rs:193). Retry classification: mixdog_ai::retry::classify::kind_of (retry/classify.rs:142).",
});
const P = 'agent/orchestrator/providers/';
const { geminiErrorContract, geminiPolicyFinishCode } = await rec.P(`${P}gemini-error-contract.mjs`);
const { geminiRestError } = await rec.P(`${P}gemini.mjs`);
const { antigravityError } = await rec.P(`${P}antigravity-transport.mjs`);
const { geminiIncompleteError } = await rec.P(`${P}gemini-response.mjs`);
const { providerErrorKind } = await rec.P(`${P}provider-error-kind.mjs`);
const { isAntigravityCapacityError } = await rec.P(`${P}antigravity-retry-policy.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/gemini-error-contract.test.mjs';

const T = 'type.googleapis.com/google.rpc.';
const retryInfo = (retryDelay) => ({ '@type': `${T}RetryInfo`, retryDelay });
const quotaFailure = (...quotaIds) => ({ '@type': `${T}QuotaFailure`, violations: quotaIds.map((quotaId) => ({ quotaId })) });
const errorInfo = (reason, metadata = {}) => ({ '@type': `${T}ErrorInfo`, reason, domain: 'googleapis.com', metadata });
const C = geminiErrorContract;
const rest = (status, error) => geminiRestError({ status, headers: new Headers() }, JSON.stringify({ error }), 'Gemini');
const agy = (status, error) => antigravityError({ status, headers: new Headers() }, JSON.stringify({ error }), 'endpoint');
const row = (id, line, input, fn) => rec.run(id, `${SRC}:${line}`, input, () => ({ clockStartMs: T0, ...fn() }));
// Contract fields in the order of the assertions; `resetAtMinusClock` makes the absolute resetAt readable.
const fields = (f) => ({ ...f, ...(f.resetAt !== undefined ? { resetAtMinusClock: f.resetAt - T0 } : {}) });

await row('reads-retryinfo-quotafailure-errorinfo', 18, {}, () => ({
  fields: fields(C({ details: [errorInfo('RATE_LIMIT_EXCEEDED'), quotaFailure('GenerateRequestsPerMinutePerProjectPerModel'), retryInfo('34.07s')], googleStatus: 'RESOURCE_EXHAUSTED' })),
}));
await row('errorDetails-status-fallback-uncapped', 33, {}, () => ({
  fields: fields(C({ errorDetails: [quotaFailure('GenerateRequestsPerDayPerProjectPerModel'), retryInfo({ seconds: '90000', nanos: 0 })], googleStatus: 'RESOURCE_EXHAUSTED' })),
}));
await row('no-scope-without-evidence', 44, {}, () => ({ fields: C({ details: [quotaFailure('SomeOtherQuota')], googleStatus: 'UNAVAILABLE' }) }));
await row('geminiRestError-details-mapping', 49, {}, () => {
  const res = { status: 429, headers: new Headers() };
  const err = geminiRestError(res, JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', errorDetails: [errorInfo('QUOTA_EXHAUSTED'), quotaFailure('GenerateRequestsPerDayPerProjectPerModel'), retryInfo('3600s')] } }), 'Gemini');
  return { error: err, headersIsTheResponsesOwn: err.headers === res.headers };
});
await row('geminiRestError-lowercases-status', 71, {}, () => ({ error: rest(503, { code: 503, status: 'UNAVAILABLE', message: 'busy' }) }));
await row('antigravityError-errorinfo-reset', 80, {}, () => ({
  error: agy(429, { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'exhausted', details: [errorInfo('QUOTA_EXHAUSTED', { quotaResetDelay: '373.803813ms', quotaResetTimeStamp: '2099-01-01T00:00:00Z', quotaId: 'RequestsPerDay' })] }),
  stampMs: Date.parse('2099-01-01T00:00:00Z'),
}));
for (const [name, body] of [
  ['errorinfo-reason', { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'x', details: [errorInfo('MODEL_CAPACITY_EXHAUSTED')] }],
  ['server-busy-message', { code: 503, status: 'UNAVAILABLE', message: 'The server is busy, try later' }],
  ['no-capacity-message', { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'No capacity available for model x' }],
]) await row(`antigravity-capacity:${name}`, 114, body, () => ({ error: agy(body.code, body) }));
await row('safety-recitation-finish-codes', 129, {}, () => {
  const parsed = (finishReason) => ({ candidate: { finishReason }, content: '', toolCalls: undefined });
  return {
    policy: Object.fromEntries(['SAFETY', 'FINISH_REASON_SAFETY', 'PROMPT_BLOCKLIST', 'RECITATION', 'MAX_TOKENS'].map((r) => [r, geminiPolicyFinishCode(r)])),
    incomplete: Object.fromEntries(['SAFETY', 'RECITATION', 'MAX_TOKENS'].map((r) => [r, geminiIncompleteError({}, parsed(r), 'm')])),
    blockReason: geminiIncompleteError({ promptFeedback: { blockReason: 'SAFETY' } }, { candidate: null }, 'm'),
  };
});
await row('per-minute-without-retryinfo-60s', 148, {}, () => ({
  byQuotaFailure: fields(C({ details: [quotaFailure('GenerateRequestsPerMinutePerProjectPerModel')], googleStatus: 'RESOURCE_EXHAUSTED' })),
  byMetadata: fields(C({ details: [errorInfo('RATE_LIMIT_EXCEEDED', { quota_limit: 'RequestsPerMinutePerProject' })] })),
  withRetryInfo: fields(C({ details: [quotaFailure('X'), retryInfo('5s')] })),
}));
await row('long-advice-never-quota', 153, {}, () => ({
  long: fields(C({ details: [retryInfo('601s')] })),
  threeHundred: fields(C({ details: [retryInfo('300s')] })),
  byMessage: fields(C({ message: 'Please retry in 400s' })),
}));
await row('zero-retryinfo-no-advice', 177, {}, () => {
  const err = rest(503, { code: 503, status: 'UNAVAILABLE', message: 'busy', details: [retryInfo('0s')] });
  return {
    zero: fields(C({ details: [retryInfo('0s')], googleStatus: 'UNAVAILABLE' })),
    zeroObject: fields(C({ details: [retryInfo({ seconds: '0', nanos: 0 })] })),
    zeroMessage: fields(C({ message: 'Please retry in 0s' })),
    perMinuteZero: fields(C({ details: [quotaFailure('GenerateRequestsPerMinutePerProjectPerModel'), retryInfo('0s')] })),
    zeroThenFive: fields(C({ details: [retryInfo('0s'), retryInfo('5s')] })),
    error: err,
    kind: providerErrorKind(err),
  };
});
await row('spent-quotas-no-window', 199, {}, () => {
  const qf = (violations) => ({ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations });
  return {
    quotaExhausted: fields(C({ details: [errorInfo('QUOTA_EXHAUSTED')] })),
    credits: fields(C({ details: [errorInfo('INSUFFICIENT_G1_CREDITS_BALANCE')] })),
    limitZero: fields(C({ details: [qf([{ quotaId: 'GenerateContentFreeTierRequests', description: 'Quota exceeded, limit: 0, model: x' }])] })),
    quotaValueZero: fields(C({ details: [qf([{ quotaValue: '0' }])] })),
    limitHalf: fields(C({ details: [qf([{ description: 'limit: 0.5 something' }])] })),
  };
});
await row('limit-zero-in-message-not-evidence', 213, {}, () => ({
  zero: fields(C({ message: 'Quota exceeded, limit: 0, model: x' })),
  half: fields(C({ message: 'limit: 0.5 something' })),
}));
await row('typed-reason-on-503-529-not-capacity', 238, {}, () => {
  const out = {};
  for (const status of [503, 529]) {
    const err = agy(status, { code: status, status: 'INVALID_ARGUMENT', message: 'bad request', details: [errorInfo('INVALID_ARGUMENT')] });
    out[status] = { error: err, isCapacity: isAntigravityCapacityError(err) };
  }
  out.plain503 = agy(503, { code: 503, status: 'UNAVAILABLE', message: 'busy' });
  return out;
});
await row('delay-read-from-message', 240, {}, () => ({
  decimal: fields(C({ message: 'Quota hit. Please retry in 2.5s.' })),
  millis: fields(C({ message: 'Please retry in 900ms' })),
  resetAfter: fields(C({ message: 'Your quota will reset after 2h1m1s' })),
  retryInfoWins: fields(C({ details: [retryInfo('4s')], message: 'Please retry in 9s' })),
}));
await row('compound-go-durations', 247, {}, () => {
  const meta = (quotaResetDelay) => fields(C({ details: [errorInfo('RATE_LIMIT_EXCEEDED', { quotaResetDelay })] }));
  return { compound: meta('1h16m0.667s'), bare: meta('30'), millis: meta('200ms') };
});
await row('capacity-overload-not-quota', 277, {}, () => ({
  byReason: fields(C({ details: [errorInfo('MODEL_CAPACITY_EXCEEDED'), retryInfo('900s')], googleStatus: 'RESOURCE_EXHAUSTED' })),
  byMessage: fields(C({ message: 'You have exhausted your capacity on this model.' })),
  quota: fields(C({ details: [errorInfo('QUOTA_EXHAUSTED')], message: 'You have exhausted your capacity on this model. Your quota will reset after 3h44m.' })),
  perMinuteCapacityWording: fields(C({ details: [quotaFailure('PerMinute')], message: 'capacity exceeded' })),
}));
for (const [name, status, body] of [
  ['503-capacity-by-status', 503, { code: 503, status: 'UNAVAILABLE', message: 'try later' }],
  ['529-capacity-by-status', 529, { code: 529, message: 'Overloaded' }],
  ['429-overloaded-wording', 429, { code: 429, message: 'The model is overloaded' }],
  ['429-per-minute-wording', 429, { code: 429, message: 'Too many requests per minute' }],
  ['429-quota-wording-alone', 429, { code: 429, message: 'You exceeded your current quota' }],
]) await row(`antigravityError:${name}`, 304, { status, body }, () => ({ error: agy(status, body) }));
await row('antigravity-typed-reason-outranks-wording', 311, {}, () => ({ error: agy(429, { code: 429, message: 'capacity exhausted', details: [errorInfo('RATE_LIMIT_EXCEEDED')] }) }));
await row('rejected-api-key-is-auth', 336, {}, () => {
  const out = {};
  for (const reason of ['API_KEY_INVALID', 'API_KEY_EXPIRED']) {
    const err = rest(400, { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [errorInfo(reason)] });
    out[reason] = { error: err, kind: providerErrorKind(err) };
  }
  const disabled = rest(403, { code: 403, message: 'API has not been used', status: 'PERMISSION_DENIED', details: [errorInfo('SERVICE_DISABLED')] });
  const invalid = rest(400, { code: 400, message: 'bad field', status: 'INVALID_ARGUMENT' });
  return { ...out, disabled: { error: disabled, kind: providerErrorKind(disabled) }, invalid: { error: invalid, kind: providerErrorKind(invalid) } };
});
await rec.finish({ clockStartMs: T0 });
