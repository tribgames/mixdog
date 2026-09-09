import assert from 'node:assert/strict';
import test from 'node:test';
import { toComputerHostCommand, validateComputerToolArgs } from './action-schema.mjs';

test('visible actions are the default and explicit background remains no-focus', () => {
  for (const delivery of [undefined, 'foreground', 'background']) {
    const request = { action: 'act', input: {
      window_id: 'hwnd:0x1', actions: [{ type: 'click', ref: 's1:e0' }, { type: 'type', text: 'hello' }],
      ...(delivery ? { delivery } : {}),
    } };
    assert.equal(validateComputerToolArgs(request), null);
    const command = toComputerHostCommand(request);
    assert.equal(command.delivery, delivery ?? 'foreground');
    assert.equal(command.steps[0].action, delivery === 'background' ? 'invoke' : 'click');
    assert.deepEqual(command.steps[1], { action: 'type', text: 'hello' });
  }
});

test('foreground-only modifiers cannot silently change explicit background delivery', () => {
  const input = { window_id: 'hwnd:0x1', actions: [{ type: 'click', ref: 's1:e0', modifiers: 'alt' }] };
  assert.equal(validateComputerToolArgs({ action: 'act', input }), null);
  assert.match(validateComputerToolArgs({ action: 'act', input: { ...input, delivery: 'background' } }), /alt requires/);
});
