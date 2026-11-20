import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';

test('the cache warming getter is a read capability and the setter a registered non-read one', () => {
  assert.equal(DESKTOP_CAPABILITIES.includes('getCacheWarmingSettings'), true);
  assert.equal(DESKTOP_CAPABILITIES.includes('setCacheWarmingEnabled'), true);
  assert.equal(DESKTOP_READ_CAPABILITIES.includes('getCacheWarmingSettings'), true);
  assert.equal(DESKTOP_READ_CAPABILITIES.includes('setCacheWarmingEnabled'), false, 'a write is never a read');
  for (const list of [DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES]) {
    for (const name of ['getCacheWarmingSettings', 'setCacheWarmingEnabled']) {
      assert.ok(list.filter((entry) => entry === name).length <= 1, name);
    }
  }
});
