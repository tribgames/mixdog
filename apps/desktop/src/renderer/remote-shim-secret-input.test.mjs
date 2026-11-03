// A handoff secret typed on the phone (ApprovalCard secret card): the shim
// offers `provideSecretInput` only over the encrypted channel to a host that
// advertised `secretInput`, re-read per leg, and the value leaves this page in
// that one sealed call frame, retained nowhere.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteApi } from './remote-shim-api.ts';
import { FakeSocket, publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

const REQUEST_ID = 'secret_p10123456789';
const CODE = '482190';

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

/** Everything this page put on any socket, as text (frames are sealed bytes). */
const wireText = () =>
  FakeSocket.instances
    .flatMap((ws) => ws.sent)
    .map((frame) => (typeof frame === 'string' ? frame : Buffer.from(frame).toString('latin1')))
    .join('\n');

test('the phone offers secret entry only over the encrypted channel to a host that takes it', async () => {
  await withShim({}, async (shim) => {
    shim.ctx.updaterListeners = new Set();
    shim.ctx.settingsChangedListeners = new Set();
    const api = createRemoteApi(shim.ctx);
    const old = await shim.dial({ remoteParity: true, ready: publishedCeilings(4096, 4096) });
    const sentBefore = old.ws.sent.length;
    assert.equal(api.provideSecretInput, undefined, 'an older PC: the card keeps "Enter it on your PC"');
    assert.equal(old.ws.sent.length, sentBefore, 'nothing went on the wire');

    const current = await redial(shim, { secretInput: true });
    assert.equal(typeof api.provideSecretInput, 'function');

    const pending = api.provideSecretInput(REQUEST_ID, CODE);
    const frame = await nextCall(current, 'provideSecretInput');
    assert.deepEqual(frame.params, [REQUEST_ID, CODE], 'the PC receives the value in this one call');
    assert.equal(wireText().includes(CODE), false, 'sealed: the value is never in the clear on the socket');
    await current.deliver({ id: frame.id, ok: true, value: true });
    assert.equal(await pending, true);

    // The PC refuses (a stale id, a missing window): the phone sees plain false.
    const refused = api.provideSecretInput('secret_gone0123456789', CODE);
    const refusedFrame = await nextCall(current, 'provideSecretInput');
    await current.deliver({ id: refusedFrame.id, ok: true, value: false });
    assert.equal(await refused, false);

    await redial(shim, {});
    assert.equal(api.provideSecretInput, undefined, 'a reconnect to an older PC withdraws it');
  });
});

test('the legacy unencrypted mode never offers secret entry', async () => {
  await withShim({ secure: false }, async (shim) => {
    shim.ctx.updaterListeners = new Set();
    shim.ctx.settingsChangedListeners = new Set();
    const api = createRemoteApi(shim.ctx);
    await shim.dial({ remoteParity: true });
    // Even a host flag that reached the context cannot make it plaintext-capable.
    shim.ctx.peerSecretInput = true;
    assert.equal(api.provideSecretInput, undefined);
  });
});

test('a secret call goes out ahead of the view sync like the approval decision', async () => {
  await withShim({}, async (shim) => {
    shim.ctx.updaterListeners = new Set();
    shim.ctx.settingsChangedListeners = new Set();
    const api = createRemoteApi(shim.ctx);
    const leg = await shim.dial({ remoteParity: true, secretInput: true, ready: publishedCeilings(4096, 4096) });
    shim.ctx.peerViewSync = true;
    shim.ctx.viewSync.ready = () => new Promise(() => {});
    const pending = api.provideSecretInput(REQUEST_ID, CODE);
    const frame = await nextCall(leg, 'provideSecretInput');
    await leg.deliver({ id: frame.id, ok: true, value: true });
    assert.equal(await pending, true, 'not held behind a view sync that never lands');
  });
});
