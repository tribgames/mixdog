import assert from 'node:assert/strict';
import test from 'node:test';
import { relayFrameByteLength } from './remote-payload-limit.ts';

test('relay frame sizes match UTF-8 bytes across every UTF-16 code unit', () => {
  for (let code = 0; code <= 0xffff; code += 1) {
    const frame = String.fromCharCode(code);
    assert.equal(relayFrameByteLength(frame), Buffer.byteLength(frame, 'utf8'), `code unit ${code}`);
  }
});

test('relay frame sizes preserve empty, mixed, surrogate-pair and sliced binary inputs', () => {
  for (const frame of ['', 'ascii\u0000\u007f', 'a\u0080z', 'a😀z', '\ud800x\udc00']) {
    assert.equal(relayFrameByteLength(frame), Buffer.byteLength(frame, 'utf8'));
  }
  assert.equal(relayFrameByteLength(new Uint8Array(10).subarray(2, 5)), 3);
});
