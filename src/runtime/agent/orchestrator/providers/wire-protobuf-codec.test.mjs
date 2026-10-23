import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeMessage } from './cursor-wire-protobuf.mjs';
import { createProtobufCodec, protobufFields, repeated } from './wire-protobuf-codec.mjs';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const bytes = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const SCHEMAS = {
  Numbers: protobufFields([['values', 1, 'int', repeated]]),
  Real: protobufFields([['value', 1, 'double']]),
};

test('repeated numeric fields stay unpacked unless the codec opts into packing', () => {
  const lenient = createProtobufCodec(SCHEMAS);
  // Unpacked: one 08 tag per element.
  assert.equal(hex(lenient.encodeMessage('Numbers', { values: [1, 2] })), '08010802');
  assert.deepEqual(lenient.decodeMessage('Numbers', bytes('08010802')), { values: [1, 2] });
  // Without `packed`, a length-delimited record is not unpacked: the lenient
  // reader takes the length varint (01) as the value, then reads 08 00 as 1:0.
  assert.deepEqual(lenient.decodeMessage('Numbers', bytes('0a010800')), { values: [1, 0] });
  assert.throws(
    () => createProtobufCodec(SCHEMAS, { strict: true }).decodeMessage('Numbers', bytes('0a020102')),
    /wire type 2/
  );

  const packed = createProtobufCodec(SCHEMAS, { packed: true });
  assert.equal(hex(packed.encodeMessage('Numbers', { values: [1, 2] })), '0a020102');
  assert.deepEqual(packed.decodeMessage('Numbers', bytes('0a020102')), { values: [1, 2] });
  assert.deepEqual(packed.decodeMessage('Numbers', bytes('08010802')), { values: [1, 2] });
});

test('only strict codecs bounds-check doubles against the message length', () => {
  // 1:double with three of eight bytes present, in a buffer of exactly that size.
  const truncated = bytes('09000000');
  assert.throws(() => createProtobufCodec(SCHEMAS, { strict: true }).decodeMessage('Real', truncated), /Truncated/);
  assert.throws(
    () => createProtobufCodec(SCHEMAS).decodeMessage('Real', truncated),
    (error) => error instanceof RangeError && !/Truncated/.test(error.message)
  );
  // Cursor keeps its native RangeError for a truncated JsonValue.numberValue (field 2).
  assert.throws(
    () => decodeMessage('JsonValue', bytes('11000000')),
    (error) => error instanceof RangeError && !/Cursor protobuf/.test(error.message)
  );
  assert.equal(decodeMessage('JsonValue', bytes('11000000000000f83f')).numberValue, 1.5);
});

test('repeated defaults and long varints keep the lenient behaviour outside canonical/strict codecs', () => {
  const schemas = { Words: protobufFields([['words', 1, 'string', repeated]]), ...SCHEMAS };
  // Lenient (Cursor-style) codec drops empty repeated strings; canonical keeps them.
  assert.equal(hex(createProtobufCodec(schemas).encodeMessage('Words', { words: ['', 'a'] })), '0a0161');
  assert.equal(
    hex(createProtobufCodec(schemas, { omitDefaults: true }).encodeMessage('Words', { words: ['', 'a'] })),
    '0a000a0161'
  );
  // An 11-byte varint: accepted leniently, rejected by strict codecs (10-byte cap).
  const eleven = bytes(`08${'ff'.repeat(10)}01`);
  assert.deepEqual(createProtobufCodec(schemas).decodeMessage('Numbers', eleven), { values: [-1] });
  assert.throws(
    () => createProtobufCodec(schemas, { strict: true }).decodeMessage('Numbers', eleven),
    /Invalid protobuf varint/
  );
});
