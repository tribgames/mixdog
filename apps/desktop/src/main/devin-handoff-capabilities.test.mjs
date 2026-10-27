import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES } from '../shared/contract.ts';
import { SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS } from '../../../../src/standalone/session-protocol.mjs';
import { requiredDesktopCapabilityRequest } from './ipc-validation.ts';

// The daemon dispatches session actions through SESSION_CONFIGURE_ACTIONS:
// a capability missing from it answers "session action <name> is unavailable".
test('devinHandoff is a session configure action end to end', () => {
  assert.equal(DESKTOP_CAPABILITIES.includes('devinHandoff'), true);
  assert.equal(SESSION_CONFIGURE_ACTIONS.includes('devinHandoff'), true);
  assert.equal(SESSION_READ_ACTIONS.includes('devinHandoff'), false);
  for (const list of [DESKTOP_CAPABILITIES, SESSION_READ_ACTIONS, SESSION_CONFIGURE_ACTIONS]) {
    assert.ok(list.filter((entry) => entry === 'devinHandoff').length <= 1);
  }
});

test('devinHandoff accepts zero args or one options object', () => {
  assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'devinHandoff' }).args, []);
  assert.deepEqual(
    requiredDesktopCapabilityRequest({ capability: 'devinHandoff', args: [{ launch: 'none' }] }).args,
    [{ launch: 'none' }]
  );
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'devinHandoff', args: [{}, {}] }), TypeError);
});
