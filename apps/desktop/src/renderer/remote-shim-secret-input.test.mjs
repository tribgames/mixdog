import assert from 'node:assert/strict';
import test from 'node:test';

import { withPhoneApi } from './test-support/phone-api-rig.mjs';

test('paired clients can cancel a handoff or approve ordinary work but never offer secret entry', async () => {
  await withPhoneApi(
    { provideSecretInput: () => true, resolveToolApprovalForSession: () => true },
    async ({ ctx, api, calls }) => {
      ctx.e2eePairing = { version: 1, serverPublicKey: 'fake-key', pairingSecret: 'fake-pairing' };
      ctx.peerSecretInput = true;
      assert.equal(typeof api.provideSecretInput, 'undefined', 'an old host flag cannot enable the credential field');

      const cancel = { approved: false, response: 'skip' };
      const allow = { approved: true };
      assert.equal(await api.resolveToolApprovalForSession('session', 'handoff', cancel), true);
      assert.equal(await api.resolveToolApprovalForSession('session', 'ordinary', allow), true);
      assert.deepEqual(calls, [
        { method: 'resolveToolApprovalForSession', params: ['session', 'handoff', cancel] },
        { method: 'resolveToolApprovalForSession', params: ['session', 'ordinary', allow] },
      ]);
    }
  );
});
