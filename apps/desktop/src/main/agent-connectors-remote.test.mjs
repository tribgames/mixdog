// Per-agent connector methods reach the host the same way over IPC (the
// desktop's invokeCapability / readCapabilities) and over remote access (a
// paired phone calls the same remote methods): same validation, same host call.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest } from './ipc-validation.ts';
import { assertRemoteCapability, createRemoteMethods } from './remote-methods.ts';
import { SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS } from '../../../../src/standalone/session-protocol.mjs';

const READS = {
  getAgentConnectors: ['github-watcher'],
  getAgentConnectorTools: ['github-watcher'],
  listConnectors: [],
  listConnectorTools: ['github'],
  getProjectConnectors: ['C:\\work\\app'],
};
const WRITES = {
  setAgentConnectors: ['github-watcher', { off: ['notion'], tools: { github: { create_issue: 'disabled' } } }],
  setAgentConnectorEnabled: ['github-watcher', 'notion', false],
  setAgentConnectorToolPermission: ['github-watcher', 'github', 'create_issue', 'needs_approval'],
  setProjectConnectorEnabled: ['C:\\work\\app', 'notion', false],
};

test('every connector method is a desktop capability, a remote capability and a session action', () => {
  for (const capability of Object.keys(READS)) {
    assert.ok(DESKTOP_READ_CAPABILITIES.includes(capability), `${capability} is a read capability`);
    assert.ok(SESSION_READ_ACTIONS.includes(capability), `${capability} is a session read action`);
  }
  for (const capability of [...Object.keys(READS), ...Object.keys(WRITES)]) {
    assert.ok(DESKTOP_CAPABILITIES.includes(capability), `${capability} is a capability`);
    assert.doesNotThrow(() => assertRemoteCapability(capability), capability);
  }
  for (const capability of Object.keys(WRITES)) {
    assert.ok(SESSION_CONFIGURE_ACTIONS.includes(capability), `${capability} is a session configure action`);
    assert.ok(!DESKTOP_READ_CAPABILITIES.includes(capability), `${capability} is not a read`);
  }
});

test('the phone and the desktop send the same validated call to the host', async () => {
  const hostCalls = [];
  const host = {
    invokeCapability: async (capability, args, sessionId) => {
      hostCalls.push([capability, args, sessionId]);
      return { value: null };
    },
    readCapabilities: async (requests) => {
      // The remote host's own pre-write comparison reads (remote-authority.ts) are not the call under test.
      for (const request of requests) {
        if (request.capability === 'getAgentConnectorPolicy' || request.capability === 'getAgentPermissions') continue;
        hostCalls.push([request.capability, request.args, undefined]);
      }
      return requests.map(() => ({ ok: true, value: null }));
    },
  };
  const remote = createRemoteMethods({ host });
  for (const [capability, args] of Object.entries(WRITES)) {
    const desktop = requiredDesktopCapabilityRequest({ capability, args });
    await host.invokeCapability(desktop.capability, desktop.args, desktop.sessionId);
    await remote.invokeCapability([{ capability, args }]);
    // The phone's call is the desktop's plus the host's no-widen mark on the authority setters
    // (the runtime writer judges it atomically; see approval-remote-exclusion.test.mjs).
    const [sent, sentArgs, sentSession] = hostCalls.at(-1);
    const unmarked = sentArgs.at(-1)?.noWiden === true ? sentArgs.slice(0, -1) : sentArgs;
    assert.deepEqual([sent, unmarked, sentSession], hostCalls.at(-2), capability);
  }
  for (const [capability, args] of Object.entries(READS)) {
    const desktop = requiredDesktopCapabilityReadRequests([{ capability, args }]);
    await host.readCapabilities(desktop);
    await remote.readCapabilities([[{ capability, args }]]);
    assert.deepEqual(hostCalls.at(-1), hostCalls.at(-2), capability);
  }
});

test('a wrong argument count is refused before the host is reached', () => {
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'setAgentConnectors', args: ['a'] }), TypeError);
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'setAgentConnectorToolPermission', args: ['a', 'b'] }),
    TypeError
  );
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'listConnectors', args: ['x'] }), TypeError);
});
