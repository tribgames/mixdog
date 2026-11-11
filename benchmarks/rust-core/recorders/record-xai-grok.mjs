#!/usr/bin/env node
// xai-grok.test.mjs (5 tests): the real Grok tool-schema flattening, the xAI Responses cache routing and fingerprint payload, and the
// grok-oauth provider's pinned CLI-proxy transport, over scripted inputs and env settings.
//   node benchmarks/rust-core/recorders/record-xai-grok.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-xai-grok',
  net: false,
  entry: 'scripts/provider-toolcall/_shared.mjs re-exports: normalizeGrokToolSchemas(BUILTIN_TOOLS entry), xaiResponsesCacheRouting(opts, params, tools, model), _xaiResponsesFingerprintPayloadForTest, GrokOAuthProvider({ preconnect: false })._ensureInner(token, model) with MIXDOG_OAI_TRANSPORT / MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT set as the test sets them. Not run: a send.',
  replay: 'mixdog-ai providers::grok (tool_schema, mod.rs:42-98) and compat::tests cache routing: compare `result` whole (normalized schemas, cache mode/key presence/equalities, fingerprint flags, inner provider transport + baseURL). Cache keys are recorded as produced; their equalities are in `equalities`.',
});
const { _xaiResponsesFingerprintPayloadForTest, xaiResponsesCacheRouting, GrokOAuthProvider, BUILTIN_TOOLS, normalizeGrokToolSchemas } = await rec.load('scripts/provider-toolcall/_shared.mjs');
const SRC = 'scripts/provider-toolcall/xai-grok.test.mjs';

const grep = BUILTIN_TOOLS.find((tool) => tool.name === 'grep');
await rec.run('flatten-keeps-grep-pattern-required', `${SRC}:15`, { tool: grep }, () => ({ original: grep.inputSchema, normalized: normalizeGrokToolSchemas([grep])[0] }));
const xor1 = { name: 'grep', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' } }, anyOf: [{ required: ['pattern'] }, { required: ['glob'] }], additionalProperties: false } };
await rec.run('flatten-promotes-first-xor-required-only-anyof', `${SRC}:32`, { tool: xor1 }, () => ({ normalized: normalizeGrokToolSchemas([xor1])[0] }));
const xor2 = { name: 'searchish', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' } }, anyOf: [{ type: 'object', required: ['pattern'] }, { type: 'object', required: ['glob'] }] } };
await rec.run('flatten-promotes-first-xor-object-branch', `${SRC}:48`, { tool: xor2 }, () => ({ normalized: normalizeGrokToolSchemas([xor2])[0] }));

const params = { messages: [{ role: 'system', content: 'stable system' }] };
const route = (opts) => xaiResponsesCacheRouting(opts, params, [], 'grok-4.6');
await rec.run('xai-responses-cache-routing', `${SRC}:66`, { params }, () => {
  const first = route({ sessionId: 'session-a' });
  const same = route({ sessionId: 'session-a' });
  const other = route({ sessionId: 'session-b' });
  const sessionless = route({});
  const optedOut = route({ sessionId: 'session-a', xaiResponsesCacheScope: 'none' });
  const sessionA = route({ sessionId: 'session-a', xaiResponsesCacheScope: 'session' });
  const sessionAgain = route({ sessionId: 'session-a', xaiResponsesCacheScope: 'session' });
  const sessionB = route({ sessionId: 'session-b', xaiResponsesCacheScope: 'session' });
  const sharedA = route({ sessionId: 'session-a', xaiResponsesCacheScope: 'prefix' });
  const sharedB = route({ sessionId: 'session-b', xaiResponsesCacheScope: 'prefix' });
  const payload = _xaiResponsesFingerprintPayloadForTest({
    model: 'grok-4.6', opts: { sessionId: 'session-a', providerState: { xaiResponses: { store: false, seenMessageCount: 6 } } },
    params: { input: [{ role: 'user', content: 'next' }], prompt_cache_key: first.key, store: false }, rawTools: [],
    response: { model: 'grok-4.6-build', usage: { input_tokens: 7_324, input_tokens_details: { cached_tokens: 128 } } },
    cacheRouting: first, previousResponseId: null, inputStartIndex: 0, continuationResetReason: null, transport: 'http', cacheLane: null,
  });
  return {
    routes: { first, same, other, sessionless, optedOut, sessionA, sessionAgain, sessionB, sharedA, sharedB },
    equalities: {
      firstKeyEqualsSame: first.key === same.key, otherKeyDiffers: other.key !== first.key, prefixHashEqual: first.prefixHash === other.prefixHash,
      sessionKeysEqual: sessionA.key === sessionAgain.key, sessionKeysDifferAcrossSessions: sessionA.key !== sessionB.key, prefixKeysEqualAcrossSessions: sharedA.key === sharedB.key,
    },
    payload,
  };
});
await rec.run('grok-oauth-pinned-to-cli-proxy-http-sse', `${SRC}:161`, { env: { MIXDOG_OAI_TRANSPORT: 'ws-delta', MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT: 'websocket' } }, () => {
  const saved = ['MIXDOG_OAI_TRANSPORT', 'MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT', 'MIXDOG_GROK_OAUTH_TRANSPORT'].map((k) => [k, process.env[k]]);
  try {
    process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
    delete process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT;
    delete process.env.MIXDOG_GROK_OAUTH_TRANSPORT;
    const provider = new GrokOAuthProvider({ preconnect: false });
    const models = ['grok-build-0.1', 'grok-build', 'grok-4.5'].map((model) => {
      const inner = provider._ensureInner(`tok-${model}`, model);
      return { model, responsesTransport: inner.config.responsesTransport, baseURL: inner.baseURL };
    });
    process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT = 'websocket';
    const pinned = new GrokOAuthProvider({ preconnect: false, responsesTransport: 'websocket' })._ensureInner('tok-explicit', 'grok-4.5');
    return { models, explicitWebsocket: { responsesTransport: pinned.config.responsesTransport, baseURL: pinned.baseURL } };
  } finally {
    for (const [k, v] of saved) (v == null ? delete process.env[k] : (process.env[k] = v));
  }
});
await rec.finish();
