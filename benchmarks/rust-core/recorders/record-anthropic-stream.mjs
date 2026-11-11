#!/usr/bin/env node
// anthropic-stream.test.mjs (11 tests; 13 rows with the usage loop): the real Anthropic SSE parser (`parseSSEStream` of anthropic-oauth.mjs,
// the same parser anthropic.mjs reuses) over scripted event lists framed `event: <type>\ndata: <json>\n\n` and delivered through the
// `body.getReader()` shape the parser reads, with the eager tool-call, text and stream-delta callbacks recorded.
//   node benchmarks/rust-core/recorders/record-anthropic-stream.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-anthropic-stream',
  net: false,
  entry: 'anthropic-oauth.mjs parseSSEStream(response, signal, abortStream, onStreamDelta, onToolCall, state, onTextDelta) over a scripted SSE body; openai-compat-stream.mjs isInvalidToolArgsMarker. Not run: a network send.',
  compare: 'mixdog-ai providers::anthropic decoder.rs (UsageAcc::update :110-135, :182 refusal, :259-296 thinking shapes, :278-283): feed `input.events` and compare `result` whole (usage slots, stopReason/stopDetails, toolCalls incl. the invalid-args marker, thinkingBlocks) and the callbacks (`toolCalls`, `streamDeltas`) in order. K1 gap: Rust drops stopDetails/category (row 1, low).',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::anthropic::AnthropicAdapter (anthropic/adapter.rs:169) and AnthropicCodec (anthropic/codec.rs:148), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079), built by mixdog_ai::registry DefaultProviderBuilder::build (registry/builder.rs:1295).",
});
const { parseSSEStream } = await rec.P('agent/orchestrator/providers/anthropic-oauth.mjs');
const { isInvalidToolArgsMarker } = await rec.P('agent/orchestrator/providers/openai-compat-stream.mjs');
const SRC = 'scripts/provider-toolcall/anthropic-stream.test.mjs';

const sseResponse = (events) => {
  const chunks = events.map((e) => new TextEncoder().encode(`event: ${e.type || 'message'}\ndata: ${JSON.stringify(e)}\n\n`));
  let i = 0;
  return { body: { getReader: () => ({ read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }), cancel: () => Promise.resolve(), releaseLock() {} }) } };
};
async function parse(events) {
  const toolCalls = [];
  const streamDeltas = [];
  const out = {};
  try {
    out.result = await parseSSEStream(sseResponse(events), null, () => {}, (kind) => streamDeltas.push(kind), (call) => toolCalls.push(call), {}, null);
  } catch (error) {
    out.error = error;
  }
  return { ...out, toolCalls, streamDeltas };
}
const row = (id, line, events, extra = () => ({})) => rec.run(id, `${SRC}:${line}`, { events }, async () => {
  const out = await parse(events);
  return { ...out, ...extra(out.result, out) };
});
const start = (usage = { input_tokens: 1 }) => ({ type: 'message_start', message: { model: 'claude', usage } });
const stop = (stopReason, usage = { output_tokens: 1 }) => ({ type: 'message_delta', delta: { stop_reason: stopReason }, usage });
const slots = (result) => ({ usageSlots: [result.usage.inputTokens, result.usage.outputTokens, result.usage.cachedTokens, result.usage.cacheWriteTokens, result.usage.promptTokens] });

await row('final-usage-revises-every-slot-before-early-tool-use-return', 5, [
  start({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'usage-tool', name: 'shell', input: { command: 'echo test' } } }, { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 31, output_tokens: 17, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } },
], slots);
for (const [i, delta] of [{ output_tokens: 9 }, { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { input_tokens: null, output_tokens: null }].entries()) {
  await row(`partial-usage-update-${i}`, 61, [start({ input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: delta }, { type: 'message_stop' }], slots);
}
await row('refusal-stop-details-and-category', 104, [
  { type: 'message_start', message: { model: 'claude-fable-5', usage: { input_tokens: 1 } } },
  { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { classifier: 'safety' }, category: 'policy' }, usage: { output_tokens: 0 } }, { type: 'message_stop' },
]);
await row('streamed-tool-use-canonical-tool-calls', 135, [start(), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell' } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }, { type: 'content_block_stop', index: 0 }, stop('tool_use'), { type: 'message_stop' }]);
await row('malformed-tool-args-invalid-marker', 159, [start(), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_bad', name: 'shell' } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command": dispatchAiWrapped}' } }, { type: 'content_block_stop', index: 0 }, stop('tool_use'), { type: 'message_stop' }],
  (result, out) => ({ resultMarker: isInvalidToolArgsMarker(result?.toolCalls?.[0]?.arguments), dispatchedMarker: isInvalidToolArgsMarker(out.toolCalls[0]?.arguments) }));
await row('text-only-no-tool-calls', 187, [start(), { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }, { type: 'content_block_stop', index: 0 }, stop('end_turn'), { type: 'message_stop' }],
  (result) => ({ toolCallsIsUndefined: result.toolCalls === undefined }));
await row('thinking-signature-ordered-before-tool-use', 209, [
  start(), { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'step ' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'one' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }, { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'shell' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }, { type: 'content_block_stop', index: 1 },
  stop('tool_use'), { type: 'message_stop' },
]);
await row('signature-only-block-keeps-empty-thinking', 237, [start(), { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sigABC' } }, { type: 'content_block_stop', index: 0 }, stop('end_turn'), { type: 'message_stop' }]);
await row('redacted-thinking-roundtrips-exactly', 258, [start(), { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED_PAYLOAD' } }, { type: 'content_block_stop', index: 0 }, stop('end_turn'), { type: 'message_stop' }]);
await rec.finish();
