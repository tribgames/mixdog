import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVIN_ENUMS, DEVIN_SCHEMAS, decodeDevinMessage, encodeDevinMessage } from './devin-wire-protobuf.mjs';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const bytes = (text) => new Uint8Array(Buffer.from(text.replace(/\s+/g, ''), 'hex'));

test('GetUserJwtResponse matches hand-encoded bytes in both directions', () => {
  // 1:string "abc", 2:string "https://x.io"
  const wire = '0a03616263 120c 68747470733a2f2f782e696f';
  const value = { userJwt: 'abc', customApiServerUrl: 'https://x.io' };
  assert.equal(hex(encodeDevinMessage('GetUserJwtResponse', value)), wire.replace(/\s+/g, ''));
  assert.deepEqual(decodeDevinMessage('GetUserJwtResponse', bytes(wire)), value);
});

test('repeated enums encode packed under a two-byte tag and decode from either form', () => {
  // 3:"k"; 30 (tag 0xf2 0x01, wire type 2) packed [3,4,6,7,8]
  const wire = '1a016b f20105 0304060708';
  const metadata = { apiKey: 'k', supportedModelDisplays: [3, 4, 6, 7, 8] };
  assert.equal(hex(encodeDevinMessage('Metadata', metadata)), wire.replace(/\s+/g, ''));
  assert.deepEqual(decodeDevinMessage('Metadata', bytes(wire)), metadata);
  // Unpacked form: tag 0xf0 0x01 (wire type 0) per element.
  assert.deepEqual(decodeDevinMessage('Metadata', bytes('f00103 f00104')), { supportedModelDisplays: [3, 4] });
});

test('nested chat request encodes in field order with two-byte tags and presence fields', () => {
  const request = {
    chatModelUid: 'm',
    chatMessagePrompts: [{ source: DEVIN_ENUMS.ChatMessageSource.USER, prompt: 'hi' }],
    toolChoice: { optionName: 'auto' },
    modelAssignmentJwt: 'j',
  };
  // 3:{2:1, 3:"hi"}  12:{1:"auto"}  21 (aa01):"m"  26 (d201):"j"
  const wire = '1a06 1001 1a026869 6206 0a046175746f aa01016d d201016a';
  assert.equal(hex(encodeDevinMessage('GetChatMessageRequest', request)), wire.replace(/\s+/g, ''));
  assert.deepEqual(decodeDevinMessage('GetChatMessageRequest', bytes(wire)), request);
});

test('proto3 defaults are omitted unless the field has explicit presence', () => {
  assert.equal(
    hex(encodeDevinMessage('ChatMessagePrompt', { messageId: '', source: 0, numTokens: 0, toolResultIsError: false })),
    ''
  );
  // oneof member set to its default is still written: 2:"" -> 12 00
  assert.equal(hex(encodeDevinMessage('ChatToolChoice', { toolName: '' })), '1200');
  // optional bool false at field 7 -> 38 00
  assert.equal(hex(encodeDevinMessage('ChatToolDefinition', { readOnlyHint: false })), '3800');
  // An empty nested message is still present: 13:{} -> 6a 00
  assert.equal(hex(encodeDevinMessage('GetChatMessageRequest', { systemPromptCacheOptions: {} })), '6a00');
});

test('fixed-width and signed scalars use their wire forms', () => {
  // CompletionConfiguration: 2:64000 varint (80f403), 5:double 1.0, 8:double 0.5, 9:"x"
  const config = { maxTokens: 64000, temperature: 1, topP: 0.5, stopPatterns: ['x'] };
  const wire = '1080f403 29000000000000f03f 41000000000000e03f 4a0178';
  assert.equal(hex(encodeDevinMessage('CompletionConfiguration', config)), wire.replace(/\s+/g, ''));
  // maxTokens is uint64 and decodes to bigint.
  assert.deepEqual(decodeDevinMessage('CompletionConfiguration', bytes(wire)), { ...config, maxTokens: 64000n });
  // ModelDimension 2:float 0.5 (wire type 5)
  assert.equal(hex(encodeDevinMessage('ModelDimension', { value: 0.5 })), '150000003f');
  // int32 -1 is a ten-byte two's-complement varint (field 18 -> tag 90 01)
  const negative = '9001ffffffffffffffffff01';
  assert.equal(hex(encodeDevinMessage('ClientModelConfig', { maxTokens: -1 })), negative);
  assert.deepEqual(decodeDevinMessage('ClientModelConfig', bytes(negative)), { maxTokens: -1 });
  // 64-bit counters accept bigint input
  assert.equal(hex(encodeDevinMessage('ModelUsageStats', { inputTokens: 300n })), '10ac02');
});

test('streamed chat response decodes text, thinking, tool deltas, stop reason, usage', () => {
  const wire = [
    '0a026964', // 1 messageId "id"
    '1a026869', // 3 deltaText "hi"
    '2803', // 5 stopReason MAX_TOKENS
    '320a 0a0163 12016e 1a027b7d', // 6 deltaToolCalls [{id:c,name:n,argumentsJson:{}}]
    '3a04 1005 1807', // 7 usage {inputTokens:5, outputTokens:7}
    '4a0174', // 9 deltaThinking "t"
    'ba0100', // 23 actualModelUid "" (presence)
    '980601', // unknown field 99 varint 1
  ].join('');
  const decoded = decodeDevinMessage('GetChatMessageResponse', bytes(wire));
  const { $unknown, ...known } = decoded;
  assert.deepEqual(known, {
    messageId: 'id',
    deltaText: 'hi',
    stopReason: DEVIN_ENUMS.StopReason.MAX_TOKENS,
    deltaToolCalls: [{ id: 'c', name: 'n', argumentsJson: '{}' }],
    usage: { inputTokens: 5n, outputTokens: 7n },
    deltaThinking: 't',
    actualModelUid: '',
  });
  assert.deepEqual($unknown, [{ no: 99, wireType: 0, data: Uint8Array.of(1) }]);
});

test('repeated elements are kept even when they hold the type default', () => {
  // CompletionConfiguration 9: ['', 'a', ''] -> 4a00 4a0161 4a00
  const wire = '4a00 4a0161 4a00';
  assert.equal(
    hex(encodeDevinMessage('CompletionConfiguration', { stopPatterns: ['', 'a', ''] })),
    wire.replace(/\s+/g, '')
  );
  assert.deepEqual(decodeDevinMessage('CompletionConfiguration', bytes(wire)), { stopPatterns: ['', 'a', ''] });
  // Packed repeated enum keeps its zero: 30 [0, 3] -> f201 02 0003
  assert.equal(hex(encodeDevinMessage('Metadata', { supportedModelDisplays: [0, 3] })), 'f201020003');
  // Repeated empty message: ChatMessagePrompt 6 [{}] -> 3200
  assert.equal(hex(encodeDevinMessage('ChatMessagePrompt', { toolCalls: [{}] })), '3200');
});

test('64-bit integers keep full precision as bigint', () => {
  // ModelUsageStats 2: 2^53 + 1 -> 10 81 80 80 80 80 80 80 10
  const above53 = '10 8180808080808010';
  assert.equal(hex(encodeDevinMessage('ModelUsageStats', { inputTokens: 2n ** 53n + 1n })), above53.replace(' ', ''));
  assert.deepEqual(decodeDevinMessage('ModelUsageStats', bytes(above53)), { inputTokens: 9007199254740993n });
  // 3: 2^64 - 1 -> 18 ff x9 01
  const max = `18${'ff'.repeat(9)}01`;
  assert.equal(hex(encodeDevinMessage('ModelUsageStats', { outputTokens: 2n ** 64n - 1n })), max);
  assert.deepEqual(decodeDevinMessage('ModelUsageStats', bytes(max)), { outputTokens: 18446744073709551615n });
  // Signed int64 -1 at field 26 (tag d0 01) from number, bigint or string input.
  const minusOne = `d001${'ff'.repeat(9)}01`;
  for (const value of [-1, -1n, '-1']) {
    assert.equal(hex(encodeDevinMessage('GetChatMessageResponse', { committedQuotaCostBasisPoints: value })), minusOne);
  }
  assert.deepEqual(decodeDevinMessage('GetChatMessageResponse', bytes(minusOne)), {
    committedQuotaCostBasisPoints: -1n,
  });
  // A zero int64 under presence is still written: 27 (d8 01) 0
  assert.equal(hex(encodeDevinMessage('GetChatMessageResponse', { committedOverageCostCents: 0n })), 'd80100');
  // Implicit-presence 64-bit zero is a default in any input form.
  assert.equal(hex(encodeDevinMessage('ModelUsageStats', { inputTokens: '0', outputTokens: 0 })), '');
});

test('32-bit and unsigned fields apply width-specific coercion', () => {
  // int32 (ClientModelConfig 18, tag 90 01) and uint32 (ChatMessagePrompt 4, tag 20) truncate to 32 bits.
  assert.equal(hex(encodeDevinMessage('ClientModelConfig', { maxTokens: 2 ** 32 + 5 })), '900105');
  assert.equal(hex(encodeDevinMessage('ChatMessagePrompt', { numTokens: 2 ** 32 + 5 })), '2005');
  // An int32 decodes as the low 32 bits, signed: 0xffffffff -> -1.
  assert.deepEqual(decodeDevinMessage('ClientModelConfig', bytes('9001ffffffff0f')), { maxTokens: -1 });
  // A uint32 decodes as the low 32 bits of at most five bytes.
  assert.deepEqual(decodeDevinMessage('ChatMessagePrompt', bytes('20ffffffff7f')), { numTokens: 4294967295 });
  assert.throws(() => decodeDevinMessage('ChatMessagePrompt', bytes('20808080808001')), /32-bit varint/);
  // Enums are int32: a negative enum is a ten-byte varint and decodes back.
  const negativeEnum = `28${'ff'.repeat(9)}01`;
  assert.equal(hex(encodeDevinMessage('GetChatMessageResponse', { stopReason: -1 })), negativeEnum);
  assert.deepEqual(decodeDevinMessage('GetChatMessageResponse', bytes(negativeEnum)), { stopReason: -1 });
  // Negative unsigned values and non-integer inputs are rejected.
  const rejects = [
    ['ChatMessagePrompt', { numTokens: -1 }, /uint32 value: negative/],
    ['ModelUsageStats', { inputTokens: -1n }, /uint64 value: negative/],
    ['CompletionConfiguration', { seed: '-2' }, /uint64 value: negative/],
    ['ClientModelConfig', { maxTokens: 1.5 }, /int32 value/],
    ['ClientModelConfig', { maxTokens: 5n }, /int32 value/],
    ['GetChatMessageRequest', { requestType: '5' }, /enum value/],
    ['ModelUsageStats', { inputTokens: 1.5 }, /uint64 value/],
    ['ModelUsageStats', { inputTokens: 'x' }, /uint64 value/],
  ];
  for (const [type, value, pattern] of rejects) {
    assert.throws(
      () => encodeDevinMessage(type, value),
      pattern,
      JSON.stringify(value, (_k, v) => String(v))
    );
  }
  // Varints longer than ten bytes are malformed.
  assert.throws(
    () => decodeDevinMessage('ModelUsageStats', bytes(`10${'ff'.repeat(10)}01`)),
    /Invalid Devin protobuf varint/
  );
});

test('malformed protobuf is rejected', () => {
  const cases = [
    ['GetUserJwtResponse', '0801'], // string field sent as varint
    ['GetUserJwtResponse', '0a0561'], // length past the end
    ['GetUserJwtResponse', '0a01ff'], // invalid UTF-8
    ['GetUserJwtResponse', '0a80'], // truncated length varint
    ['GetUserJwtResponse', '0b'], // group wire type
    ['GetUserJwtResponse', '0001'], // field number 0
    ['ModelDimension', '1000'], // float field sent as varint
    ['CompletionConfiguration', '290000'], // truncated double
  ];
  for (const [type, wire] of cases) {
    assert.throws(() => decodeDevinMessage(type, bytes(wire)), /Devin protobuf/, `${type} ${wire}`);
  }
  assert.throws(() => encodeDevinMessage('NoSuchMessage', {}), /Unknown Devin protobuf message/);
});

test('AssignModel request and response use the router field numbers', () => {
  // 2:"adaptive" 3:"c" 5:{2:1}
  const request = { modelRouterUid: 'adaptive', cascadeId: 'c', chatMessagePrompt: { source: 1 } };
  assert.equal(hex(encodeDevinMessage('AssignModelRequest', request)), '1208616461707469766' + '51a01632a021001');
  // 1:{1:"j", 2:"m", 3:["h"]}
  const wire = '0a09 0a016a 12016d 1a0168';
  assert.deepEqual(decodeDevinMessage('AssignModelResponse', bytes(wire)), {
    assignment: { assignmentJwt: 'j', modelUid: 'm', harnessUids: ['h'] },
  });
});

test('schema table exposes field names for request builders', () => {
  const names = (type) => Object.values(DEVIN_SCHEMAS[type]).map((field) => field.name);
  assert.ok(names('GetChatMessageRequest').includes('chatMessagePrompts'));
  assert.ok(names('ChatMessagePrompt').includes('toolCallId'));
  assert.equal(DEVIN_SCHEMAS.GetChatMessageRequest[21].name, 'chatModelUid');
  assert.equal(DEVIN_SCHEMAS.ChatMessagePrompt[2].enum, 'ChatMessageSource');
});
