import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../../shared/contract.ts';
import { connectionFeatureGate } from '../connections/feature-gates.ts';
import { createRemoteMethods, executeRemoteFrame } from '../remote-methods.ts';
import { createRemoteApi } from '../../renderer/remote-shim-api.ts';
import { withShim } from '../../renderer/remote-shim-test-harness.mjs';

// The approval is a human-only gate on this PC: a paired web client must
// neither be shown the card nor be able to answer it.
test('the remote method table has no way to answer a browser approval', async () => {
  const methods = createRemoteMethods({ host: {} });
  for (const name of ['browserApproval', 'browserApprovalDecide', 'onBrowserApproval']) {
    assert.equal(Object.hasOwn(methods, name), false, name);
    const reply = await executeRemoteFrame(methods, JSON.stringify({ id: 1, method: name, params: ['x', true] }));
    assert.equal(reply.ok, false);
    assert.match(reply.error, /unknown method/);
  }
  assert.equal(
    Object.keys(methods).some((name) => /approval/i.test(name) && /browser/i.test(name)),
    false
  );
});

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
test('every call that can widen a bot is forwarded to the host marked no-widen', async () => {
  const calls = [];
  const methods = createRemoteMethods({
    host: { invokeCapability: async (capability, args) => calls.push([capability, args]) && { value: null } },
  });
  for (const [capability, args] of Object.entries(GUARDED)) {
    await methods.invokeCapability([{ capability, args }]);
    const [sent, forwarded] = calls.at(-1);
    assert.equal(sent, capability);
    assert.deepEqual(forwarded, [...args, { noWiden: true }], capability);
  }
  // A client cannot send (or omit) the mark: the argument count is fixed before it is added.
  await assert.rejects(async () =>
    methods.invokeCapability([
      { capability: 'setAgentConnectorEnabled', args: ['marketer', 'alpha', true, { noWiden: false }] },
    ])
  );
  // Reads and unrelated writes are forwarded as they came.
  await methods.invokeCapability([{ capability: 'getAgentPermissions', args: ['marketer'] }]);
  assert.deepEqual(calls.at(-1), ['getAgentPermissions', ['marketer']]);
});

test('a paired client cannot create a standing allow outright or write the audit', async () => {
  const calls = [];
  const methods = createRemoteMethods({
    host: { invokeCapability: async (capability, args) => calls.push([capability, args]) && { value: null } },
  });
  for (const [capability, args] of [
    ['setAgentPermission', ['marketer', 'browser_submit', 'allow']],
    ['setAgentPermission', ['marketer', 'browser_upload', 'allow']],
    ['recordAgentApprovalAudit', ['marketer', 'browser_submit', 'granted']],
    ['recordAgentApprovalAudit', ['marketer', 'browser_upload', 'granted']],
  ]) {
    await assert.rejects(
      async () => methods.invokeCapability([{ capability, args }]),
      /standing allow|not available over remote/,
      capability
    );
  }
  assert.deepEqual(calls, [], 'nothing reached the host');
});

test('a server window refuses the decide channel', () => {
  assert.equal(connectionFeatureGate('local', DESKTOP_IPC.browserApprovalDecide), null);
  assert.equal(connectionFeatureGate('ssh', DESKTOP_IPC.browserApprovalDecide)?.code, 'ssh-unsupported');
});
