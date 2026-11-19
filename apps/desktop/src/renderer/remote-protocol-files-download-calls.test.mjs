// The phone's download calls on the files adapter (remote-protocol-files.ts): which request each call makes of the core, and which
// argument the adapter refuses without sending anything. Inputs are inline; each expectation follows the rule in the adapter.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter } from './remote-protocol-files.ts';

const GRANT = '00000000-0000-4000-8000-000000000001';
const VERSION = 'A'.repeat(43);
const PURPOSE = 'save';

function scripted(replies = {}) {
  const sent = [];
  const client = { call: async (method, params) => (sent.push({ method, params }), replies[method] ?? {}) };
  const host = { ctx: {}, client: () => client, declareLane() {} };
  return { sent, host, call: async (name, args) => adapter.calls[name](args, host) };
}

test('authorize names the conversation and the source the core resolves, by the source kind', async () => {
  const sources = [
    [{ kind: 'project', sessionId: 's1', relPath: 'src/a.txt' }, { kind: 'file', rel: 'src/a.txt' }],
    [{ kind: 'session', sessionId: 's1', path: 'C:/work/out.log' }, { kind: 'sessionFile', path: 'C:/work/out.log' }],
    [{ kind: 'folder', sessionId: 's1', path: 'C:/work' }, { kind: 'folder', path: 'C:/work' }],
    [{ kind: 'media', sessionId: 's1', assetId: 'asset_1' }, { kind: 'mediaAsset', assetId: 'asset_1' }],
    [{ kind: 'link', sessionId: 's1', itemId: 'i1', href: 'https://example.test/f' }, { kind: 'link', itemId: 'i1', href: 'https://example.test/f' }],
    [{ kind: 'attachment', sessionId: 's1', attachmentId: 'a'.repeat(64) }, { kind: 'attachment', attachmentId: 'a'.repeat(64) }],
  ];
  for (const [source, wire] of sources) {
    const { sent, call } = scripted();
    await call('fileDownloadAuthorize', [{ source, purpose: PURPOSE }]);
    assert.deepEqual(sent, [{ method: 'transfer/authorizeRead', params: { sessionId: 's1', source: wire, purpose: 'save' } }], source.kind);
  }
});

test('an authorize request the adapter refuses sends nothing', async () => {
  const bad = [
    [null, 'download request is invalid.'],
    [{ source: null, purpose: 'save' }, 'download source is invalid.'],
    [{ source: { kind: 'project', sessionId: 's1', relPath: 'a' }, purpose: 'nope' }, 'download purpose is invalid.'],
    [{ source: { kind: 'project', sessionId: 'bad id', relPath: 'a' }, purpose: 'save' }, 'session id is invalid.'],
    [{ source: { kind: 'project', sessionId: 's1', relPath: '/etc/passwd' }, purpose: 'save' }, 'relPath must be project-relative.'],
    [{ source: { kind: 'project', sessionId: 's1', relPath: 'C:\\x' }, purpose: 'save' }, 'relPath must be project-relative.'],
    [{ source: { kind: 'attachment', sessionId: 's1', attachmentId: 'short' }, purpose: 'save' }, 'attachment id is invalid.'],
    [{ source: { kind: 'media', sessionId: 's1', assetId: 'bad/id' }, purpose: 'save' }, 'asset id is invalid.'],
    [{ source: { kind: 'zip', sessionId: 's1' }, purpose: 'save' }, 'download source is invalid.'],
  ];
  for (const [request, message] of bad) {
    const { sent, call } = scripted();
    await assert.rejects(call('fileDownloadAuthorize', [request]), { name: 'TypeError', message }, JSON.stringify(request));
    assert.deepEqual(sent, []);
  }
});

test('begin, range and finish pass a well-formed id to the core and refuse a malformed one', async () => {
  const { sent, call } = scripted();
  await call('fileDownloadBegin', [GRANT]);
  await call('fileDownloadRange', [GRANT, 0, 1024, VERSION]);
  await call('fileDownloadFinish', [GRANT]);
  assert.deepEqual(sent, [
    { method: 'transfer/redeemGrant', params: { grantId: GRANT } },
    { method: 'transfer/readRange', params: { transferId: GRANT, offset: 0, length: 1024, version: VERSION } },
    { method: 'transfer/finishRead', params: { transferId: GRANT } },
  ]);
  const refused = scripted();
  await assert.rejects(refused.call('fileDownloadBegin', ['nope']), { message: 'grant id is invalid.' });
  await assert.rejects(refused.call('fileDownloadFinish', ['nope']), { message: 'transfer id is invalid.' });
  await assert.rejects(refused.call('fileDownloadRange', [GRANT, -1, 10, VERSION]), { message: 'offset is invalid.' });
  await assert.rejects(refused.call('fileDownloadRange', [GRANT, 0, 0, VERSION]), { message: 'length is invalid.' });
  await assert.rejects(refused.call('fileDownloadRange', [GRANT, 0, 10, 'short']), { message: 'version is invalid.' });
  assert.deepEqual(refused.sent, []);
});

test('a range one byte over the public 4 MiB limit is refused before acquiring transport', async () => {
  const client = test.mock.fn(() => assert.fail('an oversized range must not acquire transport'));
  await assert.rejects(
    async () => adapter.calls.fileDownloadRange([GRANT, 0, 4 * 1024 * 1024 + 1, VERSION], { client }),
    { name: 'TypeError', message: 'length is invalid.' }
  );
  assert.equal(client.mock.callCount(), 0);
});

test('abort of an id that is no export of ours ends the core\'s transfer and answers whether it ended', async () => {
  const { sent, call } = scripted({ 'transfer/endRead': { ended: true } });
  assert.equal(await call('fileDownloadAbort', [GRANT]), true);
  assert.deepEqual(sent, [{ method: 'transfer/endRead', params: { transferId: GRANT } }]);
});