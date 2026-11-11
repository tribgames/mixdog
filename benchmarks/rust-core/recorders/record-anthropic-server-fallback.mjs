#!/usr/bin/env node
// anthropic-server-fallback.test.mjs: the real server-fallback helpers, beta-header builder, OAuth request-body builder, SSE parser (a
// scripted stream with a `fallback` content block) and agentLoop usage attribution (the provider is a scripted `send` that answers
// with the fallback model). All send cases are WIRE level (the real provider to the loopback endpoint); the two builder/parser cases (:48 `_buildRequestBodyForCacheSmoke`, :59 `parseAnthropicFallbackBlock`) are pure, see `levels`.
//   node benchmarks/rust-core/recorders/record-anthropic-server-fallback.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-anthropic-server-fallback',
  exclusions: [
    "`sends[].model` is not compared: the recorder's label of the send's input (the `model` argument of the recorded call), not an output of the product; the model the product sent is compared in its request body",
    "`sends[].serverFallback` is not compared: the recorder's label of the send's input (the `serverFallback` option of the recorded call), not an output of the product; what the product sent for it is compared in the request's anthropic-beta header",
    "`stopDetails` is not compared: the send copies the turn's stop_details into its result (anthropic-sse-turn/turn-outcome.mjs:141, anthropic-turn-result.mjs:60) and nothing reads it after (`[.?]stopDetails\\b` over src/ without tests finds only those copies and the write at turn-events/message-events.mjs:27)",
  ],
  entry: 'anthropic.mjs AnthropicProvider({ apiKey }).send(messages, model, tools, opts) (the real SDK client, the real retry/recovery ladder) against the loopback endpoint; agent-loop.mjs agentLoop over that provider; anthropic-oauth.mjs AnthropicOAuthProvider({}).send over a credentials file of the recording (the OAuth request body, WIRE), and a stream carrying the fallback block (the parser, WIRE). Not run: a live endpoint.',
  compare: 'WIRE cases: serve each case\'s scripted answer (SSE events as writes, or 404 then JSON for the non-streaming case) from a loopback endpoint through the Rust Anthropic send and compare the request as it arrived (body bytes, every header in order incl. anthropic-beta) and `result` / `deltas` (model, providerMetadata.anthropicFallbacks, content without the fallback block). The Rust decoder does not read the fallback block today (K1 gap G7): the replay will report that difference.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::anthropic::AnthropicAdapter (anthropic/adapter.rs:169) and AnthropicCodec (anthropic/codec.rs:148), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079), built by mixdog_ai::registry DefaultProviderBuilder::build (registry/builder.rs:1295).",
});
const P = 'agent/orchestrator/providers/';
const { SERVER_SIDE_FALLBACK_BETA_HEADER, buildAnthropicBetaHeaders } = await rec.P(`${P}anthropic-betas.mjs`);
const { AnthropicOAuthProvider } = await rec.P(`${P}anthropic-oauth.mjs`);
const { AnthropicProvider } = await rec.P(`${P}anthropic.mjs`);
const { agentLoop } = await rec.P('agent/orchestrator/session/agent-loop.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/anthropic-server-fallback.test.mjs';
const fallbackBlock = { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } };

// WIRE level: the real AnthropicProvider (API-key route, real SDK client) sends to the loopback endpoint, which serves a scripted SSE stream (each event its own socket
// write); the request recorded is what arrived (body bytes and the anthropic-beta header). The model families and the `serverFallback: false` option are the inputs.
const HI = [{ role: 'user', content: 'hi' }];
const sseEvents = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
const plainEvents = [
  { type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];
const serve = (events) => { rec.net.reply = () => ({ status: 200, contentType: 'text/event-stream', chunks: sseEvents(events) }); };
const provider = () => new AnthropicProvider({ apiKey: 'fixture-key' });
await rec.run('eligible-families-default-fallback', `${SRC}:22`, { models: ['claude-opus-5', 'claude-fable-5-20260801', 'claude-opus-4-8'], disabledOption: { serverFallback: false } }, async () => {
  serve(plainEvents);
  const sends = [];
  for (const model of ['claude-opus-5', 'claude-fable-5-20260801', 'claude-opus-4-8']) sends.push({ model, result: await provider().send(HI, model, [], {}) });
  sends.push({ model: 'claude-opus-5', serverFallback: false, result: await provider().send(HI, 'claude-opus-5', [], { serverFallback: false }) });
  return { sends };
});
await rec.run('beta-header-gated-and-deduplicated', `${SRC}:36`, { sends: [{ model: 'claude-opus-5' }, { model: 'claude-opus-5', serverFallback: false }] }, async () => {
  serve(plainEvents);
  return { on: await provider().send(HI, 'claude-opus-5', [], {}), off: await provider().send(HI, 'claude-opus-5', [], { serverFallback: false }) };
});
// :48 - the OAuth request body: the Node test builds it with the test-only `_buildRequestBodyForCacheSmoke`; here the real OAuth provider sends it to the loopback endpoint (the credentials file of the
// product, written into the recording's data directory with fixed fake tokens) and the body that arrived is the answer.
await rec.run('oauth-body-opts-eligible-models', `${SRC}:48`, { credentials: 'anthropic-oauth-credentials.json (fixed fake tokens, scope user:inference)', sends: [{ model: 'claude-opus-5' }, { model: 'claude-opus-4-8' }, { model: 'claude-opus-5', serverFallback: false }] }, async () => {
  rec.write('anthropic-oauth-credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-access-fixture', refreshToken: 'oauth-refresh-fixture', expiresAt: Date.parse('2030-01-01T00:00:00Z'), scopes: ['user:inference'] } }));
  serve(plainEvents);
  const oauth = () => new AnthropicOAuthProvider({});
  return { opus5: await oauth().send(HI, 'claude-opus-5', [], {}), opus48: await oauth().send(HI, 'claude-opus-4-8', [], {}), disabled: await oauth().send(HI, 'claude-opus-5', [], { serverFallback: false }) };
});
// :59 - the fallback block parser: the Node test calls `parseAnthropicFallbackBlock` on the block and on a text block whose text is "fallback"; here the stream carries both and the provider's own
// parsing is what the send result shows (no public Rust function parses it: the Rust decoder does not read the block, K1 gap G7).
await rec.run('fallback-block-parser', `${SRC}:59`, { block: fallbackBlock, notAFallback: { type: 'text', text: 'fallback' } }, async () => {
  serve([
    { type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: fallbackBlock },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'fallback' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);
  return { result: await provider().send(HI, 'claude-opus-5', [], {}) };
});
const events = [
  { type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: fallbackBlock },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];
await rec.run('sse-records-fallback-attributes-serving-model', `${SRC}:93`, { events }, async () => {
  serve(events);
  return { result: await provider().send(HI, 'claude-opus-5', [], {}) };
});
await rec.run('agent-loop-usage-delta-serving-model', `${SRC}:148`, { events }, async () => {
  serve(events);
  const deltas = [];
  const result = await agentLoop(provider(), [{ role: 'user', content: 'test' }], 'claude-opus-5', [], async () => {}, process.cwd(), { sessionId: 'server-fallback-usage-test', onUsageDelta: (delta) => deltas.push(delta) });
  return { result, deltas };
});
// The non-streaming normalizer: a gateway that answers the streaming request with 404 makes the provider replay the same request with stream:false; that answer carries the fallback block.
await rec.run('non-streaming-normalizer-excludes-fallback-blocks-and-preserves-metadata', `${SRC}:187`, { streamingAnswer: 404, nonStreamingAnswer: { model: 'claude-opus-5', content: [fallbackBlock, { type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } } }, async () => {
  rec.net.reply = (request) => (JSON.parse(request.body).stream === true
    ? { status: 404, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'streaming not served' } }) }
    : { status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [fallbackBlock, { type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }) });
  return { result: await provider().send(HI, 'claude-opus-5', [], {}) };
});
await rec.finish();
