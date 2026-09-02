import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRepeatedScenariosPassed,
  repeatRequiresPass,
} from '../../../../scripts/computer-host-repeat-policy.mjs';

test('Computer Use repeat require-pass policy fails closed on scenario failures', () => {
  assert.equal(repeatRequiresPass(['node', 'runner', '--require-pass'], {}), true);
  assert.equal(repeatRequiresPass(['node', 'runner', '--require-pass=true'], {}), true);
  assert.equal(repeatRequiresPass(['node', 'runner'], { npm_config_require_pass: 'true' }), true);
  assert.equal(repeatRequiresPass(['node', 'runner'], {}), false);
  assert.throws(
    () => assertRepeatedScenariosPassed({ failed: 2 }, true),
    /2 repeated Computer Use scenarios failed/,
  );
  assert.doesNotThrow(() => assertRepeatedScenariosPassed({ failed: 2 }, false));
  assert.doesNotThrow(() => assertRepeatedScenariosPassed({ failed: 0 }, true));
});
