// A handoff secret typed on the phone (ApprovalCard secret card): the page offers `provideSecretInput` only over the encrypted channel to a
// host that advertised `secretInput` (re-read per leg), and the value leaves the page in that one call. Ported from the Node-socket test onto
// the phone API rig: the same assertions of the page's behavior, with the adapter standing where the relay socket did.
// Not ported: "the value is never in the clear on the socket" -- the sealing is the transport's (apps/mobile relay-connector, recorded in
// phone-lifecycle/transport.json), below this page code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtocolRouter } from './remote-shim-protocol.ts';
import { settle, withPhoneApi } from './test-support/phone-api-rig.mjs';

// The router's call deadline reads the page's timers (remote-shim-call-watch.ts); the rig's window exists only inside withPhoneApi.
globalThis.window ??= globalThis;

const REQUEST_ID = 'secret_p10123456789';
const CODE = '482190';

test('the phone offers secret entry only over the encrypted channel to a host that takes it', async () => {
  const answers = [true, false];
  await withPhoneApi({ provideSecretInput: () => answers.shift() }, async ({ ctx, api, calls }) => {
    ctx.e2eePairing = true;
    ctx.peerSecretInput = false;
    assert.equal(api.provideSecretInput, undefined, 'an older PC: the card keeps "Enter it on your PC"');
    await settle();
    assert.deepEqual(calls, [], 'nothing was asked of the host');

    ctx.peerSecretInput = true;
    assert.equal(typeof api.provideSecretInput, 'function');
    assert.equal(await api.provideSecretInput(REQUEST_ID, CODE), true);
    assert.deepEqual(calls, [{ method: 'provideSecretInput', params: [REQUEST_ID, CODE] }], 'the host receives the value in this one call');

    // The PC refuses (a stale id, a missing window): the phone sees plain false.
    assert.equal(await api.provideSecretInput('secret_gone0123456789', CODE), false);

    ctx.peerSecretInput = false;
    assert.equal(api.provideSecretInput, undefined, 'a reconnect to an older PC withdraws it');
  });
});

test('the legacy unencrypted mode never offers secret entry', async () => {
  await withPhoneApi({ provideSecretInput: () => true }, async ({ ctx, api }) => {
    ctx.e2eePairing = false;
    // Even a host flag that reached the context cannot make it plaintext-capable.
    ctx.peerSecretInput = true;
    assert.equal(api.provideSecretInput, undefined);
  });
});

test('a secret call goes out ahead of the view sync like the approval decision', async () => {
  const handled = [];
  const never = new Promise(() => {});
  const router = createProtocolRouter(
    [{ group: 'test', calls: { provideSecretInput: (params) => (handled.push(params), true), markSessionRead: () => true } }],
    { host: { ctx: {}, client: () => null, declareLane() {} }, started: async () => undefined, synced: () => never, probe() {}, silentSince: () => false }
  );
  const held = router.call('markSessionRead', ['s', 1, false]);
  assert.equal(await router.call('provideSecretInput', [REQUEST_ID, CODE]), true, 'not held behind a view sync that never lands');
  assert.deepEqual(handled, [[REQUEST_ID, CODE]]);
  const outcome = await Promise.race([held.then(() => 'answered'), settle().then(() => 'held')]);
  assert.equal(outcome, 'held', 'an ordinary call still waits for the sync');
});
