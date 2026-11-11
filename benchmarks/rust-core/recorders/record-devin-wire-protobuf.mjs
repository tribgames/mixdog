#!/usr/bin/env node
// devin-wire-protobuf.test.mjs (12 tests): the real Devin protobuf codec (`encodeDevinMessage` / `decodeDevinMessage` over the product's
// schemas) on scripted values and wire bytes: encode (value -> hex or the refusal) and decode (hex -> value or the refusal).
// Values the JSON cannot hold are written as text: a bigint as "<digits>n", a byte array as { bytesHex }.
//   node benchmarks/rust-core/recorders/record-devin-wire-protobuf.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-devin-wire-protobuf',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/devin-wire-protobuf.mjs encodeDevinMessage(type, value), decodeDevinMessage(type, bytes), DEVIN_ENUMS, DEVIN_SCHEMAS. Not run: a Devin endpoint.',
  compare: 'mixdog-ai providers::connect pb.rs (:156-285) and devin request/decoder: for each `steps[*]` entry run `op` ("encode": value -> hex, "decode": hex -> value, "schema": field-name table) and compare `hex` / `value` / `error.message` whole. Rows in `input.values` carrying "<n>n" strings are 64-bit integers.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::devin::DevinAdapter (devin/mod.rs:165), DevinCodec (devin/mod.rs:88) and DevinDecoder (devin/decoder.rs:48), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079).",
});
const { DEVIN_ENUMS, DEVIN_SCHEMAS, decodeDevinMessage, encodeDevinMessage } = await rec.P('agent/orchestrator/providers/devin-wire-protobuf.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/devin-wire-protobuf.test.mjs';
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const bytes = (text) => new Uint8Array(Buffer.from(text.replace(/\s+/g, ''), 'hex'));
const enc = (type, value) => {
  try {
    return { op: 'encode', type, value, hex: hex(encodeDevinMessage(type, value)) };
  } catch (error) {
    return { op: 'encode', type, value, error };
  }
};
const dec = (type, wire) => {
  try {
    return { op: 'decode', type, hex: wire.replace(/\s+/g, ''), value: decodeDevinMessage(type, bytes(wire)) };
  } catch (error) {
    return { op: 'decode', type, hex: wire.replace(/\s+/g, ''), error };
  }
};
const row = (id, line, steps) => rec.run(id, `${SRC}:${line}`, { steps: steps.map(({ op, type, value, hex: h }) => ({ op, type, ...(value !== undefined ? { value } : {}), ...(op === 'decode' ? { hex: h } : {}) })) }, () => ({ steps }));
const S = (fn) => fn();

await row('get-user-jwt-response', 70, [enc('GetUserJwtResponse', { userJwt: 'abc', customApiServerUrl: 'https://x.io' }), dec('GetUserJwtResponse', '0a03616263 120c 68747470733a2f2f782e696f')]);
await row('repeated-enums-packed', 24, [
  enc('Metadata', { apiKey: 'k', supportedModelDisplays: [3, 4, 6, 7, 8] }), dec('Metadata', '1a016b f20105 0304060708'), dec('Metadata', 'f00103 f00104'),
]);
await row('nested-chat-request', 36, [
  enc('GetChatMessageRequest', { chatModelUid: 'm', chatMessagePrompts: [{ source: DEVIN_ENUMS.ChatMessageSource.USER, prompt: 'hi' }], toolChoice: { optionName: 'auto' }, modelAssignmentJwt: 'j' }),
  dec('GetChatMessageRequest', '1a06 1001 1a026869 6206 0a046175746f aa01016d d201016a'),
]);
await row('proto3-defaults-and-presence', 49, [
  enc('ChatMessagePrompt', { messageId: '', source: 0, numTokens: 0, toolResultIsError: false }), enc('ChatToolChoice', { toolName: '' }),
  enc('ChatToolDefinition', { readOnlyHint: false }), enc('GetChatMessageRequest', { systemPromptCacheOptions: {} }),
]);
await row('fixed-width-and-signed-scalars', 62, [
  enc('CompletionConfiguration', { maxTokens: 64000, temperature: 1, topP: 0.5, stopPatterns: ['x'] }),
  dec('CompletionConfiguration', '1080f403 29000000000000f03f 41000000000000e03f 4a0178'),
  enc('ModelDimension', { value: 0.5 }), enc('ClientModelConfig', { maxTokens: -1 }), dec('ClientModelConfig', '9001ffffffffffffffffff01'), enc('ModelUsageStats', { inputTokens: 300n }),
]);
await row('streamed-chat-response', 82, [dec('GetChatMessageResponse', ['0a026964', '1a026869', '2803', '320a 0a0163 12016e 1a027b7d', '3a04 1005 1807', '4a0174', 'ba0100', '980601'].join(''))]);
await row('repeated-elements-keep-defaults', 95, [
  enc('CompletionConfiguration', { stopPatterns: ['', 'a', ''] }), dec('CompletionConfiguration', '4a00 4a0161 4a00'),
  enc('Metadata', { supportedModelDisplays: [0, 3] }), enc('ChatMessagePrompt', { toolCalls: [{}] }),
]);
await row('64-bit-integers-bigint', 128, [
  enc('ModelUsageStats', { inputTokens: 2n ** 53n + 1n }), dec('ModelUsageStats', '10 8180808080808010'),
  enc('ModelUsageStats', { outputTokens: 2n ** 64n - 1n }), dec('ModelUsageStats', `18${'ff'.repeat(9)}01`),
  ...[-1, -1n, '-1'].map((value) => enc('GetChatMessageResponse', { committedQuotaCostBasisPoints: value })),
  dec('GetChatMessageResponse', `d001${'ff'.repeat(9)}01`), enc('GetChatMessageResponse', { committedOverageCostCents: 0n }), enc('ModelUsageStats', { inputTokens: '0', outputTokens: 0 }),
]);
await row('32-bit-and-unsigned-coercion', 152, [
  enc('ClientModelConfig', { maxTokens: 2 ** 32 + 5 }), enc('ChatMessagePrompt', { numTokens: 2 ** 32 + 5 }), dec('ClientModelConfig', '9001ffffffff0f'),
  dec('ChatMessagePrompt', '20ffffffff7f'), dec('ChatMessagePrompt', '20808080808001'),
  enc('GetChatMessageResponse', { stopReason: -1 }), dec('GetChatMessageResponse', `28${'ff'.repeat(9)}01`),
  enc('ChatMessagePrompt', { numTokens: -1 }), enc('ModelUsageStats', { inputTokens: -1n }), enc('CompletionConfiguration', { seed: '-2' }), enc('ClientModelConfig', { maxTokens: 1.5 }),
  enc('ClientModelConfig', { maxTokens: 5n }), enc('GetChatMessageRequest', { requestType: '5' }), enc('ModelUsageStats', { inputTokens: 1.5 }), enc('ModelUsageStats', { inputTokens: 'x' }),
  dec('ModelUsageStats', `10${'ff'.repeat(10)}01`),
]);
await row('malformed-protobuf-rejected', 170, [
  ...[['GetUserJwtResponse', '0801'], ['GetUserJwtResponse', '0a0561'], ['GetUserJwtResponse', '0a01ff'], ['GetUserJwtResponse', '0a80'], ['GetUserJwtResponse', '0b'], ['GetUserJwtResponse', '0001'], ['ModelDimension', '1000'], ['CompletionConfiguration', '290000']].map(([type, wire]) => dec(type, wire)),
  enc('NoSuchMessage', {}),
]);
await row('assign-model-router-fields', 187, [
  enc('AssignModelRequest', { modelRouterUid: 'adaptive', cascadeId: 'c', chatMessagePrompt: { source: 1 } }), dec('AssignModelResponse', '0a09 0a016a 12016d 1a0168'),
]);
await rec.run('schema-table-field-names', `${SRC}:198`, {}, () => ({
  steps: [{ op: 'schema', schemas: DEVIN_SCHEMAS, field21: DEVIN_SCHEMAS.GetChatMessageRequest[21].name, promptField2Enum: DEVIN_SCHEMAS.ChatMessagePrompt[2].enum }],
}));
await rec.finish();
