// Per-agent connector methods reach the host the same way over IPC (the
// desktop's invokeCapability / readCapabilities) and over remote access (a
// paired phone calls the same remote methods): same validation, same host call.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest } from './ipc-validation.ts';
import { SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS } from './test-support/session-protocol-actions.recorded.mjs';

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

test('a wrong argument count is refused before the host is reached', () => {
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'setAgentConnectors', args: ['a'] }), TypeError);
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'setAgentConnectorToolPermission', args: ['a', 'b'] }),
    TypeError
  );
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'listConnectors', args: ['x'] }), TypeError);
});