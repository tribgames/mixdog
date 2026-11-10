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

test('turn-scoped system message (tail reminder) errors are not effort-update rejections', () => {
  for (const text of [
    'messages.3.clear_at: Extra inputs are not permitted',
    "messages.3: a turn-scoped system message supports text blocks only (clear_at: 'next_user_message')",
    "messages.3: output_config is not permitted on a turn-scoped system message (clear_at: 'next_user_message')",
    "messages.3.content.0: cache_control is not permitted on a turn-scoped system message (clear_at: 'next_user_message')",
    'Unexpected value(s) `mid-conversation-system-clear-at-2026-08-21` for the `anthropic-beta` header.',
  ]) {
    assert.equal(isEffortConfigurationRejection(400, text), false, text);
  }
  // The effort-update errors themselves keep their classification.
  assert.equal(
    isEffortConfigurationRejection(400, 'output_config is not supported in mid-conversation messages'),
    true
  );
  assert.equal(
    isEffortConfigurationRejection(400, 'Unexpected value(s) `mid-conversation-output-config-2026-07-01`'),
    true
  );
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
