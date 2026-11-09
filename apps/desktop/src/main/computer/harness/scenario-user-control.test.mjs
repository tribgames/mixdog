import assert from 'node:assert/strict';
import test from 'node:test';
import { isScenarioUserControl } from './scenario-user-control.ts';
import { computerErrorCode } from '../../../shared/core-src/runtime/computer-bridge/error-code.mjs';

test('native refusals and parked bridge replies both mean the user owns the desktop', () => {
  for (const code of ['user_input_active', 'computer_user_control_active', 'computer_user_intervention_pending']) {
    assert.equal(isScenarioUserControl(code), true);
    assert.equal(isScenarioUserControl(computerErrorCode(new Error(`${code}: interrupted`))), true);
  }
});

test('observer failures and unrelated recapture requests remain distinct from user control', () => {
  for (const code of [
    'input_observation_unavailable',
    'input_observer_unavailable',
    'computer_resume_recapture_required',
    'pixel_unavailable',
    undefined,
  ]) {
    assert.equal(isScenarioUserControl(code), false);
  }
});
