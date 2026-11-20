import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter } from './remote-protocol-files.ts';

test('the phone gets one complete save range without an oversized control reply', async () => {
  const transferId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const version = 'a'.repeat(43);
  // Distinct content across pages, with a padded final base64 segment.
  const file = Buffer.alloc(1024 * 1024, 37);
  file.fill(82, file.length / 2);
  const client = {
    async call(method, params) {
      assert.equal(method, 'transfer/readRange');
      assert.equal(params.transferId, transferId);
      assert.equal(params.version, version);
      const { offset, length } = params;
      const bytes = file.subarray(offset, offset + length);
      const reply = {
        transferId,
        version,
        offset,
        length: bytes.length,
        data: bytes.toString('base64'),
        eof: offset + bytes.length === file.length,
      };
      assert.ok(Buffer.byteLength(JSON.stringify({ id: 1, result: reply })) <= 256 * 1024);
      return reply;
    },
  };
  let progress = 0;
  const reply = await adapter.calls.fileDownloadRange([transferId, 0, file.length, version], {
    client: () => client,
    transferProgress: () => {
      progress += 1;
    },
  });
  assert.ok(progress > 1, 'acknowledged pages keep the save call alive');
  assert.deepEqual(reply, {
    transferId,
    version,
    offset: 0,
    length: file.length,
    data: file.toString('base64'),
    eof: true,
  });
});
