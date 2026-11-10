// What the files adapter asks the core for each of the phone's five download calls, and what it answers the page. The adapter's reply to
// every recorded call over a real core is compared with Node's frame by remote-protocol-files-downloads.slow.test.mjs; this one pins the
// requests themselves (the conversation's id and its project travel with the authorization, an abort's reply is the bare boolean).
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter } from './remote-protocol-files.ts';

const PROJECT = 'C:/replay/project';
const threads = { s1: { projectPath: PROJECT }, s2: { projectPath: null } };

test('the core is asked for the stage each call names, with the conversation and its project', async () => {
  const sent = [];
  const client = {
    call: async (method, params) => {
      sent.push([method, params]);
      if (method === 'thread/read') return { thread: threads[params.threadId] };
      return method === 'transfer/endRead' ? { ended: true } : {};
    },
  };
  const host = { ctx: {}, client: () => client, declareLane() {} };
  const id = '00000000-0000-4000-8000-000000000001';
  const version = 'A'.repeat(43);
  await adapter.calls.fileDownloadAuthorize([{ source: { kind: 'project', sessionId: 's1', relPath: 'out.bin' }, purpose: 'save' }], host);
  await adapter.calls.fileDownloadAuthorize([{ source: { kind: 'session', sessionId: 's2', path: 'C:/replay/a.bin' }, purpose: 'open' }], host);
  await adapter.calls.fileDownloadBegin([id], host);
  await adapter.calls.fileDownloadRange([id, 0, 4, version], host);
  await adapter.calls.fileDownloadFinish([id], host);
  assert.equal(await adapter.calls.fileDownloadAbort([id], host), true);
  assert.deepEqual(
    sent.filter(([method]) => method !== 'thread/read'),
    [
      ['transfer/authorizeRead', { sessionId: 's1', source: { kind: 'file', root: PROJECT, rel: 'out.bin' }, purpose: 'save' }],
      ['transfer/authorizeRead', { sessionId: 's2', source: { kind: 'sessionFile', path: 'C:/replay/a.bin' }, purpose: 'open' }],
      ['transfer/redeemGrant', { grantId: id }],
      ['transfer/readRange', { transferId: id, offset: 0, length: 4, version }],
      ['transfer/finishRead', { transferId: id }],
      ['transfer/endRead', { transferId: id }],
    ]
  );
});
