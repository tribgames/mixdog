// A phone carries the grant, transfer id and version returned by the core across all five download calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter } from './remote-protocol-files.ts';

const GRANT = '00000000-0000-4000-8000-000000000001';
const TRANSFER = '00000000-0000-4000-8000-000000000002';
const VERSION = 'A'.repeat(43);

test('a phone redeems the returned grant, reads that transfer, finishes it, and can ask whether it still exists', async () => {
  const metadata = { name: 'report.txt', size: 3, mime: 'text/plain', version: VERSION };
  const grant = { grantId: GRANT, ...metadata, expiresAt: 60_000 };
  const transfer = { transferId: TRANSFER, ...metadata, expiresAt: 30 * 60_000, rangeMaxBytes: 4 * 1024 * 1024 };
  const range = { transferId: TRANSFER, offset: 0, length: 3, version: VERSION };
  const chunk = { ...range, eof: true, data: 'YWJj' };
  const finished = { transferId: TRANSFER, version: VERSION, size: 3 };
  const responses = [
    ['transfer/authorizeRead', { sessionId: 's1', source: { kind: 'file', rel: 'report.txt' }, purpose: 'open' }, grant],
    ['transfer/redeemGrant', { grantId: GRANT }, transfer],
    ['transfer/readRange', range, chunk],
    ['transfer/finishRead', { transferId: TRANSFER }, finished],
    ['transfer/endRead', { transferId: TRANSFER }, { ended: false }],
  ];
  const sent = [];
  const host = { client: () => ({
    async call(method, params) {
      const expected = responses[sent.length];
      assert.ok(expected, `unexpected request: ${method}`);
      sent.push([method, params]);
      return structuredClone(expected[2]);
    },
  }) };
  const call = (name, ...args) => adapter.calls[name](args, host);
  const authorized = await call('fileDownloadAuthorize', { source: { kind: 'project', sessionId: 's1', relPath: 'report.txt' }, purpose: 'open' });
  assert.deepEqual(authorized, grant);
  const begun = await call('fileDownloadBegin', authorized.grantId);
  assert.deepEqual(begun, transfer);
  assert.deepEqual(await call('fileDownloadRange', begun.transferId, 0, 3, begun.version), chunk);
  assert.deepEqual(await call('fileDownloadFinish', begun.transferId), finished);
  assert.equal(await call('fileDownloadAbort', begun.transferId), false);
  assert.deepEqual(sent, responses.map(([method, params]) => [method, params]));
});
