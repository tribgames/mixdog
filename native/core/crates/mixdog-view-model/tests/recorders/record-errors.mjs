// Records the Node golden for the Rust error presentation (mixdog-view-model: errors/*). Every exported function of
//   err-text, error-presentation, provider-error-kind, transport-error-text and provider-timeout-phase
// runs over a corpus of failures as Node holds them (provider HTTP errors of every family with their bodies, network
// errors by code and cause chain, timeouts by phase, quota / auth / billing refusals, cancellations, persisted rows,
// plain values) and the outputs are written beside the inputs; tests/errors_twin.rs replays the file in Rust.
//
//   node tests/recorders/record-errors.mjs [--tree <repo>] [--out <file>]
//   node tests/recorders/record-errors.mjs [--tree <repo>] --check <file>
//
// --tree is the Node product's tree (default: the repository this file sits in). Each module is read from the first of
// <tree>/src/runtime/shared, <tree>/src/runtime/agent/orchestrator/providers and <tree>/packages/protocol-client/src/rows
// that holds it (the last holds the Node copies the TUI and the desktop import).
//
// The clock and the zone are pinned (NOW, UTC): the recording is the same on every machine and day. An `Error` instance
// is recorded as an object carrying "$isError": true (what the Rust reader tells an Error by); an input that is the
// JavaScript value `undefined` is recorded without an "error" member and `"undef": true`.
process.env.TZ = 'UTC';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const tree = resolve(flag('--tree') ?? join(here, '..', '..', '..', '..', '..', '..'));
const checkPath = flag('--check');
const outPath = resolve(flag('--out') ?? join(here, '..', 'goldens', 'errors.json'));

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(NOW);
    else super(...args);
  }
  static now() {
    return NOW;
  }
};

async function load(file) {
  for (const dir of ['src/runtime/shared', 'src/runtime/agent/orchestrator/providers', 'packages/protocol-client/src/rows']) {
    const path = join(tree, dir, file);
    if (existsSync(path)) return import(pathToFileURL(path).href);
  }
  throw new Error(`${file} is in none of the module directories of ${tree}`);
}
const errText = await load('err-text.mjs');
const presentation = await load('error-presentation.mjs');
const kindModule = await load('provider-error-kind.mjs');
const transport = await load('transport-error-text.mjs');
const phase = await load('provider-timeout-phase.mjs');

// ── Serialization ───────────────────────────────────────────────────────────

function plain(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('a non-finite number is not in the corpus');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => plain(item) ?? null);
  const out = {};
  if (value instanceof Error) {
    out.$isError = true;
    out.name = value.name;
    out.message = value.message;
    if (value.cause !== undefined) out.cause = plain(value.cause);
  }
  for (const key of Object.keys(value)) {
    const inner = plain(value[key]);
    if (inner !== undefined) out[key] = inner;
  }
  return out;
}

function E(message, props = {}, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  return Object.assign(error, props);
}
const named = (name, message, props = {}, cause) => E(message, { name, ...props }, cause);
const guard = (run) => {
  try {
    return { value: run() };
  } catch (error) {
    return { threw: String(error?.message ?? error) };
  }
};
const unwrapped = (result) => ('value' in result ? { value: result.value === undefined ? null : result.value } : result);

// ── Corpus ──────────────────────────────────────────────────────────────────

// Message texts: provider wordings, watchdogs, session notices, wrapper prefixes, persisted summaries.
const TEXTS = [
  '',
  ' ',
  'boom',
  'Error: boom',
  '[Error] boom',
  '[agent error]: boom',
  'error - boom',
  'Failure: disk full',
  'first line\nerror: embedded failure\nlast line',
  'failed = could not open the file',
  'Unknown error',
  'Something went wrong.',
  'The provider usage limit was reached.',
  'The provider is temporarily rate-limiting requests.',
  'Provider authentication failed',
  "The provider couldn't find the requested model or endpoint.",
  "This model isn't available for this account.",
  'The provider rejected a tool definition.',
  'The provider rejected this request.',
  'An attached image exceeds the provider limit.',
  'The request exceeds the size limit.',
  'API 429: {"error":{"message":"Rate limit reached for requests","type":"rate_limit_error"}}',
  'API 429 request rejected',
  'API 429 request rejected: {"error":{"message":"nope"}}',
  'API 401: {"error":{"message":"Incorrect API key provided: sk-abcdefghijklmnopqrstuvwx","type":"invalid_request_error","code":"invalid_api_key"}}',
  'API 402: {"error":{"message":"Insufficient credits","code":402}}',
  'API 403: {"error":{"type":"permission_error","message":"Your organization does not have access"}}',
  'API 404: {"error":{"message":"The model `gpt-9` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}',
  'API 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
  'API 400: {"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.","code":"context_length_exceeded"}}',
  'API 413: {"error":{"message":"Request payload size exceeds the limit: 10485760 bytes."}}',
  'API 400: {"error":{"message":"Invalid schema for function \'tool_a\': array schema missing items"}}',
  'API 400: {"error":{"message":"tools.3.custom.input_schema: JSON schema is invalid"}}',
  'API 400: {"error":{"message":"image dimensions exceed max allowed size: 8000 pixels"}}',
  'API 400: {"error":{"message":"Too many images in request: many-image requests are limited to 2000px"}}',
  'API 500: {"error":{"message":"The server had an error while processing your request"}}',
  'API 502 Bad Gateway',
  'API 503: <html><body>Service Unavailable</body></html>',
  'HTTP 504 Gateway Timeout',
  'HTTP fallback 521 web server is down',
  'API 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  'Our servers are currently at capacity due to high demand',
  'The server is overloaded, try again later',
  'You exceeded your current quota, please check your plan and billing details.',
  'Quota exceeded for quota metric',
  'quota exceeded retryAfter=45s',
  'rate limit hit retryAfter=2m',
  'rate limit hit retryAfter=3600s',
  'rate limit hit retryAfter=90000ms',
  'rate limit hit retryAfter=abc',
  'You have hit your usage limit. retryAfter=1m',
  '429 Too Many Requests',
  'Resource exhausted (e.g. check quota).',
  'Anthropic OAuth account is in cooldown (429); retryAfter=30s',
  'account cooldown: rate limit, retryAfter=10m',
  'Rate limit reached for gpt-5 in organization org-abc on tokens per min',
  'insufficient_quota',
  'quota_exceeded',
  'usage_limit_reached',
  'invalid_grant: refresh token expired',
  'refresh token revoked, sign in again',
  'Reauth Required',
  'sign-in expired',
  'invalid api key provided',
  'expired access token',
  'invalid credentials',
  'Provider authentication failed.',
  'Unauthorized',
  'fetch failed',
  'Failed to fetch',
  'terminated',
  'socket hang up',
  'other side closed',
  'connection error.',
  'Connection reset by peer',
  'connect ETIMEDOUT 10.0.0.1:443',
  'connect timeout error',
  'getaddrinfo ENOTFOUND api.example.com',
  'network error',
  'load failed',
  "couldn't fetch",
  'OpenAI WS closed before response.completed (code=1006, reason=)',
  'Error: xAI WS handshake closed before open (code=1011)',
  'OpenAI OAuth WS closed before response.completed (code=1008, reason=policy)',
  'shell job terminated by signal 9',
  'Session terminated',
  'first byte timed out after 90000ms',
  'provider timed out after 120000ms',
  'stream timed out after 45000ms of inactivity',
  'stream timed out after 300000ms of inactivity',
  'timed out after 800ms of inactivity',
  'first response stale (120000ms)',
  'agent first response stale (30000ms)',
  'first transport stale (60000ms)',
  'first semantic response stale (5000ms)',
  'agent task stale (600000ms, no events)',
  'agent tool running stale (900000ms)',
  'tool running stale (45000ms)',
  'task stale (3600000ms)',
  'Session "sess_abc123" closed: aborted during call',
  'Session "sess_abc123" closed: closed during call',
  'Session "sess_abc123" closed: something else happened in run_0123456789abcdef0123',
  'Session closed: closeSession',
  'Session closed: aborted',
  'parent signal aborted',
  'aborted by session close',
  'withRetry: aborted',
  'withRetry: sleep aborted',
  'sleep aborted',
  'The operation was aborted',
  'AGENT_CONTEXT_OVERFLOW',
  'agent context overflow: budget exceeded',
  'latest turn cannot fit',
  'exceeds the context window of this model',
  'context budget exhausted',
  'compaction failed: provider returned nothing',
  'agent compact failed (agent): The latest message cannot fit this model (LATEST_TURN_EXCEEDS_CONTEXT): it needs about 52,000 tokens, but the 32,000 window leaves 20,000 for it. Shorten the message or switch to a larger model.',
  'The latest message cannot fit this model (LATEST_TURN_EXCEEDS_CONTEXT): it needs about 9,000 tokens, but the 8,000 window leaves 7,000 for it.',
  'Request needs about 80,000 tokens of fixed overhead (TOOL_SURFACE_EXCEEDS_CONTEXT)\n  tools: 60,000\n  system: 20,000\nDisable tools to continue.',
  'Error: wrapper (TOOL_SURFACE_EXCEEDS_CONTEXT) context_length_exceeded',
  'PROVIDER_PREFIX_MUTATION',
  '{"error":"disk full"}',
  '{"error":{"message":"nested message","code":"x"}}',
  '{"message":"top message"}',
  '{"error":{"code":"quota"}}',
  '{"nothing":"here"}',
  '{"error":""}',
  '[1,2,3]',
  '{not json',
  'prefix {"error":{"message":"after prefix","type":"invalid_request_error"}}',
  'Error invoking remote method \'agent:send\': Error: remote failure',
  'Error invoking remote method \'agent:send\': rate limit exceeded',
  'The model `claude-x` does not exist',
  'models/gemini-9 is not found for API version v1beta',
  'Publisher Model `projects/p/locations/l/publishers/google/models/m` was not found',
  'model "llama9" not found, try pulling it first',
  "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.",
  'Unknown model: foo-1',
  'No endpoints found for anthropic/claude-9',
  'foo is not a valid model ID',
  'model: claude-opus-9',
  'For model x, tool lookup: route not found',
  '404 not found',
  'tools[2].function.parameters: invalid',
  'function_declarations[0].parameters schema rejected',
  'invalid tool schema',
  'payload too large',
  'request body too large',
  'Request entity too large',
  'maximum prompt length is 131072',
  'input token count 90000 exceeds the maximum number of tokens allowed 65536',
  'Prompt exceeds max length',
  'reduce the length of the messages',
  'content_filter triggered',
  'x'.repeat(400),
  `${'word '.repeat(60)}end`,
  'multi\nline\n\ntext   with   gaps',
  'https://user:secret@example.com/path?token=abc123&ok=1',
  'Authorization: Bearer abcdef.ghijkl-mnop',
  'api_key=sk-abcdefghijklmnop1234 and password: "hunter2"',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  '\u001b[31mred\u001b[0m text',
  'unicode: café ☃ 🚀 done',
];

const HTTP_STATUSES = [400, 401, 402, 403, 404, 408, 409, 410, 413, 422, 425, 429, 500, 502, 503, 504, 521, 525, 526, 529];

// Provider families: the body each puts on a failure, and where the fields sit on the thrown error.
const BODIES = {
  anthropic: (status) => ({
    type: 'error',
    error: { type: status === 429 ? 'rate_limit_error' : status === 529 ? 'overloaded_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status >= 500 ? 'api_error' : 'invalid_request_error', message: `anthropic ${status}` },
  }),
  openai: (status) => ({
    error: { message: `openai ${status}`, type: status === 429 ? 'rate_limit_exceeded' : status === 401 ? 'invalid_request_error' : 'server_error', code: status === 429 ? 'rate_limit_exceeded' : status === 401 ? 'invalid_api_key' : null },
  }),
  google: (status) => ({
    error: { code: status, message: `google ${status}`, status: status === 429 ? 'RESOURCE_EXHAUSTED' : status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'PERMISSION_DENIED' : status === 404 ? 'NOT_FOUND' : status === 503 ? 'UNAVAILABLE' : status === 400 ? 'INVALID_ARGUMENT' : 'INTERNAL', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }] },
  }),
  openrouter: (status) => ({
    error: { code: status, message: `openrouter ${status}`, metadata: { error_type: status === 429 ? 'rate_limit_exceeded' : status === 402 ? 'payment_required' : status === 401 ? 'authentication' : status >= 500 ? 'server' : 'invalid_request', provider_name: 'x' } },
  }),
  xai: (status) => ({ code: status === 429 ? 'rate_limit_exceeded' : 'error', error: `xai ${status}` }),
  bare: (status) => ({ message: `bare ${status}` }),
};

function httpError(family, status, extra = {}) {
  const body = BODIES[family](status);
  return E(`API ${status}: ${JSON.stringify(body)}`, { status, ...extra, ...(family === 'anthropic' ? { error: body } : {}), ...(family === 'google' ? { error: body.error } : {}) });
}

const NETWORK_CODES = [
  'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ENETRESET', 'EPROTO', 'UND_ERR_SOCKET', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
  'UND_ERR_ABORTED', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_HTTP2_STREAM_ERROR', 'ERR_HTTP2_GOAWAY_SESSION',
  'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_BAD_RECORD_MAC', 'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
  'EPROVIDERTIMEOUT', 'EGEMINITIMEOUT', 'ESTREAMSTALL', 'EWSACQUIRETIMEOUT', 'enotfound', 'ECONNRESET ', 'ENOENT', '',
];

const cases = [];
const add = (error, id) => cases.push({ id, error });
const addUndefined = (id) => cases.push({ id, undef: true });

// Plain values.
for (const value of [null, 0, 1, 5, 1.5, -3, true, false, '', 'text', [], [1, 2], ['a'], {}, { a: 1 }, { message: '' }, { message: 5 }, { message: 'plain object message' }, { error: 'string error member' }, { error: { message: 'nested object error' } }, { error: { error: { reason: 'deep reason' } } }, { reason: 'reason member' }, { reason: { message: 'reason object' } }, { type: 'close' }, { type: '' }, { type: 5, code: 'x' }, { detail: 'detail text' }, { detail: 'detail text', message: 'with message' }, { code: 'E1' }, { status: 429 }, { status: '429' }, { status: 'abc' }, { httpStatus: 503 }, { response: { status: 502 } }, { cancelled: true }, { name: 'AbortError' }, { name: 'SessionClosedError', message: 'x' }, { name: 'APIUserAbortError' }]) {
  add(value, 'value');
}
addUndefined('undefined');
// Bare strings, and each text under every shape an error reaches a surface in.
for (const text of TEXTS) {
  add(text, 'string');
  add(E(text), 'error');
  add({ message: text }, 'object');
  add({ message: text, status: 429 }, 'object-429');
  add({ message: text, code: 'some_code' }, 'object-code');
  add({ message: text, name: 'ProviderTimeoutError' }, 'named-timeout');
}
// Provider families on every status.
for (const family of Object.keys(BODIES)) {
  for (const status of HTTP_STATUSES) {
    add(httpError(family, status), `${family}-${status}`);
    add(httpError(family, status, { headers: { 'retry-after': '12' } }), `${family}-${status}-retry-after`);
    add(httpError(family, status, { headers: { 'Retry-After-Ms': '1500' } }), `${family}-${status}-retry-after-ms`);
    add(httpError(family, status, { retryAfterMs: 20_000, resetAt: NOW + 7_200_000 }), `${family}-${status}-stamped`);
  }
}
// Stamped boundary facts.
const STAMPS = [
  { status: 429, quotaScope: 'minute', message: 'limit' },
  { status: 429, quotaScope: 'day', message: 'limit', resetAt: NOW + 3_600_000 },
  { status: 429, quotaScope: 'plan', message: 'limit', resetAt: NOW + 5 * 86_400_000 },
  { status: 429, quotaScope: 'DAY', message: 'limit', resetAt: NOW - 1000 },
  { status: 429, quotaScope: 'week', message: 'limit' },
  { status: 429, code: 'resource_exhausted' },
  { status: 429, code: 'RESOURCE_EXHAUSTED', quotaScope: 'day' },
  { status: 429, providerQuota: true, message: 'flagged' },
  { status: 429, quotaExceeded: true, message: 'flagged', retryAfterMs: 5000 },
  { status: 529, providerQuota: true },
  { code: 'insufficient_quota', providerQuota: true },
  { quotaExhausted: { resetAt: NOW + 1_800_000 }, message: 'pool' },
  { quotaExhausted: { resetAt: NOW - 5 }, message: 'pool' },
  { quotaExhausted: true },
  { reauthRequired: true, message: 'login again' },
  { reauthRequired: true, status: 500 },
  { reauthRequired: false, message: 'invalid_grant' },
  { status: 402, message: 'x', headers: { 'retry-after': '30' }, code: 'openrouter_in_flight_budget' },
  { status: 402, message: 'x', headers: { 'retry-after': '0' }, error: { code: 'openrouter_in_flight_budget' } },
  { status: 402, message: 'x', headers: { 'retry-after': '120' }, code: 'openrouter_in_flight_budget' },
  { status: 402, message: 'x', code: 'openrouter_in_flight_budget' },
  { status: 402, code: 'server_error' },
  { retryAfterMs: 0, status: 429 },
  { retryAfterMs: -5, status: 429 },
  { retryAfterMs: '2500', status: 429 },
  { retryAfterAt: NOW + 4500, status: 429 },
  { retryAfterAt: NOW - 4500, status: 429 },
  { headers: { 'retry-after': new RealDate(NOW + 90_000).toUTCString() }, status: 429 },
  { headers: { 'retry-after': new RealDate(NOW - 90_000).toUTCString() }, status: 429 },
  { headers: { 'retry-after': 'soon' }, status: 429 },
  { headers: { 'retry-after': ['7', '8'] }, status: 429 },
  { headers: { 'retry-after': '' }, status: 429 },
  { headers: { 'RETRY-AFTER': 3 }, status: 429 },
  { response: { status: 429, headers: { 'retry-after': '9' } } },
  { data: { responseHeaders: { 'retry-after': '4' } }, status: 429 },
  { error: { headers: { 'retry-after': '6' }, code: 'rate_limit_exceeded' } },
  { providerError: { headers: { 'retry-after-ms': 800 }, code: 'rate_limited' } },
  { payload: { error: { headers: { 'retry-after': '11' }, code: 'rate_limit_exceeded' } } },
  { details: [{ '@type': 'RetryInfo', retryDelay: '2.5s' }], status: 429 },
  { details: [{ retryDelay: { seconds: 3, nanos: 500_000_000 } }], status: 429 },
  { details: [{ retryDelay: { seconds: '4' } }, { retryDelay: '9s' }], status: 429 },
  { details: [{ retryDelay: 'soon' }, { retryDelay: '1s' }], status: 429 },
  { details: 'not an array', status: 429 },
  { error: { details: [{ retryDelay: '8s' }] }, status: 429 },
  { errorDetails: [{ retryDelay: '5s' }], status: 429 },
  { code: 'rate_limit_exceeded', message: 'Please try again in 20ms.' },
  { code: 'rate_limit_exceeded', message: 'Please try again in 1.5 seconds' },
  { code: 'slow_down', message: 'retry after 2 minutes' },
  { code: 'rate_limit_exceeded', message: 'wait for 3 mins' },
  { code: 'rate_limit_exceeded', message: 'try again in 0 seconds' },
  { code: 'invalid_request', message: 'Please try again in 5 seconds' },
  { message: 'Please try again in 5 seconds' },
  { status: 429, message: 'The model is at capacity right now' },
  { status: 429, message: 'overloaded', code: 'rate_limited' },
  { status: 500, message: 'Our servers are at capacity' },
  { message: 'prompt is too long' },
  { status: 400, message: 'prompt is too long' },
  { status: 400, message: 'Request payload size exceeds the limit' },
  { status: 413 },
  { status: 400, code: 'invalid_request' },
  { status: 400, code: 'context_length_exceeded', message: 'x' },
  { code: 'cyber_policy', status: 400 },
  { code: 'usage_not_included' },
  { code: 'billing_hard_limit_reached' },
  { code: 'flex_unavailable', status: 503 },
  { code: 'unsupported_parameter', message: 'x', status: 400 },
  { code: 'model_not_found', status: 404, message: 'x' },
  { code: 'model_not_supported', status: 400 },
  { code: 'malformed_stream' },
  { code: 'previous_response_not_found', status: 400 },
  { providerErrorCode: 'Content_Policy_Violation' },
  { geminiStatus: 'UNAVAILABLE' },
  { geminiStatus: 'RESOURCE_EXHAUSTED', quotaScope: 'plan' },
  { error: { type: 'overloaded_error' } },
  { error: { status: 'INVALID_ARGUMENT', code: 'api_key_invalid' }, status: 400 },
  { error: { error: { type: 'permission_error' } } },
  { payload: { error: { type: 'authentication_error' } } },
  { payload: { code: 'timeout' } },
  { error_type: 'rate_limit_exceeded', code: 'server_error', status: 500 },
  { error_type: 'authentication', status: 500 },
  { error_type: 'image_too_large' },
  { error_type: ' Provider_Overloaded ' },
  { error_type: 'nonsense', code: 'rate_limited' },
  { error: { error_type: 'timeout' } },
  { error: { metadata: { error_type: 'payload_too_large' } } },
  { error: { error: { error_type: 'refusal' } } },
  { responseFailed: { response: { error: { code: 'rate_limit_exceeded', message: 'wire' } } } },
  { responseFailed: { error: { type: 'server_error' } } },
  { responseFailed: { x: 1 } },
  { responseFailed: true },
  { providerWireError: true, message: 'wire fault' },
  { providerError: { code: 'overloaded', message: 'provider error object' } },
  { truncatedStream: true },
  { streamStalled: true },
  { wsCloseCode: 1006 },
  { wsCloseCode: 1008 },
  { streamCloseCode: 1011 },
  { wsCloseCode: 0, streamCloseCode: 1012 },
  { status: 99 },
  { status: 600 },
  { status: 200.7, message: 'x' },
  { status: 404.9 },
  { statusCode: 503 },
  { statusCode: 'x', status: 429 },
  { httpStatus: 401, status: 500 },
  { name: 'APIConnectionError', message: 'Connection error.' },
  { name: 'APIConnectionTimeoutError', message: 'Request timed out.' },
  { name: 'StreamStalledError', message: 'stalled' },
  { name: 'StreamStalledAbortError', message: 'timed out after 60000ms of inactivity' },
  { name: 'AgentStallAbortError' },
  { name: 'ProviderTimeoutError', code: 'EPROVIDERTIMEOUT', message: 'provider first byte timed out after 30000ms' },
  { name: 'ProviderPrefixMutationError', message: 'x' },
  { code: 'PROVIDER_PREFIX_MUTATION', message: 'x' },
  { code: 'TOOL_SURFACE_EXCEEDS_CONTEXT', message: 'tools: 3' },
  { code: 'TRUNCATED_STREAM', message: 'stream ended early' },
  { code: 'TRUNCATED_STREAM', streamCorruption: true, message: 'corrupt' },
  { code: 'TRUNCATED_STREAM', streamCorruption: false },
  { timeoutPhase: 'headers', message: 'timed out after 30000ms' },
  { timeoutPhase: 'headers', waitedMs: 45_000, attempts: 3, message: 'x' },
  { timeoutPhase: 'headers', waitedMs: 0, attempts: 0, message: 'first byte within 20000ms' },
  { timeoutPhase: 'first-chunk', waitedMs: 61_000, message: 'x' },
  { timeoutPhase: 'first-chunk', attempts: 1.5, message: 'timed out after 120000ms' },
  { timeoutPhase: 'idle', message: 'timed out after 90000ms of inactivity' },
  { timeoutPhase: 'idle', message: 'no window' },
  { timeoutPhase: 'auth', message: 'token refresh timed out after 10000ms' },
  { timeoutPhase: 'bogus', message: 'x' },
  { timeoutPhase: 5, message: 'x' },
  { firstByteTimeout: true, message: 'x' },
  { name: 'ProviderTimeoutError', message: 'x' },
  { code: 'EPROVIDERTIMEOUT', message: 'x', timeoutPhase: 'idle' },
  { code: 'ESTREAMSTALL', message: 'stall' },
  { errorKind: { kind: 'rate_limited', retryAfterMs: 30_000, status: 429, code: 'rate_limit_exceeded' }, message: 'persisted rate limit' },
  { errorKind: { kind: 'rate_limited' }, message: 'persisted without a wait' },
  { errorKind: { kind: 'quota_exhausted', resetAt: NOW + 7_200_000, status: 429 }, message: 'persisted quota' },
  { errorKind: { kind: 'quota_exhausted', resetAt: NOW + 3 * 86_400_000 }, message: 'persisted quota another day' },
  { errorKind: { kind: 'billing', status: 402 }, message: 'persisted billing' },
  { errorKind: { kind: 'entitlement' }, message: 'persisted entitlement' },
  { errorKind: { kind: 'auth', status: 401 }, message: 'persisted auth' },
  { errorKind: { kind: 'permission', status: 403 }, message: 'persisted permission' },
  { errorKind: { kind: 'policy' }, message: 'persisted policy' },
  { errorKind: { kind: 'overloaded', status: 529 }, message: 'persisted overload' },
  { errorKind: { kind: 'context_overflow' }, message: 'persisted overflow' },
  { errorKind: { kind: 'request_too_large' }, message: 'persisted size' },
  { errorKind: { kind: 'service_tier_unavailable' }, message: 'persisted tier' },
  { errorKind: { kind: 'invalid_request', status: 400, code: 'model_not_found' }, message: 'persisted request' },
  { errorKind: { kind: 'invalid_request', status: 404 }, message: 'persisted missing' },
  { errorKind: { kind: 'transient', status: 502 }, message: 'persisted transient' },
  { errorKind: { kind: 'transient', code: 'ECONNRESET' }, message: 'persisted reset' },
  { errorKind: { kind: 'transient', code: 'enotfound', status: 0 }, message: 'persisted dns' },
  { errorKind: { kind: 'unknown' }, message: 'persisted unknown' },
  { errorKind: { kind: 'nonsense' }, message: 'persisted bogus kind', status: 429 },
  { errorKind: { kind: 'rate_limited', retryAfterMs: 'x', status: 'y', resetAt: -1 }, message: 'persisted junk' },
  { errorKind: 'rate_limited', message: 'persisted as a string' },
  { errorKind: { kind: 'rate_limited', retryAfterMs: 1500 }, message: 'API 429 request rejected' },
  { errorKind: { kind: 'unknown' }, message: 'API 429 request rejected', status: 429 },
  { status: 429, message: 'API 429 request rejected' },
  { status: 429, message: 'API 429 request rejected', quotaScope: 'day' },
  { status: 429, message: 'API 429 request rejected', code: 'rate_limit_exceeded' },
];
for (const stamp of STAMPS) add(E(stamp.message ?? '', stamp), 'stamp');
for (const stamp of STAMPS) add(stamp, 'stamp-object');

// Network errors by code: on the error, in a cause, behind a fetch wrapper, with and without a message.
for (const code of NETWORK_CODES) {
  add(E(`read ${code}`, { code }), `net-${code}`);
  add(Object.assign(new TypeError('fetch failed'), { cause: E('inner', { code }) }), `net-fetch-${code}`);
  add(E('wrapped', {}, E('inner', { code })), `net-cause-${code}`);
  add({ code }, `net-object-${code}`);
  add({ code, status: 500, message: 'x' }, `net-500-${code}`);
}
for (const name of ['SocketError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError', 'TypeError', 'AbortError', 'APIConnectionError']) {
  add(named(name, 'x'), `net-name-${name}`);
  add(named('TypeError', 'fetch failed', {}, named(name, 'inner')), `net-name-cause-${name}`);
}
for (const status of [500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 525]) {
  add(E(`gateway ${status}`, { status }), `net-gw-${status}`);
  add(E(`API ${status} gateway`), `net-gw-text-${status}`);
}
for (const wsCloseCode of [1000, 1001, 1005, 1006, 1008, 1011, 1012, 1013, 4000]) {
  add(E('ws', { wsCloseCode }), `ws-${wsCloseCode}`);
  add(E('outer', {}, E('inner', { wsCloseCode })), `ws-cause-${wsCloseCode}`);
  add(`OpenAI WS closed before response.completed (code=${wsCloseCode}, reason=x)`, `ws-text-${wsCloseCode}`);
}
// Cause chains: depth, order, strings kept as causes, a chain longer than the bound.
{
  const chain = (depth, leaf) => {
    let error = leaf;
    for (let i = depth; i > 0; i--) error = E(`level ${i}`, {}, error);
    return error;
  };
  for (const depth of [1, 2, 3, 7, 8, 9, 12]) add(chain(depth, E('leaf', { code: 'rate_limit_exceeded', status: 429 })), `chain-${depth}`);
  for (const depth of [1, 7, 8, 9]) add(chain(depth, E('leaf', { code: 'ECONNRESET' })), `chain-net-${depth}`);
  add(E('outer', {}, 'persisted cause text (TOOL_SURFACE_EXCEEDS_CONTEXT)'), 'chain-string-cause');
  add(E('outer', {}, 'plain string cause'), 'chain-string-cause-plain');
  add(E('outer', {}, 5), 'chain-number-cause');
  add(E('outer', {}, { code: 'quota_exceeded', message: 'object cause' }), 'chain-object-cause');
  add(E('outer', { status: 500 }, E('inner', { status: 429, code: 'rate_limit_exceeded' })), 'chain-status-outer');
  add(E('outer', {}, E('mid', {}, E('deep', { reauthRequired: true }))), 'chain-reauth');
  add(E('outer', {}, E('mid', { retryAfterMs: 3000 }, E('deep', { retryAfterMs: 9000 }))), 'chain-retry-after');
  add(E('outer', {}, E('mid', {}, E('deep', { retryAfterMs: 9000 }))), 'chain-retry-after-deep');
  add(E('outer', {}, E('mid', { quotaScope: 'day' }, E('deep', { quotaScope: 'minute' }))), 'chain-scope');
  add(E('outer', {}, E('mid', { resetAt: 0 }, E('deep', { resetAt: NOW + 60_000 }))), 'chain-reset');
  add(E('outer', {}, E('The latest message cannot fit this model (LATEST_TURN_EXCEEDS_CONTEXT): it needs about 9,000 tokens, but the 8,000 window leaves 7,000 for it. Remove attachments.')), 'chain-latest-turn');
  add(E('outer message', { code: 'tool_surface_exceeds_context' }, E('Provider said (TOOL_SURFACE_EXCEEDS_CONTEXT) context_length_exceeded', { code: 'context_length_exceeded' })), 'chain-tool-surface-cause');
}
// Cancellations.
for (const error of [E('x', { cancelled: true }), named('AbortError', 'This operation was aborted'), named('SessionClosedError', 'Session closed'), named('APIUserAbortError', 'Request was aborted.'), E('aborted by session close'), E('withRetry: sleep aborted'), E('sleep aborted'), E('Sleep Aborted'), E('prefix sleep aborted'), { cancelled: true }, { name: 'AbortError' }, 'aborted by session close']) {
  add(error, 'cancel');
}
// Error instances with odd names and messages.
for (const error of [named('', ''), named('', 'only message'), named('TypeError', ''), named('Custom', 'custom message'), Object.assign(new Error(''), { name: undefined }), E('', { code: 'E_X' }), E('', { error: 'member of an error' })]) {
  add(error, 'error-odd');
}
// Wrapped and persisted shapes of one failure.
for (const text of ['429 rate limit retryAfter=30s', 'quota exceeded', 'fetch failed', 'Unauthorized', 'The provider usage limit was reached.']) {
  add(`Error invoking remote method 'x': Error: ${text}`, 'wrapped-ipc');
  add(`agent task failed (job_1): ${text}`, 'wrapped-agent');
  add(JSON.stringify({ error: text }), 'wrapped-json');
  add(JSON.stringify({ error: { message: text, code: 'rate_limit_exceeded' } }), 'wrapped-json-nested');
  add(`API 500: ${JSON.stringify({ error: { message: text } })}`, 'wrapped-api');
}

// ── Recording ───────────────────────────────────────────────────────────────

const PRESENT_OPTIONS = [{}, { surface: 'turn' }, { surface: 'agent' }, { surface: 'web_search', max: 60 }, { surface: 'compact' }, { surface: 'tool', providerLabel: 'OpenAI', max: 20 }, { max: 0 }];
const KIND_OPTIONS = [{}, { text: false }, { quotaFlags: false }, { legacyQuotaWording: true }, { text: false, quotaFlags: false, legacyQuotaWording: true }];
const STATUSES = ['failed', 'timeout', 'Cancelled', 'canceled', 'running', 'stale', ''];

function record(error) {
  const run = (fn) => unwrapped(guard(() => fn(error)));
  const out = {
    errText: run((e) => errText.errText(e)),
    httpStatus: run((e) => errText.errorHttpStatus(e)),
    cancelLike: run((e) => errText.isCancelLikeError(e)),
    present: PRESENT_OPTIONS.map((options) => run((e) => errText.presentErrorText(e, options))),
    line: [{}, { surface: 'turn' }].map((options) => run((e) => errText.errorLine(e, options))),
    describe: run((e) => presentation.describeError(e)),
    rejected429: run((e) => presentation.isRejected429(e)),
    namesModel: run((e) => presentation.namesUnavailableModel(e)),
    kind: KIND_OPTIONS.map((options) => run((e) => kindModule.providerErrorKind(e, options))),
    typedCodeKind: run((e) => kindModule.typedCodeKind(e)),
    typedErrorCode: run((e) => (e && typeof e === 'object' ? kindModule.typedErrorCode(e) : null)),
    retryAfter: run((e) => kindModule.retryAfterMsFromError(e)),
    retryCode: run((e) => kindModule.safeRetryErrorCode(e)),
    retryClass: run((e) => kindModule.retryReasonClass(e)),
    toolSurface: run((e) => kindModule.isToolSurfaceExceedsContextError(e)),
    chainLength: run((e) => kindModule.boundedCauseChain(e).length),
    headers: ['retry-after', 'retry-after-ms', 'x-missing'].map((name) => run((e) => (e && typeof e === 'object' ? kindModule.errorHeaderValue(e, name) : null))),
    transportKind: run((e) => transport.classifyTransportError(e)),
    transportText: run((e) => transport.transportErrorText(e)),
    firstByte: run((e) => phase.isFirstByteTimeout(e)),
    retryTimeout: [['first_response_timeout', null], ['first_response_timeout', 'Anthropic'], ['stalled', null], ['other', null]].map(([klass, label]) => run((e) => errText.retryTimeoutText(e, klass, label))),
    background: STATUSES.flatMap((status) => ['', 'agent'].map((surface) => run((e) => errText.backgroundTaskFailureStatusLabel(status, e, { surface })))),
  };
  return out;
}

const recorded = cases.map(({ id, error, undef }) => {
  const entry = { id };
  if (undef) entry.undef = true;
  else entry.error = plain(error);
  return { ...entry, ...record(undef ? undefined : error) };
});

const texts = TEXTS.concat(['{"error":{"message":"x"}}', 'ENOTFOUND', 'ECONNRESET', 'ERR_SSL_BAD_RECORD_MAC', 'ERR_SSL_X_BAD_RECORD_MAC', 'ERR_SSL_BAD_RECORD_MAC_X', 'UND_ERR_SOCKET']).map((text) => ({
  text,
  safeDetails: unwrapped(guard(() => presentation.safeErrorDetails(text))),
  namesModel: unwrapped(guard(() => presentation.namesUnavailableModel(text))),
  rejected429: unwrapped(guard(() => presentation.isRejected429(text))),
  tokenOverflow: kindModule.TOKEN_CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(text)),
  requestSize: kindModule.REQUEST_SIZE_PATTERNS.some((re) => re.test(text)),
  bareFetch: kindModule.BARE_FETCH_TRANSPORT_MESSAGE_RE.test(text),
  transientCode: kindModule.isTransientErrorCode(text),
  transientName: kindModule.TRANSIENT_SDK_NAMES.has(text),
  backgroundBody: ['', 'boom', text].map((error) => unwrapped(guard(() => errText.isBackgroundErrorOnlyBody(text, error)))),
}));
texts.push({ text: 'x'.repeat(13_000), safeDetails: unwrapped(guard(() => presentation.safeErrorDetails('x'.repeat(13_000)))) });
texts.push({ text: `${'data:image/png;base64,'}${'A'.repeat(300)}`, safeDetails: unwrapped(guard(() => presentation.safeErrorDetails(`data:image/png;base64,${'A'.repeat(300)}`))) });
texts.push({ text: `{"data":"${'B'.repeat(300)}"}`, safeDetails: unwrapped(guard(() => presentation.safeErrorDetails(`{"data":"${'B'.repeat(300)}"}`))) });

const retryStatus = [];
for (const reason of ['No progress 30s', '', 'Provider is rate-limited']) {
  for (const attempt of [undefined, 0, 1, 2, 5, 2.5, -1]) {
    for (const maxAttempts of [undefined, 0, 1, 3, 10]) {
      for (const delayMs of [undefined, 0, 500, 15_000, 120_000, -5]) {
        retryStatus.push({ reason, attempt: attempt ?? null, maxAttempts: maxAttempts ?? null, delayMs: delayMs ?? null, line: errText.retryStatusLine({ reason, attempt, maxAttempts, delayMs }) });
      }
    }
  }
}

const durations = [0, 1, 999, 1000, 1500, 59_999, 60_000, 90_000, 119_999, 120_000, 599_000, 600_000, 3_600_000, 3_660_000].map((ms) => ({
  ms,
  label: errText.errorLine(`first byte timed out after ${ms}ms`),
  stale: errText.presentErrorText(`agent task stale (${ms}ms)`, { surface: 'agent' }),
  background: errText.backgroundTaskFailureStatusLabel('failed', `agent first response stale (${ms}ms)`),
  backgroundStale: errText.backgroundTaskFailureStatusLabel('failed', `agent task stale (${ms}ms)`),
}));

const gateway = [];
const GATEWAY_TYPES = ['authentication', 'permission_denied', 'payment_required', 'context_length_exceeded', 'payload_too_large', 'image_too_large', 'rate_limit_exceeded', 'provider_overloaded', 'provider_unavailable', 'timeout', 'server', 'content_policy_violation', 'refusal', 'invalid_request', 'invalid_prompt', 'unprocessable', 'not_found', 'precondition_failed', ' Server ', 'nope', '', 5, null];
for (const errorType of GATEWAY_TYPES) {
  for (const [detail, envelope] of [[{ code: 'server_error', message: 'm' }, { error_type: errorType }], [{ code: 'timeout' }, { response: { error_type: errorType } }], [{ error_type: errorType, code: 'x' }, null], [{ metadata: { error_type: errorType } }, undefined], [null, { error_type: errorType }], ['str', { error_type: errorType }], [undefined, { error_type: errorType }]]) {
    gateway.push({ detail: plain(detail) ?? null, detailUndefined: detail === undefined, envelope: plain(envelope) ?? null, envelopeUndefined: envelope === undefined, result: unwrapped(guard(() => plain(kindModule.normalizeGatewayErrorDetail(detail, envelope)) ?? null)) });
  }
}

const golden = {
  note: 'Recorded by tests/recorders/record-errors.mjs from the Node error modules; tests/errors_twin.rs replays it.',
  now: NOW,
  kinds: kindModule.PROVIDER_ERROR_KINDS,
  quotaKinds: [...kindModule.QUOTA_KINDS],
  deterministicKinds: [...kindModule.DETERMINISTIC_KINDS],
  presentOptions: PRESENT_OPTIONS,
  kindOptions: KIND_OPTIONS,
  statuses: STATUSES,
  cases: recorded,
  texts,
  retryStatus,
  durations,
  gateway,
};

// An output that throws in Node (a null argument where the code reads a field) is recorded as `{ threw }`; the twin skips it:
// the Rust port answers where Node crashes.
let threw = 0;
const scan = (value) => {
  if (Array.isArray(value)) return value.forEach(scan);
  if (!value || typeof value !== 'object') return;
  if (typeof value.threw === 'string') threw += 1;
  for (const inner of Object.values(value)) scan(inner);
};
scan(golden);
if (threw) console.error(`${threw} recorded output(s) are Node exceptions`);

const text = `${JSON.stringify(golden)}\n`;
if (checkPath) {
  const onDisk = readFileSync(resolve(checkPath), 'utf8');
  if (onDisk !== text) {
    console.error(`${checkPath} differs from what the Node code records now`);
    process.exit(1);
  }
  console.log(`${checkPath} matches (${recorded.length} cases, ${texts.length} texts)`);
} else {
  writeFileSync(outPath, text);
  console.log(`wrote ${outPath} (${recorded.length} cases, ${texts.length} texts, ${text.length} bytes)`);
}
