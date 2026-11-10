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

test('key, key_down and key_up all require keys', () => {
  for (const type of ['key', 'key_down', 'key_up']) {
    assert.match(validateComputerCoreActions([{ type }]), /requires keys/, type);
    assert.equal(validateComputerCoreActions([{ type, keys: 'a' }]), null, type);
  }
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

test('a later set_value fills another field of the same observation, by ref only', () => {
  assert.equal(
    validateComputerCoreActions([
      { type: 'click', ref: 'uia:1' },
      { type: 'set_value', ref: 'uia:2', value: 'x' },
    ]),
    null
  );
  assert.match(
    validateComputerCoreActions([
      { type: 'click', ref: 'uia:1' },
      { type: 'set_value', element: 2, value: 'x' },
    ]),
    /requires a ref from the same observation/
  );
});

test('the host receives set_value with its value intact, under the field the host reads', () => {
  const command = toComputerHostCommand({
    action: 'act',
    input: { actions: [{ type: 'set_value', ref: 'uia:1', value: 'round1.txt' }] },
  });
  assert.equal(command.action, 'sequence');
  // The host guards, the sequence grammar and the native writer all take the
  // replacement from `text`; a step still carrying `value` is refused unread.
  assert.deepEqual(command.steps, [{ action: 'set_value', ref: 'uia:1', text: 'round1.txt' }]);
});
