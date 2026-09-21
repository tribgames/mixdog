import assert from 'node:assert/strict';
import test from 'node:test';
import { validateComputerCoreActions } from './core-actions.mjs';
import { toComputerHostCommand, validateComputerToolArgs } from './action-schema.mjs';

test('set_value writes a control through its element, with no focus and no keystrokes', () => {
  assert.equal(validateComputerCoreActions([{ type: 'set_value', ref: 'uia:1', value: 'round1.txt' }]), null);
  assert.equal(validateComputerCoreActions([{ type: 'set_value', element: 3, value: '' }]), null);
  assert.equal(
    validateComputerToolArgs({
      action: 'act',
      input: { window_id: 'hwnd:0x1', actions: [{ type: 'set_value', ref: 'uia:1', value: 'round1.txt' }] },
    }),
    null
  );
});

test('a value needs a semantic target and a value', () => {
  assert.match(validateComputerCoreActions([{ type: 'set_value', value: 'x' }]), /requires ref or element/);
  assert.match(validateComputerCoreActions([{ type: 'set_value', ref: 'uia:1' }]), /requires value/);
  assert.match(
    validateComputerCoreActions([{ type: 'set_value', ref: 'uia:1', element: 2, value: 'x' }]),
    /only one of ref or element/
  );
  // A coordinate names a pixel, not a control that holds a value.
  assert.match(
    validateComputerCoreActions([{ type: 'set_value', x: 5, y: 6, value: 'x' }], { frameId: 'frame-1' }),
    /does not accept field\(s\)/
  );
});

test('set_value is a targeted action, so it can only lead an act', () => {
  assert.match(
    validateComputerCoreActions([
      { type: 'click', ref: 'uia:1' },
      { type: 'set_value', ref: 'uia:2', value: 'x' },
    ]),
    /after the first must be/
  );
});

test('the host receives set_value with its value intact', () => {
  const command = toComputerHostCommand({
    action: 'act',
    input: { actions: [{ type: 'set_value', ref: 'uia:1', value: 'round1.txt' }] },
  });
  assert.equal(command.action, 'sequence');
  assert.deepEqual(command.steps, [{ action: 'set_value', ref: 'uia:1', value: 'round1.txt' }]);
});
