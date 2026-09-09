import assert from 'node:assert/strict';
import test from 'node:test';
import { toComputerHostCommand, validateComputerToolArgs } from './action-schema.mjs';

test('background is the default and explicit foreground selects the real pointer', () => {
  for (const delivery of [undefined, 'foreground', 'background']) {
    const request = { action: 'act', input: {
      window_id: 'hwnd:0x1', actions: [{ type: 'click', ref: 's1:e0' }, { type: 'type', text: 'hello' }],
      ...(delivery ? { delivery } : {}),
    } };
    assert.equal(validateComputerToolArgs(request), null);
    const command = toComputerHostCommand(request);
    assert.equal(command.delivery, delivery ?? 'background');
    assert.equal(command.steps[0].action, delivery === 'foreground' ? 'click' : 'invoke');
    assert.deepEqual(command.steps[1], { action: 'type', text: 'hello' });
  }
});

test('foreground-only modifiers cannot silently change explicit background delivery', () => {
  const input = { window_id: 'hwnd:0x1', actions: [{ type: 'click', ref: 's1:e0', modifiers: 'alt' }] };
  assert.match(validateComputerToolArgs({ action: 'act', input }), /alt requires/);
  assert.equal(validateComputerToolArgs({ action: 'act', input: { ...input, delivery: 'foreground' } }), null);
  assert.match(validateComputerToolArgs({ action: 'act', input: { ...input, delivery: 'background' } }), /alt requires/);
});

test('modified background ref clicks use pointer messages rather than losing modifiers through semantic invoke', () => {
  for (const modifiers of ['ctrl', 'shift', 'ctrl+shift']) {
    const request = { action: 'act', input: { window_id: 'hwnd:0x1',
      actions: [{ type: 'click', ref: 's1:e0', modifiers }] } };
    assert.equal(validateComputerToolArgs(request), null);
    const command = toComputerHostCommand(request);
    assert.equal(command.delivery, 'background');
    assert.equal(command.steps[0].action, 'click');
    assert.equal(command.steps[0].modifiers, modifiers);
  }
});
