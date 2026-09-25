import assert from 'node:assert/strict';
import test from 'node:test';
import { base64ByteLength } from './inline-file-kind.mjs';

test('base64ByteLength counts decoded bytes across every padding width', () => {
  assert.equal(base64ByteLength(''), 0);
  assert.equal(base64ByteLength(null), 0);
  assert.equal(base64ByteLength('QQ=='), 1);
  assert.equal(base64ByteLength('QUI='), 2);
  assert.equal(base64ByteLength('QUJD'), 3);
  assert.equal(base64ByteLength(Buffer.alloc(1000).toString('base64')), 1000);
});
