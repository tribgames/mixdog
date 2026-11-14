import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { BLOB_PUT_CHUNK_BYTES, MAX_INLINE_RESULT_BYTES, uploadBlob } from './blob-upload.ts';

const MAX_INBOUND_FRAME = 256 * 1024;

function recorder() {
  const puts = [];
  return {
    puts,
    connection: {
      request: async (method, params) => {
        assert.equal(method, 'blob/put');
        puts.push(params);
        return {};
      },
    },
  };
}

test('a blob goes in 96 KiB chunks that each fit one frame, and the digest is the sha256 of all of it', async () => {
  const bytes = Buffer.alloc(3 * BLOB_PUT_CHUNK_BYTES + 12, 0xab);
  const { puts, connection } = recorder();
  const ref = await uploadBlob(connection, bytes, 'image/png');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.deepEqual(ref, { digest, size: bytes.length });
  assert.match(ref.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    puts.map((put) => put.offset),
    [0, 96 * 1024, 2 * 96 * 1024, 3 * 96 * 1024]
  );
  for (const put of puts) {
    assert.equal(put.digest, digest);
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'blob/put', params: put });
    assert.ok(Buffer.byteLength(frame) < MAX_INBOUND_FRAME);
  }
  assert.ok(Buffer.concat(puts.map((put) => Buffer.from(put.bytesB64, 'base64'))).equals(bytes));
});

test('an empty blob is one empty chunk, and an exact multiple adds no empty tail', async () => {
  const empty = recorder();
  assert.equal((await uploadBlob(empty.connection, new Uint8Array(0), 'text/plain')).size, 0);
  assert.equal(empty.puts.length, 1);
  assert.equal(empty.puts[0].bytesB64, '');
  const exact = recorder();
  await uploadBlob(exact.connection, new Uint8Array(2 * BLOB_PUT_CHUNK_BYTES), 'text/plain');
  assert.equal(exact.puts.length, 2);
});

test('a refused chunk fails the upload', async () => {
  const connection = { request: async () => Promise.reject(new Error('no space')) };
  await assert.rejects(uploadBlob(connection, new Uint8Array(10), 'text/plain'), /no space/);
});

test('the inline limit is 192 KiB', () => {
  assert.equal(MAX_INLINE_RESULT_BYTES, 196608);
});
