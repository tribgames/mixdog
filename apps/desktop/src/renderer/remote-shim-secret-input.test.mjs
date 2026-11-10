// A handoff secret typed on the phone (ApprovalCard secret card): the shim
// offers `provideSecretInput` only over the encrypted channel to a host that
// advertised `secretInput`, re-read per leg, and the value leaves this page in
// that one call, retained nowhere.
//
// Node's version of this test (b6f10295a) set the flags from the relay challenge, read the calls off a fake relay socket and held the view
// sync with the shim's `viewSync.ready`. Here the table (remote-shim-api.ts provideSecretInput, Node :611-620) and the router are the
// product's: the flag is the context's `peerSecretInput` (the phone sets it from the core's capabilities each time a connection is ready,
// apps/mobile/src/phone-boot.ts applyFlags, phone-capabilities.ts peerFlagsOf), the encrypted pairing is `ctx.e2eePairing`, what Node read off
// the socket is what reached the adapter that owns the name, and the view sync is the router's `synced` gate (Node: remote-shim-calls.ts
// UNGATED_CALLS, :13-19 and :300-301; today remote-shim-protocol.ts UNGATED_CALLS). Node's check that the code never appears in the clear on
// the socket belongs to the connection: the phone's relay connector seals every application frame (apps/mobile/src/relay-connector.ts) and has
// no unencrypted mode.
import assert from 'node:assert/strict';
import test from 'node:test';

import { withPhoneApi } from './test-support/phone-api-rig.mjs';

const REQUEST_ID = 'secret_p10123456789';
const CODE = '482190';
/** A paired page's encrypted pairing (the table reads only its presence). */
const PAIRING = { version: 1, serverPublicKey: 'server-public-key', pairingSecret: 'pairing-secret' };

/** `promise`, or a failure naming `what` once 5 s pass without it. */
const within = (promise, what) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within 5 s`)), 5_000);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

test('the phone offers secret entry only over the encrypted channel to a host that takes it', async () => {
  const answers = [true, false];
  await withPhoneApi({ provideSecretInput: () => answers.shift() }, async ({ ctx, api, calls }) => {
    ctx.e2eePairing = PAIRING;
    assert.equal(api.provideSecretInput, undefined, 'an older PC: the card keeps "Enter it on your PC"');
    assert.deepEqual(calls, [], 'nothing went on the wire');

    ctx.peerSecretInput = true;
    assert.equal(typeof api.provideSecretInput, 'function');

    assert.equal(await api.provideSecretInput(REQUEST_ID, CODE), true);
    assert.deepEqual(calls, [{ method: 'provideSecretInput', params: [REQUEST_ID, CODE] }], 'the PC receives the value in this one call');

    // The PC refuses (a stale id, a missing window): the phone sees plain false.
    assert.equal(await api.provideSecretInput('secret_gone0123456789', CODE), false);

    ctx.peerSecretInput = false;
    assert.equal(api.provideSecretInput, undefined, 'a reconnect to an older PC withdraws it');
  });
});

test('the legacy unencrypted mode never offers secret entry', async () => {
  await withPhoneApi({ provideSecretInput: () => true }, async ({ ctx, api }) => {
    assert.equal(ctx.e2eePairing, null);
    // Even a host flag that reached the context cannot make it plaintext-capable.
    ctx.peerSecretInput = true;
    assert.equal(api.provideSecretInput, undefined);
  });
});

test('a secret call goes out ahead of the view sync like the approval decision', async () => {
  await withPhoneApi(
    { provideSecretInput: () => true },
    async ({ ctx, api }) => {
      ctx.e2eePairing = PAIRING;
      ctx.peerSecretInput = true;
      const answered = await within(api.provideSecretInput(REQUEST_ID, CODE), 'the secret call held by a view sync that never lands');
      assert.equal(answered, true, 'not held behind a view sync that never lands');
    },
    { synced: () => new Promise(() => {}) }
  );
});
