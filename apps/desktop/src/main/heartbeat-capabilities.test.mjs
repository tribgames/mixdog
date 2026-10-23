import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { SECTION_READS } from '../renderer/settings/capability-data.ts';
import { CAPTURE_SETTINGS_VALUES } from './capture-host.ts';
import { SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS } from '../../../../src/standalone/session-protocol.mjs';
import { requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest } from './ipc-validation.ts';

test('the heartbeat getter is a read capability and the setter a configure one, in the contract and the session protocol', () => {
  assert.equal(DESKTOP_CAPABILITIES.includes('getHeartbeatSettings'), true);
  assert.equal(DESKTOP_CAPABILITIES.includes('setHeartbeatEnabled'), true);
  assert.equal(DESKTOP_READ_CAPABILITIES.includes('getHeartbeatSettings'), true);
  assert.equal(DESKTOP_READ_CAPABILITIES.includes('setHeartbeatEnabled'), false, 'a write is never a read');
  assert.equal(SESSION_READ_ACTIONS.includes('getHeartbeatSettings'), true);
  assert.equal(SESSION_READ_ACTIONS.includes('setHeartbeatEnabled'), false);
  assert.equal(SESSION_CONFIGURE_ACTIONS.includes('setHeartbeatEnabled'), true);
  assert.equal(SESSION_CONFIGURE_ACTIONS.includes('getHeartbeatSettings'), false);
  // Once each: a duplicate would shadow or double-register the route.
  for (const list of [DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES, SESSION_READ_ACTIONS, SESSION_CONFIGURE_ACTIONS]) {
    for (const name of ['getHeartbeatSettings', 'setHeartbeatEnabled']) {
      assert.ok(list.filter((entry) => entry === name).length <= 1, name);
    }
  }
});

test('the settings page reads the heartbeat section with the getter, which is readable in a batch', () => {
  assert.deepEqual(
    SECTION_READS.filter(([key]) => key === 'heartbeat'),
    [['heartbeat', 'getHeartbeatSettings']]
  );
  const [read] = requiredDesktopCapabilityReadRequests([{ capability: 'getHeartbeatSettings', args: [] }]);
  assert.equal(read.capability, 'getHeartbeatSettings');
  assert.throws(
    () => requiredDesktopCapabilityReadRequests([{ capability: 'setHeartbeatEnabled', args: [true] }]),
    /not read-only/
  );
  // The screenshot host answers the section too, in the shape the panel reads.
  assert.deepEqual(CAPTURE_SETTINGS_VALUES.getHeartbeatSettings, { heartbeat: true });
});

test('getHeartbeatSettings takes no argument; setHeartbeatEnabled takes exactly one boolean', () => {
  assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'getHeartbeatSettings' }), {
    capability: 'getHeartbeatSettings',
    args: [],
  });
  assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'getHeartbeatSettings', args: [] }).args, []);
  for (const args of [[true], [false], [null]]) {
    assert.throws(
      () => requiredDesktopCapabilityRequest({ capability: 'getHeartbeatSettings', args }),
      TypeError,
      JSON.stringify(args)
    );
  }
  for (const value of [true, false]) {
    assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'setHeartbeatEnabled', args: [value] }).args, [value]);
  }
  for (const args of [[], [true, true], [true, false], ['true'], ['false'], [1], [0], [null], [{}], [[]]]) {
    assert.throws(
      () => requiredDesktopCapabilityRequest({ capability: 'setHeartbeatEnabled', args }),
      TypeError,
      JSON.stringify(args)
    );
  }
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'setHeartbeatEnabled' }), TypeError);
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'setHeartbeatEnabled', args: ['yes'] }), /boolean/);
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'setHeartbeatEnabledX', args: [true] }), TypeError);
});
