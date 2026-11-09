// The remote surface's download stubs: gated on the host's `fileDownloads` advertisement (re-read per leg), handed to the protocol router
// as the Node method names, and failing with a typed reason the UI can show.
import assert from 'node:assert/strict';
import test from 'node:test';

import { fileDownloadErrorReason } from '../shared/file-downloads.ts';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

const REQUEST = { source: { kind: 'project', sessionId: 's1', relPath: 'out/report.pdf' }, purpose: 'save' };

test('a host that did not advertise fileDownloads refuses as host-too-old without a call', async () => {
  const handlers = {
    fileDownloadAuthorize: () => {
      throw Object.assign(new Error('No reply in this conversation links that file.'), { code: 'file-download:not-linked' });
    },
    fileDownloadRange: () => ({ length: 0 }),
  };
  await withPhoneApi(handlers, async ({ ctx, api, calls }) => {
    assert.equal(api.fileDownloads.available(), false);
    const refusal = await api.fileDownloads.authorize(REQUEST).catch((error) => error);
    assert.equal(fileDownloadErrorReason(refusal), 'host-too-old');
    assert.deepEqual(calls, [], 'nothing reached the adapter');

    ctx.peerFileDownloads = true;
    assert.equal(api.fileDownloads.available(), true);
    assert.equal(fileDownloadErrorReason(await api.fileDownloads.authorize(REQUEST).catch((error) => error)), 'not-linked');
    assert.deepEqual(calls.at(-1), { method: 'fileDownloadAuthorize', params: [REQUEST] });

    assert.deepEqual(await api.fileDownloads.readRange('t', 8, 16, 'v'), { length: 0 });
    assert.deepEqual(calls.at(-1), { method: 'fileDownloadRange', params: ['t', 8, 16, 'v'] });

    ctx.peerFileDownloads = undefined;
    assert.equal(api.fileDownloads.available(), false, 'a reconnect to an older host withdraws it');
  });
});

test('resolveLocalPaths forwards the conversation only when one is named', async () => {
  await withPhoneApi({ resolveLocalPaths: () => [] }, async ({ api, calls }) => {
    await api.resolveLocalPaths(['/x/a.pdf'], 's1');
    assert.deepEqual(calls.at(-1).params, [['/x/a.pdf'], 's1']);
    await api.resolveLocalPaths(['/x/a.pdf']);
    assert.deepEqual(calls.at(-1).params, [['/x/a.pdf']]);
  });
});
