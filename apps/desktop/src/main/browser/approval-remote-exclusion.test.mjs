import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../../shared/contract.ts';
import { connectionFeatureGate } from '../connections/feature-gates.ts';
import { createRemoteApi } from '../../renderer/remote-shim-api.ts';
import { withShim } from '../../renderer/remote-shim-test-harness.mjs';

// The approval is a human-only gate on this PC: a paired web client must
// neither be shown the card nor be able to answer it.
test('the remote renderer API neither listens for nor answers a browser approval', async () => {
  await withShim({}, async (shim) => {
    const api = createRemoteApi(shim.ctx);
    assert.equal(api.onBrowserApproval, undefined);
    assert.equal(api.browserApprovalDecide, undefined);
  });
});

const GUARDED = {
  setAgentPermission: ['marketer', 'browser_post', 'ask'],
  setAgentConnectorToolPermission: ['marketer', 'alpha', 'write_it', null],
  setAgentConnectorEnabled: ['marketer', 'alpha', true],
  setProjectConnectorEnabled: ['/work/app', 'alpha', true],
  setAgentConnectors: ['marketer', null],
  saveAgentDefinition: [{ id: 'marketer', name: 'm', body: 'b', connectors: null }],
};

// The widening judgement is the runtime writer's, atomic with its write
// (src/session-runtime/workflow-agents-api.no-widen.test.mjs). The remote table
// only has to mark every call that can widen, and a client cannot unmark it.
test('a server window refuses the decide channel', () => {
  assert.equal(connectionFeatureGate('local', DESKTOP_IPC.browserApprovalDecide), null);
  assert.equal(connectionFeatureGate('ssh', DESKTOP_IPC.browserApprovalDecide)?.code, 'ssh-unsupported');
});
