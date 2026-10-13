// The remote surface's download stubs: gated on the host's `fileDownloads`
// advertisement (re-read per leg), forwarded verbatim on the encrypted RPC
// lane, and failing with a typed reason the UI can show.
import assert from 'node:assert/strict';
import test from 'node:test';

import { fileDownloadErrorReason } from '../shared/file-downloads.ts';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

const REQUEST = { source: { kind: 'project', sessionId: 's1', relPath: 'out/report.pdf' }, purpose: 'save' };

const redial = (shim, flags) => {
  shim.ctx.connectionReady = false;
  shim.ctx.socket = null;
  shim.ctx.openPromise = null;
  return shim.dial({ remoteParity: true, ...flags, ready: publishedCeilings(4096, 4096) });
};

const nextCall = async (leg, method) => {
  let frame = await leg.nextPayload();
  while (frame.method !== method) frame = await leg.nextPayload();
  return frame;
};

test('a host that did not advertise fileDownloads refuses as host-too-old without a call', async () => {
  await withShim({}, async (shim) => {
    shim.ctx.updaterListeners = new Set();
    shim.ctx.settingsChangedListeners = new Set();
    const api = createRemoteApi(shim.ctx);
    const leg = await shim.dial({ remoteParity: true, ready: publishedCeilings(4096, 4096) });
    const sentBefore = leg.ws.sent.length;
    assert.equal(api.fileDownloads.available(), false);
    const refusal = await api.fileDownloads.authorize(REQUEST).catch((error) => error);
    assert.equal(fileDownloadErrorReason(refusal), 'host-too-old');
    assert.equal(leg.ws.sent.length, sentBefore, 'nothing went on the wire');

    const current = await redial(shim, { fileDownloads: true });
    assert.equal(api.fileDownloads.available(), true);
    const pending = api.fileDownloads.authorize(REQUEST).catch((error) => error);
    const frame = await nextCall(current, 'fileDownloadAuthorize');
    assert.deepEqual(frame.params, [REQUEST]);
    await current.deliver({
      id: frame.id,
      ok: false,
      error: 'No reply in this conversation links that file.',
      errorCode: 'file-download:not-linked',
    });
    assert.equal(fileDownloadErrorReason(await pending), 'not-linked');

    const range = api.fileDownloads.readRange('t', 8, 16, 'v');
    const rangeFrame = await nextCall(current, 'fileDownloadRange');
    assert.deepEqual(rangeFrame.params, ['t', 8, 16, 'v']);
    await current.deliver({ id: rangeFrame.id, ok: true, value: { length: 0 } });
    assert.deepEqual(await range, { length: 0 });

    await redial(shim, {});
    assert.equal(api.fileDownloads.available(), false, 'a reconnect to an older host withdraws it');
  });
});

test('resolveLocalPaths forwards the conversation only when one is named', async () => {
  await withShim({}, async (shim) => {
    shim.ctx.updaterListeners = new Set();
    shim.ctx.settingsChangedListeners = new Set();
    const api = createRemoteApi(shim.ctx);
    const leg = await shim.dial({ remoteParity: true, fileDownloads: true, ready: publishedCeilings(4096, 4096) });
    const named = api.resolveLocalPaths(['/x/a.pdf'], 's1');
    const namedFrame = await nextCall(leg, 'resolveLocalPaths');
    assert.deepEqual(namedFrame.params, [['/x/a.pdf'], 's1']);
    await leg.deliver({ id: namedFrame.id, ok: true, value: [] });
    await named;
    const plain = api.resolveLocalPaths(['/x/a.pdf']);
    const plainFrame = await nextCall(leg, 'resolveLocalPaths');
    assert.deepEqual(plainFrame.params, [['/x/a.pdf']]);
    await leg.deliver({ id: plainFrame.id, ok: true, value: [] });
    await plain;
  });
});
