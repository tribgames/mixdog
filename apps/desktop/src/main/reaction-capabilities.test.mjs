import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { SECTION_READS } from '../renderer/settings/capability-data.ts';
import { CAPTURE_SETTINGS_VALUES } from './capture-host.ts';
import { SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS } from '../../../../src/standalone/session-protocol.mjs';
import { requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest } from './ipc-validation.ts';

test('the reactions getter is a read capability and the setter a configure one, in the contract and the session protocol', () => {
  assert.equal(DESKTOP_CAPABILITIES.includes('getReactionSettings'), true);
  assert.equal(DESKTOP_CAPABILITIES.includes('setReactionsEnabled'), true);
  assert.equal(DESKTOP_READ_CAPABILITIES.includes('getReactionSettings'), true);
  assert.equal(DESKTOP_READ_CAPABILITIES.includes('setReactionsEnabled'), false, 'a write is never a read');
  assert.equal(SESSION_READ_ACTIONS.includes('getReactionSettings'), true);
  assert.equal(SESSION_READ_ACTIONS.includes('setReactionsEnabled'), false);
  assert.equal(SESSION_CONFIGURE_ACTIONS.includes('setReactionsEnabled'), true);
  assert.equal(SESSION_CONFIGURE_ACTIONS.includes('getReactionSettings'), false);
  for (const list of [
    DESKTOP_CAPABILITIES,
    DESKTOP_READ_CAPABILITIES,
    SESSION_READ_ACTIONS,
    SESSION_CONFIGURE_ACTIONS,
  ]) {
    for (const name of ['getReactionSettings', 'setReactionsEnabled']) {
      assert.ok(list.filter((entry) => entry === name).length <= 1, name);
    }
  }
});

test('the settings page reads the reactions section with the getter, which is readable in a batch', () => {
  assert.deepEqual(
    SECTION_READS.filter(([key]) => key === 'reactions'),
    [['reactions', 'getReactionSettings']]
  );
  const [read] = requiredDesktopCapabilityReadRequests([{ capability: 'getReactionSettings', args: [] }]);
  assert.equal(read.capability, 'getReactionSettings');
  assert.throws(
    () => requiredDesktopCapabilityReadRequests([{ capability: 'setReactionsEnabled', args: [true] }]),
    /not read-only/
  );
  assert.deepEqual(CAPTURE_SETTINGS_VALUES.getReactionSettings, { reactions: true });
});

test('getReactionSettings takes no argument; setReactionsEnabled takes exactly one boolean', () => {
  assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'getReactionSettings' }), {
    capability: 'getReactionSettings',
    args: [],
  });
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'getReactionSettings', args: [true] }), TypeError);
  for (const value of [true, false]) {
    assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'setReactionsEnabled', args: [value] }).args, [
      value,
    ]);
  }
  for (const args of [[], [true, true], ['true'], [1], [null], [{}]]) {
    assert.throws(
      () => requiredDesktopCapabilityRequest({ capability: 'setReactionsEnabled', args }),
      TypeError,
      JSON.stringify(args)
    );
  }
});
