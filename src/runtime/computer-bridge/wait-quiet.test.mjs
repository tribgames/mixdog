import assert from 'node:assert/strict';
import test from 'node:test';
import { validateComputerCoreActions } from './core-actions.mjs';
import { toComputerHostCommand, validateComputerToolArgs } from './action-schema.mjs';

const act = (wait) => ({
  action: 'act',
  input: { window_id: 'hwnd:0x1', actions: [{ type: 'key', keys: 'enter' }, wait] },
});

test('a wait in act is a fixed pause unless it opts in to quiet', () => {
  const fixed = toComputerHostCommand(act({ type: 'wait', duration: 2 }));
  assert.deepEqual(fixed.steps[1], { action: 'wait', duration: 2 });
  const quiet = toComputerHostCommand(act({ type: 'wait', duration: 2, quiet: true }));
  assert.equal(quiet.steps[1].quiet, true);
});

test('quiet is a boolean on wait only, and the 10 s total cap still holds', () => {
  assert.equal(validateComputerToolArgs(act({ type: 'wait', duration: 1, quiet: false })), null);
  assert.match(validateComputerCoreActions([{ type: 'key', keys: 'a' }, { type: 'wait', duration: 1, quiet: 'no' }]), /boolean/);
  assert.match(validateComputerCoreActions([{ type: 'key', keys: 'a', quiet: true }]), /does not accept field/);
  assert.match(
    validateComputerCoreActions([
      { type: 'key', keys: 'a' },
      { type: 'wait', duration: 5 },
      { type: 'wait', duration: 5 },
      { type: 'wait', duration: 1 },
    ]),
    /at most 10 total seconds/
  );
});
