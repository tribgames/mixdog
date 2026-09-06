import assert from 'node:assert/strict';
import test from 'node:test';
import { validateComputerToolArgs, toComputerHostCommand } from './action-schema.mjs';
import { computerToolErrorRecovery } from './error-recovery.mjs';

test('user wait accepts only a bounded timeout and cannot smuggle a resume grant', () => {
  const args = { action: 'wait_for_user', input: { timeout_ms: 120000 } };
  assert.equal(validateComputerToolArgs(args), null);
  assert.deepEqual(toComputerHostCommand(args), { action: 'wait_for_user', timeout_ms: 120000 });
  assert.match(validateComputerToolArgs({ ...args, input: { timeout_ms: 120001 } }), /at most/);
  assert.match(validateComputerToolArgs({ ...args, input: { resume: true } }), /does not accept/);
  assert.equal(computerToolErrorRecovery('computer_user_control_active: paused').next, 'wait_for_user');
});
