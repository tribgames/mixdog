import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../../shared/contract.ts';
import { connectionFeatureGate } from '../connections/feature-gates.ts';
import { withPhoneApi } from '../../renderer/test-support/phone-api-rig.mjs';

// The approval is a human-only gate on this PC: a paired web client must
// neither be shown the card nor be able to answer it.
test('the remote renderer API neither listens for nor answers a browser approval', async () => {
  await withPhoneApi({}, async ({ api }) => {
    assert.equal(api.onBrowserApproval, undefined);
    assert.equal(api.browserApprovalDecide, undefined);
  });
});

test('a server window refuses the decide channel', () => {
  assert.equal(connectionFeatureGate('local', DESKTOP_IPC.browserApprovalDecide), null);
  assert.equal(connectionFeatureGate('ssh', DESKTOP_IPC.browserApprovalDecide)?.code, 'ssh-unsupported');
});
