#!/usr/bin/env node
// Recording of shared/error-presentation.test.mjs (b6f10295a): Node's describeError / safeErrorDetails (shared/error-presentation.mjs),
// presentErrorText (shared/err-text.mjs), providerErrorKind and DETERMINISTIC_KINDS (providers/provider-error-kind.mjs) and
// anthropicQuotaError (anthropic-oauth-request/initial-status.mjs). Each test is one case; an input is recorded as data
// (E: an Error with fields, T: a TypeError, Q: anthropicQuotaError(status, headers, body), D: a plain {message, errorKind} object,
// S: a bare string) so a replay builds the same value, and for it: describeError whole, presentErrorText, safeErrorDetails and, for
// error objects, providerErrorKind and the persisted-descriptor describeError.
//
//   TZ=UTC node benchmarks/rust-core/recorders/record-error-presentation-cases.mjs --tree <export of b6f10295a with node_modules>
// The "resets at" wording reads the local time of the reset and compares its day with today's (new Date()): the recorder sets TZ=UTC itself and
// puts Date (new Date(), Date.now) on node:test's mock clock at the shared fixed instant, so neither the machine's zone nor the real date reaches
// the recording. No locale is read on these paths (no Intl, no toLocale*; toDateString is locale-independent).
process.env.TZ = 'UTC';
import { mock } from 'node:test';
import { RecorderError } from './lib/recorder-error.mjs';
import { openSet, FIXED_NOW } from './lib/case-set.mjs';

const set = openSet('error-presentation-cases', import.meta.url);
mock.timers.enable({ apis: ['Date'], now: FIXED_NOW });
const { describeError, safeErrorDetails } = await set.load('src/runtime/shared/error-presentation.mjs');
const { anthropicQuotaError } = await set.load('src/runtime/agent/orchestrator/providers/anthropic-oauth-request/initial-status.mjs');
const { presentErrorText } = await set.load('src/runtime/shared/err-text.mjs');
const { DETERMINISTIC_KINDS, providerErrorKind } = await set.load('src/runtime/agent/orchestrator/providers/provider-error-kind.mjs');

const E = (message, fields = {}) => ({ t: 'E', message, fields });
const T = (message, fields = {}) => ({ t: 'T', message, fields });
const Q = (status, headers, body) => ({ t: 'Q', status, headers, body });
const D = (message, errorKind) => ({ t: 'D', message, errorKind });
const S = (text) => ({ t: 'S', text });
const build = (spec) => {
  switch (spec.t) {
    case 'E': return Object.assign(new Error(spec.message), spec.fields);
    case 'T': return Object.assign(new TypeError(spec.message), spec.fields);
    case 'Q': return anthropicQuotaError(spec.status, new Map(spec.headers), spec.body);
    case 'D': return { message: spec.message, errorKind: spec.errorKind };
    case 'S': return spec.text;
    default: throw new RecorderError(`bad spec ${spec.t}`);
  }
};
const safe = (fn) => { try { return fn(); } catch (e) { return { threw: e }; } };
const errorObjectOf = (spec) => spec.t === 'E' || spec.t === 'T' || spec.t === 'Q';
/** Everything Node's modules answer for one input. */
function probe(spec) {
  const value = build(spec);
  const out = { input: spec, describe: safe(() => describeError(value)), present: safe(() => presentErrorText(value)), safeDetails: safe(() => safeErrorDetails(spec.t === 'S' ? spec.text : value)) };
  if (errorObjectOf(spec)) {
    out.builtError = value;
    out.providerErrorKind = safe(() => providerErrorKind(value));
    out.persistedDescribe = safe(() => describeError({ message: value.message, errorKind: providerErrorKind(value) }));
  }
  if (out.describe && typeof out.describe === 'object' && typeof out.describe.summary === 'string') {
    out.summaryReDescribe = safe(() => describeError(out.describe.summary));
  }
  return out;
}
const probes = (specs) => ({ probes: specs.map(probe) });

const providerFailure = (index) => E(`Anthropic OAuth API 400: ${JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `messages.11.content.${index}.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests` } })}`);

await set.run('prefixed provider JSON becomes a short actionable summary without discarding diagnostics', () => {
  const a = probe(providerFailure(54));
  const b = probe(providerFailure(62));
  return { first: a, second: b };
});
await set.run('typed failures distinguish sign-in, rate, request and connection recovery', () => ({
  ...probes([401, 429, 400, 413, 503].map((status) => E('upstream rejected the request', { status }))),
  fingerprintsOfOrdinaryFailures: [describeError(new Error('ordinary failure A')).fingerprint, describeError(new Error('ordinary failure B')).fingerprint],
}));
await set.run('an Anthropic 429 is a usage limit only when the quota headers say so', () => {
  const body = '{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}';
  const rejected = Q(429, [], body);
  const quota = Q(429, [['anthropic-ratelimit-unified-representative-claim', 'five_hour']], body);
  return { rejected: probe(rejected), rejectedMessageAsString: probe(S(build(rejected).message)), quota: probe(quota) };
});
await set.run('each provider kind gets its own message and next step; a persisted descriptor beats wording', () => {
  const kinds = ['overloaded', 'rate_limited', 'quota_exhausted', 'entitlement', 'billing', 'permission', 'context_overflow', 'request_too_large', 'policy'];
  return {
    ...probes(kinds.map((kind) => D('usage limit rate limit exceeded', { kind }))),
    bareKinds: ['overloaded', 'rate_limited', 'entitlement', 'billing', 'permission', 'policy'].map((kind) => probe(D('x', { kind }))),
    permissionBare: probe(D('x', { kind: 'permission' })),
  };
});
await set.run('typed codes classify errors; the wait and reset time are shown when known', () => {
  const resetAt = FIXED_NOW + 3_600_000;
  return {
    resetAt, tz: 'UTC',
    ...probes([
      E('Overloaded', { status: 529 }), E('slow down', { status: 429, code: 'rate_limit_exceeded', retryAfterMs: 90_000 }), D('out', { kind: 'quota_exhausted', resetAt }),
      D('x', { kind: 'quota_exhausted' }), E('forbidden', { status: 403 }), E('nope', { status: 400, code: 'cyber_policy' }), E('x', { code: 'context_length_exceeded', status: 400 }),
      D('x', { kind: 'billing' }), D('x', { kind: 'entitlement' }), S('The provider usage limit was reached.'), E('Anthropic OAuth API 429 quota/rate limit retryAfter=214641s'),
    ]),
  };
});
await set.run('a 403 keeps its account-permission reading: no model-proxy gate kind exists', () => ({
  forbidden: probe(E('forbidden', { status: 403 })),
  deterministicHasModelProxyPermission: DETERMINISTIC_KINDS.has('model_proxy_permission'), deterministicHasModelProxyWait: DETERMINISTIC_KINDS.has('model_proxy_wait'),
  deterministicKinds: [...DETERMINISTIC_KINDS],
}));
await set.run('a persisted kind beats auth wording in the text', () => probes([D('Overloaded: invalid API key echoed', { kind: 'overloaded' }), S('invalid API key')]));
await set.run('typed kinds skip every wording heuristic; wording only serves untyped items', () => probes([
  D('invalid_grant', { kind: 'overloaded' }),
  ...['policy', 'billing', 'quota_exhausted'].map((kind) => D('Anthropic OAuth API 429 request rejected', { kind, status: 429 })),
  D('Anthropic OAuth API 429 request rejected', { kind: 'rate_limited', status: 429 }), S('refresh failed: invalid_grant'), D('refresh failed: invalid_grant', undefined),
]));
await set.run('a persisted descriptor presents exactly like the live error it came from', () => {
  const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: bad' } });
  const live = {
    overloaded: E('Overloaded', { status: 529 }), rate_limited: E('slow down', { status: 429, retryAfterMs: 90_000 }), rejected_429: Q(429, [], 'nope'), quota_exhausted: E('out', { code: 'quota_exceeded', resetAt: FIXED_NOW + 3_600_000 }),
    entitlement: E('no plan', { code: 'usage_not_included' }), billing: E('pay', { status: 402 }), auth: E('bad key', { status: 401 }), permission: E('nope', { status: 403 }),
    context_overflow: E('too long', { code: 'context_length_exceeded' }), request_too_large: E('big', { status: 413 }), policy: E('refused', { code: 'content_policy_violation' }),
    invalid_request: E(`Anthropic OAuth API 400: ${body}`, { status: 400 }), transient_503: E('Anthropic OAuth API 503: upstream', { status: 503 }), transient_errno: E('read ECONNRESET', { code: 'ECONNRESET' }),
    transient_text: T('fetch failed'), service_tier_unavailable: E('flex unavailable', { status: 429, code: 'flex_unavailable' }), unknown: E('boom'),
  };
  return {
    named: Object.entries(live).map(([name, spec]) => ({ name, ...probe(spec) })),
    serviceTier: { descriptor: probe(D('invalid_grant', { kind: 'service_tier_unavailable' })) },
    invalidRequestPersisted: probe(D('x', providerErrorKind(build(live.invalid_request)))), transient503Persisted: probe(D('x', providerErrorKind(build(live.transient_503)))),
  };
});
await set.run('legacy persisted quota string keeps its parsed wait in the notice', () => probes([S('Anthropic OAuth API 429 quota/rate limit retryAfter=214641s')]));
await set.run('WebSocket disconnect notices wrap the summary and preserve the original diagnostic', () => {
  const raw = 'OpenAI OAuth WS closed before response.completed (code=1006)';
  return probes([E(raw, { wsCloseCode: 1006 }), S(raw)]);
});
await set.run('both summaries and details redact credentials while retaining useful context', () => {
  const secret = 'test-password-123';
  const raw = `Failed at https://user:${secret}@example.test/path?token=abcdef&safe=1\nAuthorization: Bearer verysecret123\n{"api_key":"sk-DUMMY-123456789012345678901234","password":"${secret}"}\nhttps://example.test/?code=oauthcode`;
  const result = probe(E(raw));
  const texts = [result.describe.summary, result.describe.details, safeErrorDetails(raw), presentErrorText(new Error(raw))];
  return { raw, result, texts, safeDetailsOfString: safeErrorDetails(raw), presentErrorText: presentErrorText(new Error(raw)), normalised: 'the api_key value carries the sk-DUMMY- marker (the fixture secret scan refuses the original sk-123… shape); the redactor treats both alike' };
});
await set.run('diagnostic payloads and display summaries have bounded size', () => {
  const result = describeError(new Error(`Failure ${'x'.repeat(40_000)}`));
  const safeData = safeErrorDetails(`{"data":"${'a'.repeat(1000)}"}`);
  return { input: 'Failure + 40000 x', result, safeDataOfLongJson: safeData };
});
await set.run('runtime summaries retain their recovery classification after persistence', () => ({
  entries: [providerFailure(1), E('large request', { status: 413 })].map(probe),
}));
await set.run('dead OAuth grants are classified as reauth, transient failures are not', () => {
  const sample = 'token refresh 400: {"error": "invalid_grant", "error_description": "Refresh token expired"}';
  return {
    reauth: [E(sample), S(sample), E('whatever', { reauthRequired: true }), S('Anthropic OAuth refresh token not available. Open /providers in mixdog to sign in again.')].map(probe),
    notReauth: [['forbidden', 403], ['too many requests', 429], ['fetch failed ECONNRESET', 0]].map(([text, status]) => probe(E(text, { status }))),
  };
});
await set.run('an unknown, retired or unoffered model names the model as the problem and the next step', () => {
  const anthropicBody = JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } });
  return {
    unavailable: [
      E(`Anthropic API 404: ${anthropicBody}`, { status: 404, code: 'not_found_error' }), E('The model `gpt-x` does not exist or you do not have access to it.', { status: 404, code: 'model_not_found' }),
      E('models/gemini-9.5-pro is not found for API version v1beta', { status: 404, code: 'not_found' }), E('The requested model is not supported.', { status: 400, code: 'model_not_supported' }),
      E('acme/foo is not a valid model ID', { status: 400 }), E('The model claude-2 has been deprecated', { status: 410 }), E('model "llama9" not found, try pulling it first', { status: 404 }),
      E('This model is not available in your region', { status: 403 }), S('HTTP 404 Not Found: model not found'),
    ].map(probe),
    notUnavailable: [E('model overloaded, not available right now', { status: 529 }), E('model gpt-x: rate limit, not available for 20s', { status: 429 }), E('Invalid API key for model gpt-x is not supported', { status: 401 })].map(probe),
  };
});
await set.run('model wording counts only when the refusal is about the model itself', () => {
  const anthropicBody = JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } });
  return {
    notAboutModel: [['For model gpt-4, tool lookup: route not found', 400], ["Tool 'model_search' not found", 400], ['File models/config.json not found while preparing the request', 400], ['Using model gpt-4: the requested route was not found', 400], ['The model selector tool is not available in this workspace; file not found', 400]].map(([m, status]) => probe(E(m, { status }))),
    notFound: [E('For model gpt-4, tool lookup: route not found', { status: 404 }), E('Not Found: /v1/chat/completionz', { status: 404 })].map(probe),
    aboutModel: [
      E('route not found', { status: 404, code: 'model_not_found' }), E('Unknown model: gpt-x', { status: 400 }), E('Error: model gpt-x is not available for your account', { status: 403 }),
      E("OpenAI OAuth HTTP fallback 400: The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.", { status: 400, code: 'invalid_request_error' }),
      E('Publisher Model `projects/p/locations/us-central1/publishers/google/models/gemini-9-pro` was not found or your project does not have access to it.', { status: 404, code: 'not_found' }),
      E('Publisher Model `gemini-9-pro` was not found or your project does not have access to it.', { status: 400 }), E('No endpoints found for anthropic/claude-x.', { status: 404 }),
      E('The model gpt-x is currently unavailable.', { status: 400 }), E(`Anthropic API 404: ${anthropicBody}`, { status: 404, code: 'not_found_error' }),
    ].map(probe),
  };
});
await set.run('a 404 without model wording keeps the provider words and points at the model and endpoint', () => ({
  policy: probe(E('No endpoints found matching your data policy', { status: 404 })), bare: probe(E('<html><body>404</body></html>', { status: 404 })),
}));
// The libuv errno name each socket failure carries as `error.code`: the code decides the sentence (lost, timeout, unreachable) and the persisted kind.
await set.run('each socket failure keeps the errno name its error carries', () => probes([
  E('read ECONNRESET', { code: 'ECONNRESET' }), E('write EPIPE', { code: 'EPIPE' }),
  E('connect ETIMEDOUT 203.0.113.7:443', { code: 'ETIMEDOUT' }), E('connect ECONNREFUSED 127.0.0.1:443', { code: 'ECONNREFUSED' }),
]));
await set.run('a refused tool schema names the tool definition instead of a generic rejection', () => ({
  schema: [
    "Invalid schema for function 'mcp__x__search': In context=(), 'additionalProperties' is required",
    'tools.3.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12',
    'Invalid JSON payload received. Unknown name "exclusiveMinimum" at \'tools[0].function_declarations[3].parameters.properties[1]\'',
  ].map((message) => probe(E(message, { status: 400, code: 'invalid_request_error' }))),
  ordinary400: probe(E('messages: bad', { status: 400 })),
}));

await set.finish({
  entry: { runs: 'describeError, safeErrorDetails (shared/error-presentation.mjs), presentErrorText (shared/err-text.mjs), providerErrorKind / DETERMINISTIC_KINDS (providers/provider-error-kind.mjs), anthropicQuotaError (anthropic-oauth-request/initial-status.mjs)', notRun: 'no provider is called: every input is a constructed error, descriptor or string' },
  replay: { entry: 'mixdog-ai service/error_text.rs (and the provider error-kind classifier): build each input from its spec (E/T/Q/D/S as defined in the recorder header) and compare describe whole, present, safeDetails, providerErrorKind and persistedDescribe',
    // What the Rust replay (mixdog-ai/src/service/error_presentation_replay_tests.rs) leaves out of the comparison, each with its reason.
    declaredExclusions: [
      { probeKeys: ['describe', 'persistedDescribe', 'summaryReDescribe', 'builtError'], reason: "the renderer's reading of a persisted item (ErrorNotice.tsx, desktop-toast-state.ts, RendererRecovery.tsx import the shared JS module) and Node's Error built from the spec: replayed whole against that code by apps/desktop/src/renderer/error-presentation-replay.test.mjs, not by the core, which answers presentErrorText, safeErrorDetails and the persisted errorKind" },
      { probes: 'every input with t "D" (a persisted descriptor object)', reason: 'presenting a stored errorKind again is the renderer\'s reading of a persisted item, replayed by apps/desktop/src/renderer/error-presentation-replay.test.mjs; the core presents a failure once, when it is recorded (mixdog-core-session/src/session/failure_record.rs failure_record), and the descriptor it stores is compared through providerErrorKind of the E/T/Q probes' },
      { case: 'diagnostic payloads and display summaries have bounded size / both summaries and details redact credentials', keys: ['result', 'texts'], reason: "describeError's notice and its four shown strings are the renderer's, replayed by the desktop test; safeDataOfLongJson, safeDetailsOfString and presentErrorText are replayed in Rust" },
      { probes: 'the four E probes of "each socket failure keeps the errno name its error carries" and the E probe with code ECONNRESET', reason: 'the message is libuv\'s errno wording, which the core has no typed source for; it stays an input of the replay, the code and kind come from the typed fault (TransportFault::errno_name: Reset is ECONNRESET, an I/O or connect failure with an OS error is the name of that error: EPIPE, ETIMEDOUT, ECONNREFUSED), so each recorded sentence, persisted code and kind are the core\'s' },
      { case: 'typed codes classify errors; the wait and reset time are shown when known', keys: ['tz'], reason: "the recording's time zone, an input (manifest inputs.timeZone)" },
    ],
    inputs: { clock: 'the current time (new Date(), Date.now) is the fixed instant 1800000000000 = 2027-01-15T08:00:00.000Z for the whole run; a replay must give the code under test this instant', timeZone: 'UTC: the reset wording ("09:00", "1/15 09:00") is the local time of resetAt, and the month/day prefix appears when its local day differs from the current local day; a replay must run with this zone', locale: 'not read: no Intl or toLocale* on these paths; toDateString is locale-independent' }, normalised: { socketErrors: "Node's errno text is the core's typed TransportFault: an E probe with code ECONNRESET is fault_from_io(ConnectionReset, after connect); EPIPE, ETIMEDOUT and ECONNREFUSED are an I/O or connect fault carrying the OS error of that name (taken from the platform's own error numbers); the T probe (undici `TypeError: fetch failed`, which hides the errno) is fault_from_io(ConnectionRefused, connecting) with no OS error (mixdog-ai/src/transport/fault.rs); kind_of reads the fault, never the code text", timeZone: 'recorded with TZ=UTC (the reset wording is local time); resetAt = the fixed clock + 1 h', secretShapedInput: 'sk-DUMMY- marker in the redaction case (the fixture secret scan refuses the original shape)' } },
});
process.exit(0);
