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

test('ref clicks preserve click intent and the explicitly requested delivery', () => {
  for (const delivery of ['foreground', 'background']) {
    const command = toComputerHostCommand({
      action: 'act',
      input: {
        window_id: 'hwnd:0x1',
        delivery,
        actions: [{ type: 'click', ref: 's1:e0' }],
      },
    });
    assert.equal(command.delivery, delivery);
    assert.equal(command.steps[0].action, 'click');
    assert.equal(command.steps[0].ref, 's1:e0');
  }
});

test('an act can ask for an accessibility-only observation instead of a frame', () => {
  const args = {
    action: 'act',
    input: { window_id: 'hwnd:0x1', actions: [{ type: 'click', ref: 's1:e0' }], observe: 'ax' },
  };
  assert.equal(validateComputerToolArgs(args), null);
  const command = toComputerHostCommand(args);
  assert.equal(command.capture_after_mode, 'ax');
  assert.equal(command.observe, undefined);
  // The default stays the full observation, and only the two modes are offered.
  assert.equal(
    toComputerHostCommand({ action: 'act', input: { actions: [{ type: 'key', keys: 'enter' }] } }).capture_after_mode,
    undefined
  );
  assert.match(
    validateComputerToolArgs({ ...args, input: { ...args.input, observe: 'vision' } }),
    /observe|enum|allowed/i
  );
});
