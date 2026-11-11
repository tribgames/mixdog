#!/usr/bin/env node
// xai-grok.test.mjs (5 tests): the real Grok tool-schema flattening, the xAI Responses cache routing and fingerprint payload, and the
// grok-oauth provider's pinned CLI-proxy transport, over scripted inputs and env settings.
//   node benchmarks/rust-core/recorders/record-xai-grok.mjs --tree <exact export of b6f10295a>
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-xai-grok',
  entry: 'provider-toolcall/_shared.mjs re-exports: GrokOAuthProvider({ preconnect: false }) with in-memory tokens .send(messages, model, tools, opts) against the loopback endpoint (WIRE: tool flattening, xAI Responses cache routing, the pinned CLI-proxy HTTP/SSE route with MIXDOG_OAI_TRANSPORT / MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT set as the test sets them); the fingerprint case is the same send with MIXDOG_XAI_CACHE_TRACE=1 and the local agent trace pointed at a recording file (WIRE: the cache_context row the provider wrote). Not run: a live endpoint.',
  compare: 'WIRE cases: send each case through the Rust Grok adapter to a loopback endpoint (the Responses request is answered with one completed text turn) and compare the request as it arrived in `requests` (origin, path, every header in order, body bytes: flattened tool schemas, prompt_cache_key, store/include) and `sent.*.result`. The fingerprint case compares the `trace` rows the send wrote.',
  replay: "WIRE: mixdog_ai::providers::grok::adapter() (grok/mod.rs:224) with codec() (grok/mod.rs:212) and GrokRewriter (grok/mod.rs:153, which carries the tool flattening: the private grok/tool_schema.rs flatten_tools is reachable only through it), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) against a loopback endpoint.",
});
const { _xaiResponsesFingerprintPayloadForTest, xaiResponsesCacheRouting, GrokOAuthProvider, BUILTIN_TOOLS } = await rec.load('scripts/provider-toolcall/_shared.mjs');
const SRC = 'scripts/provider-toolcall/xai-grok.test.mjs';

// WIRE level: the real GrokOAuthProvider (its in-memory tokens set, as after a login) sends to the loopback endpoint through the product's own tool flattening, cache routing and pinned CLI-proxy
// transport; the request that arrived (origin, path, every header in order, body bytes) is recorded in `requests`. The endpoint answers every Responses request with one completed text turn.
const done = (record) => ({ type: 'response.completed', response: { id: 'resp-1', model: JSON.parse(record.body).model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] } });
const serve = () => { rec.net.reply = (record) => ({ status: 200, contentType: 'text/event-stream', chunks: [`event: response.completed\ndata: ${JSON.stringify(done(record))}\n\n`] }); };
const send = async (tools, model, opts = {}, providerConfig = {}) => {
  serve();
  const provider = new GrokOAuthProvider({ preconnect: false, ...providerConfig });
  provider.tokens = { access_token: 'tok-fixture', refresh_token: 'refresh-fixture', expires_at: Date.parse('2030-01-01T00:00:00Z'), user_id: 'user-fixture' };
  const settled = provider.send([{ role: 'user', content: 'hi' }], model, tools, opts).then((result) => ({ result }), (error) => ({ error }));
  return rec.clock.followRetries(settled);
};
const grep = BUILTIN_TOOLS.find((tool) => tool.name === 'grep');
await rec.run('flatten-keeps-grep-pattern-required', `${SRC}:15`, { tool: grep }, async () => ({ sent: await send([grep], 'grok-4.5') }));
const xor1 = { name: 'grep', description: 'xor', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' } }, anyOf: [{ required: ['pattern'] }, { required: ['glob'] }], additionalProperties: false } };
await rec.run('flatten-promotes-first-xor-required-only-anyof', `${SRC}:32`, { tool: xor1 }, async () => ({ sent: await send([xor1], 'grok-4.5') }));
const xor2 = { name: 'searchish', description: 'xor object', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' } }, anyOf: [{ type: 'object', required: ['pattern'] }, { type: 'object', required: ['glob'] }] } };
await rec.run('flatten-promotes-first-xor-object-branch', `${SRC}:48`, { tool: xor2 }, async () => ({ sent: await send([xor2], 'grok-4.5') }));

const params = { messages: [{ role: 'system', content: 'stable system' }] };
const route = (opts) => xaiResponsesCacheRouting(opts, params, [], 'grok-4.6');
const routeCases = [['first', { sessionId: 'session-a' }], ['same', { sessionId: 'session-a' }], ['other', { sessionId: 'session-b' }], ['sessionless', {}], ['optedOut', { sessionId: 'session-a', xaiResponsesCacheScope: 'none' }], ['sessionA', { sessionId: 'session-a', xaiResponsesCacheScope: 'session' }], ['sessionAgain', { sessionId: 'session-a', xaiResponsesCacheScope: 'session' }], ['sessionB', { sessionId: 'session-b', xaiResponsesCacheScope: 'session' }], ['sharedA', { sessionId: 'session-a', xaiResponsesCacheScope: 'prefix' }], ['sharedB', { sessionId: 'session-b', xaiResponsesCacheScope: 'prefix' }]];
await rec.run('xai-responses-cache-routing', `${SRC}:66`, { sends: routeCases }, async () => {
  const sent = {};
  for (const [name, opts] of routeCases) sent[name] = await send([], 'grok-4.6', opts);
  return { sent };
});
// :66 - the fingerprint payload is the cache_context trace row the provider writes when a Responses turn completes with the xAI cache trace on (MIXDOG_XAI_CACHE_TRACE=1): the case is the send
// itself (wire), with the local agent trace pointed at a file of the recording and the endpoint answering with the scripted response model and usage; the row the product wrote is the result.
await rec.run('xai-responses-fingerprint-payload', `${SRC}:66`, { sessionId: 'session-a', providerState: { xaiResponses: { store: false, seenMessageCount: 6 } }, env: { MIXDOG_XAI_CACHE_TRACE: '1', MIXDOG_AGENT_TRACE_PATH: '<data>/agent-trace.jsonl' }, response: { model: 'grok-4.6-build', usage: { input_tokens: 7_324, input_tokens_details: { cached_tokens: 128 } } } }, async ({ clock }) => {
  const tracePath = join(rec.dataDir, 'agent-trace.jsonl');
  const saved = ['MIXDOG_XAI_CACHE_TRACE', 'MIXDOG_AGENT_TRACE_PATH', 'MIXDOG_AGENT_TRACE_DISABLE', 'MIXDOG_AGENT_TRACE_LOCAL_DISABLE'].map((k) => [k, process.env[k]]);
  try {
    process.env.MIXDOG_XAI_CACHE_TRACE = '1';
    process.env.MIXDOG_AGENT_TRACE_PATH = tracePath;
    delete process.env.MIXDOG_AGENT_TRACE_DISABLE;
    delete process.env.MIXDOG_AGENT_TRACE_LOCAL_DISABLE;
    rec.net.reply = (record) => ({ status: 200, contentType: 'text/event-stream', chunks: [`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-1', model: 'grok-4.6-build', status: 'completed', usage: { input_tokens: 7_324, input_tokens_details: { cached_tokens: 128 } }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] } })}\n\n`] });
    const provider = new GrokOAuthProvider({ preconnect: false });
    provider.tokens = { access_token: 'tok-fixture', refresh_token: 'refresh-fixture', expires_at: Date.parse('2030-01-01T00:00:00Z'), user_id: 'user-fixture' };
    const sent = await clock.followRetries(provider.send([{ role: 'user', content: 'hi' }], 'grok-4.6', [], { sessionId: 'session-a', providerState: { xaiResponses: { store: false, seenMessageCount: 6 } } }).then((result) => ({ result }), (error) => ({ error })));
    const rows = () => (existsSync(tracePath) ? readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
    // The local trace is spooled and written by the product's flush timer (virtual clock): once the timer is armed by the append, the clock moves to it and the row reaches the file.
    const flushTimer = () => clock.pendingFrom(/_appendLocalTrace/)[0];
    await clock.advance(0, { until: () => flushTimer() !== undefined, what: 'the trace flush timer armed' });
    await clock.advance(flushTimer().due - (Date.now() - rec.T0), { until: () => rows().some((row) => row.kind === 'cache_context'), what: 'the cache_context trace row written' });
    return { sent, trace: rows() };
  } finally {
    for (const [k, v] of saved) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
});
await rec.run('grok-oauth-pinned-to-cli-proxy-http-sse', `${SRC}:161`, { env: { MIXDOG_OAI_TRANSPORT: 'ws-delta', then: { MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT: 'websocket', providerConfig: { responsesTransport: 'websocket' } } }, models: ['grok-build-0.1', 'grok-build', 'grok-4.5'] }, async () => {
  const saved = ['MIXDOG_OAI_TRANSPORT', 'MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT', 'MIXDOG_GROK_OAUTH_TRANSPORT'].map((k) => [k, process.env[k]]);
  try {
    process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
    delete process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT;
    delete process.env.MIXDOG_GROK_OAUTH_TRANSPORT;
    const sent = {};
    for (const model of ['grok-build-0.1', 'grok-build', 'grok-4.5']) sent[model] = await send([], model);
    // The explicit websocket request (env and provider config) must still end on the pinned HTTP/SSE CLI-proxy route.
    process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT = 'websocket';
    sent.explicitWebsocket = await send([], 'grok-4.5', {}, { responsesTransport: 'websocket' });
    return { sent };
  } finally {
    for (const [k, v] of saved) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
});
await rec.finish();
