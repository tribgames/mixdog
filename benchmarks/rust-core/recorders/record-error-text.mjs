#!/usr/bin/env node
// Golden twin of `presentErrorText` (runtime/shared/err-text.mjs). Each case holds the error's
// fields, the options, the provider-kind descriptor Node's `providerErrorKind` gave it (Rust
// receives its kind from the adapter that classified the failure, so the golden hands Rust the
// same verdict), and the text Node answered. Rust `mixdog-ai` `service::error_text` must equal it.
//
//   node benchmarks/rust-core/recorders/record-error-text.mjs --tree <dir>
import { join } from 'node:path';
import { importFrom, parseArgs, resolveTree, writeJson, REPO_ROOT } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const shared = 'src/runtime/shared/';
const errText = await importFrom(tree, `${shared}err-text.mjs`);
const kinds = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/provider-error-kind.mjs');

const LATEST =
  'agent compact failed (x): The latest message cannot fit this model (LATEST_TURN_EXCEEDS_CONTEXT): it needs about 12,000 tokens, but the 8,000-token window leaves 6,000 for it. Shorten it.';
// Each: [fields, options]. A string is a bare-string error.
const specs = [
  ['boom'],
  [''],
  ['Error: something broke'],
  ['[error] wrapped: detail'],
  ['{"error":"inner message"}'],
  ['{"error":{"message":"nested"}}'],
  ['{"message":"top message"}'],
  ['{"error":{"code":"x"}}'],
  ['line one\nerror: the real one\nline three'],
  ['Failed = disk full'],
  [{ message: 'API 429 rate limit', status: 429 }],
  [{ message: 'API 429 request rejected', status: 429 }],
  [{ message: 'slow down', status: 429, retryAfterMs: 4000 }],
  [{ message: 'slow down', status: 429, retryAfterMs: 125000 }],
  [{ message: 'busy', status: 529 }],
  [{ message: 'overloaded_error', code: 'overloaded_error', status: 529 }],
  [{ message: 'The provider is at capacity', status: 503 }],
  [{ message: 'quota gone', code: 'insufficient_quota', status: 429 }],
  [{ message: 'no plan', code: 'usage_not_included', status: 403 }],
  [{ message: 'unauthorized', status: 401 }],
  [{ message: 'forbidden', status: 403 }],
  [{ message: 'denied', code: 'permission_denied', status: 403 }],
  [{ message: 'blocked', code: 'content_policy_violation', status: 400 }],
  [{ message: 'Invalid API key provided', status: 401 }],
  ['invalid api key given'],
  [{ message: 'sign in again', reauthRequired: true }],
  ['refresh token expired, invalid_grant'],
  [{ message: 'image dimensions exceed 8000px', status: 400 }],
  [{ message: 'An attached image exceeds the provider limit', status: 400 }],
  [{ message: 'The model `gpt-9` does not exist', status: 404, code: 'model_not_found' }],
  [{ message: 'Unknown model: x', status: 400 }],
  [{ message: 'invalid schema for function foo', status: 400 }],
  [{ message: 'tools.3.input_schema: bad', status: 400 }],
  [{ message: 'route not found', status: 404 }],
  [{ message: LATEST }],
  [{ message: 'payload too large', status: 413 }],
  [{ message: 'context length exceeded', code: 'context_length_exceeded', status: 400 }],
  [{ message: 'AGENT_CONTEXT_OVERFLOW: too big' }],
  [{ message: 'compaction failed badly' }, { surface: 'compact' }],
  [{ message: 'compaction failed badly' }],
  [{ message: 'bad request body', status: 400 }],
  [{ message: 'unprocessable', status: 422 }],
  [{ message: 'x', code: 'invalid_request_error' }],
  [{ message: 'fetch failed' }],
  [{ message: 'socket closed', code: 'ECONNRESET' }],
  [{ message: 'dns', code: 'ENOTFOUND' }],
  [{ message: 'connect', code: 'ETIMEDOUT' }],
  [{ message: 'tls', code: 'CERT_HAS_EXPIRED' }],
  [{ message: 'API 503 upstream', status: 503 }],
  [{ message: 'gateway', status: 502 }],
  [{ message: 'closed', wsCloseCode: 1006 }],
  [{ message: 'OpenAI WS closed before response.completed (code=1011, reason=x)' }],
  [{ message: 'terminated' }],
  [{ message: 'connection reset by peer' }],
  [{ message: 'stream ended', code: 'TRUNCATED_STREAM' }],
  [{ message: 'stream ended', code: 'TRUNCATED_STREAM', streamCorruption: true }],
  [{ message: 'timed out after 30000ms', timeoutPhase: 'headers', waitedMs: 30000, attempts: 2 }, { providerLabel: 'OpenAI' }],
  [{ message: 'first byte timed out after 45000ms', timeoutPhase: 'first-chunk' }],
  [{ message: 'timed out after 90000ms of inactivity', timeoutPhase: 'idle' }],
  [{ message: 'timed out', timeoutPhase: 'idle' }],
  [{ message: 'timed out after 90000ms of inactivity', name: 'StreamStalledError' }],
  [{ message: 'first byte timed out after 61000ms', name: 'ProviderTimeoutError' }],
  [{ message: 'x', code: 'EPROVIDERTIMEOUT' }],
  [{ message: 'first transport stale (30000ms)' }],
  [{ message: 'agent first response stale (120000ms)' }, { surface: 'agent' }],
  [{ message: 'first response stale (60000ms)' }, { surface: 'web-search' }],
  [{ message: 'first response stale (60000ms)' }, { surface: 'turn' }],
  [{ message: 'agent task stale (300000ms since progress)' }, { surface: 'task' }],
  [{ message: 'tool running stale (45000ms)' }],
  [{ message: 'Session "sess_abc" closed: aborted during call' }, { surface: 'agent' }],
  [{ message: 'Session "sess_abc" closed: closed during call' }],
  [{ message: 'Session closed: closeSession' }],
  [{ message: 'parent signal aborted' }],
  [{ message: 'whatever', cancelled: true }],
  [{ message: 'whatever', cancelled: true }, { surface: 'turn' }],
  [{ message: 'aborted', name: 'AbortError' }],
  [{ message: 'x', name: 'SessionClosedError' }, { surface: 'agent' }],
  [{ message: 'prefix changed', code: 'PROVIDER_PREFIX_MUTATION' }],
  [{ message: 'Tool surface too big (TOOL_SURFACE_EXCEEDS_CONTEXT)\nline two' }],
  [{ message: 'x', code: 'TOOL_SURFACE_EXCEEDS_CONTEXT' }],
  [{ message: 'rate limit retryAfter=90s cooldown' }],
  [{ message: 'Anthropic OAuth quota exceeded retryAfter=3h' }],
  [{ message: 'Anthropic OAuth quota exceeded retryAfter=45s' }],
  [{ message: 'too many requests', status: 429, code: 'rate_limit_exceeded' }],
  [{ message: 'The provider usage limit was reached' }],
  [{ message: 'Provider is busy at capacity.', status: 503 }],
  [{ message: 'Bearer abcdefghijklmnop token leak https://user:pw@host/x?api_key=SECRETVALUE end' }],
  [{ message: `sk-${'a'.repeat(20)} and ${'x'.repeat(300)}` }, { max: 80 }],
  [{ message: 'caf\u00e9 \ud83d\ude00 '.repeat(40) }, { max: 40 }],
  [{ message: 'session sess_ABC123 run_ABCDEFGHIJKLMNOPQRS failed' }],
  [{ message: 'data:image/png;base64,AAAA+/== in body' }],
  [{ message: '\u001b[31mred\u001b[0m text' }],
  [{ message: 'x'.repeat(12100) }, { max: 20000 }],
  [{ message: 'Error invoking remote method \'x\': Error: quota hit', status: 500 }],
];

function build(fields) {
  if (typeof fields === 'string') return fields;
  const { message, ...rest } = fields;
  return Object.assign(new Error(message), rest);
}

const cases = specs.map(([fields, options = {}]) => {
  const error = build(fields);
  // A bare string is classified from its wording (the second `providerErrorKind` call in `classify`).
  const d = kinds.providerErrorKind(typeof error === 'string' ? new Error(error) : error);
  return {
    error: fields,
    options,
    descriptor: { kind: d.kind, code: d.code, status: d.status, retryAfterMs: d.retryAfterMs, resetAt: d.resetAt },
    text: errText.presentErrorText(error, options),
    line: errText.errorLine(error, options),
  };
});

writeJson(join(REPO_ROOT, 'native/core/crates/mixdog-ai/fixtures/error-text/cases.json'), { cases });
console.log(`error text cases: ${cases.length}`);
