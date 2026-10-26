import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS } from '../../../../src/standalone/session-protocol.mjs';

// The settings card reads and writes cache warming through the session
// protocol; an action missing there is refused as "unavailable".
test('the cache warming getter is a read action and the setter a configure one, in the contract and the session protocol', () => {
  assert.equal(DESKTOP_CAPABILITIES.includes('getCacheWarmingSettings'), true);
  assert.equal(DESKTOP_CAPABILITIES.includes('setCacheWarmingEnabled'), true);
  assert.equal(DESKTOP_READ_CAPABILITIES.includes('getCacheWarmingSettings'), true);
  assert.equal(DESKTOP_READ_CAPABILITIES.includes('setCacheWarmingEnabled'), false, 'a write is never a read');
  assert.equal(SESSION_READ_ACTIONS.includes('getCacheWarmingSettings'), true);
  assert.equal(SESSION_READ_ACTIONS.includes('setCacheWarmingEnabled'), false);
  assert.equal(SESSION_CONFIGURE_ACTIONS.includes('setCacheWarmingEnabled'), true);
  assert.equal(SESSION_CONFIGURE_ACTIONS.includes('getCacheWarmingSettings'), false);
  for (const list of [DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES, SESSION_READ_ACTIONS, SESSION_CONFIGURE_ACTIONS]) {
    for (const name of ['getCacheWarmingSettings', 'setCacheWarmingEnabled']) {
      assert.ok(list.filter((entry) => entry === name).length <= 1, name);
    }
  }
});
