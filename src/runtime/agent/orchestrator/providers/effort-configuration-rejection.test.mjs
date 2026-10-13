import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEffortConfigurationRejection } from './effort-configuration.mjs';

test('mid-conversation effort-update rejections are recognized', () => {
  assert.equal(
    isEffortConfigurationRejection(400, 'output_config is not supported in mid-conversation messages'),
    true
  );
  assert.equal(
    isEffortConfigurationRejection(400, "Unsupported item type configuration_update with output_config.effort 'high'"),
    true
  );
  assert.equal(isEffortConfigurationRejection(400, 'reasoning_effort_update is not supported'), true);
  assert.equal(isEffortConfigurationRejection(400, 'output_config: Extra inputs are not permitted'), true);
});

test('a rejected output_config.effort value is left to the effort-rejection fallback', () => {
  assert.equal(
    isEffortConfigurationRejection(
      400,
      "output_config.effort: Input should be 'low', 'medium', 'high' or 'max'. Got 'xhigh'."
    ),
    false
  );
  assert.equal(
    isEffortConfigurationRejection(500, 'output_config is not supported in mid-conversation messages'),
    false
  );
});
