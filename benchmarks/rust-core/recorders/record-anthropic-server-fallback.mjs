#!/usr/bin/env node
// anthropic-server-fallback.test.mjs: the real server-fallback helpers, beta-header builder, OAuth request-body builder, SSE parser (a
// scripted stream with a `fallback` content block) and agentLoop usage attribution (the provider is a scripted `send` that answers
// with the fallback model). 6 tests recorded; the non-streaming normalizer case (:187) is not recorded: Rust has no non-streaming
// Anthropic path (K1 gaps-providers row 12, GONE).
//   node benchmarks/rust-core/recorders/record-anthropic-server-fallback.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-anthropic-server-fallback',
  net: false,
  entry: 'anthropic-server-fallback.mjs (supportsAnthropicServerFallback, applyAnthropicServerFallback, parseAnthropicFallbackBlock), anthropic-betas.mjs buildAnthropicBetaHeaders, anthropic-oauth.mjs _buildRequestBodyForCacheSmoke, anthropic-sse.mjs parseSSEStream(response, null, ...callbacks, state, ...) over a scripted SSE body, session/agent-loop.mjs agentLoop over a scripted provider.send that answers with the serving model. Not run: normalizeAnthropicNonStreamingResponse (no Rust counterpart).',
  replay: 'mixdog-ai providers::anthropic (body.rs:166-185, :795-815, betas.rs:55-57, decoder.rs:340-361): compare `eligibility`, the request bodies/beta headers, and for the SSE case the whole parsed `result` (model, contentBlockTypes, providerMetadata.anthropicFallbacks). The Rust decoder does not read the fallback block today (K1 gap G7): the replay will report that difference. The agent-loop deltas compare requestedModel vs model.',
});
const P = 'agent/orchestrator/providers/';
const { SERVER_SIDE_FALLBACK_BETA_HEADER, buildAnthropicBetaHeaders } = await rec.P(`${P}anthropic-betas.mjs`);
const { _buildRequestBodyForCacheSmoke } = await rec.P(`${P}anthropic-oauth.mjs`);
const { applyAnthropicServerFallback, parseAnthropicFallbackBlock, supportsAnthropicServerFallback } = await rec.P(`${P}anthropic-server-fallback.mjs`);
const { parseSSEStream } = await rec.P(`${P}anthropic-sse.mjs`);
const { agentLoop } = await rec.P('agent/orchestrator/session/agent-loop.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/anthropic-server-fallback.test.mjs';
const fallbackBlock = { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } };

await rec.run('eligible-families-default-fallback', `${SRC}:22`, {}, () => {
  const body = {};
  const disabled = {};
  return {
    eligibility: Object.fromEntries(['claude-opus-5', 'claude-fable-5-20260801', 'claude-opus-4-8'].map((m) => [m, supportsAnthropicServerFallback(m)])),
    applied: applyAnthropicServerFallback(body, 'claude-opus-5'),
    body,
    appliedDisabled: applyAnthropicServerFallback(disabled, 'claude-opus-5', { enabled: false }),
    disabled,
  };
});
await rec.run('beta-header-gated-and-deduplicated', `${SRC}:36`, {}, () => {
  const off = buildAnthropicBetaHeaders({ base: '', serverFallback: false });
  const on = buildAnthropicBetaHeaders({ base: SERVER_SIDE_FALLBACK_BETA_HEADER, serverFallback: true });
  return { betaConstant: SERVER_SIDE_FALLBACK_BETA_HEADER, off, on, onList: on.split(',') };
});
await rec.run('oauth-body-opts-eligible-models', `${SRC}:48`, {}, () => ({
  opus5: _buildRequestBodyForCacheSmoke([], 'claude-opus-5'),
  opus48: _buildRequestBodyForCacheSmoke([], 'claude-opus-4-8'),
  disabled: _buildRequestBodyForCacheSmoke([], 'claude-opus-5', [], { serverFallback: false }),
}));
await rec.run('fallback-block-parser', `${SRC}:59`, { block: fallbackBlock }, () => ({
  parsed: parseAnthropicFallbackBlock(fallbackBlock),
  notAFallback: parseAnthropicFallbackBlock({ type: 'text', text: 'fallback' }),
}));
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
  const state = { attemptIndex: 0, sawMessageStart: false, sawCompleted: false, emittedToolCall: false, partialToolCall: false, emittedThinking: false, emittedText: false };
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const result = await parseSSEStream(new Response(body), null, () => {}, () => {}, () => {}, state, () => {});
  return { result, stateAfter: state };
});
await rec.run('agent-loop-usage-delta-serving-model', `${SRC}:148`, {}, async () => {
  const deltas = [];
  const provider = {
    name: 'anthropic-oauth',
    async send() {
      return { content: 'done', model: 'claude-opus-4-8', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 3, cacheWriteTokens: 4, promptTokens: 8 } };
    },
  };
  const result = await agentLoop(provider, [{ role: 'user', content: 'test' }], 'claude-opus-5', [], async () => {}, process.cwd(), { sessionId: 'server-fallback-usage-test', onUsageDelta: (delta) => deltas.push(delta) });
  return { result, deltas };
});
await rec.finish();
