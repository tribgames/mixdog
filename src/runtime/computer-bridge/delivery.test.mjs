import assert from 'node:assert/strict';
import test from 'node:test';
import { validateComputerCoreActions } from './core-actions.mjs';
import { toComputerHostCommand, validateComputerToolArgs } from './action-schema.mjs';

test('drag waypoints carry the whole gesture and refuse a second target or a missing frame', () => {
  const waypoints = [
    { x: 10, y: 10 },
    { x: 40, y: 80 },
    { x: 90, y: 20 },
  ];
  assert.equal(validateComputerCoreActions([{ type: 'drag', waypoints }], { frameId: 'frame-1' }), null);
  assert.match(
    validateComputerCoreActions([{ type: 'drag', waypoints }], {}),
    /waypoints require act\.input\.frame_id/
  );
  assert.match(
    validateComputerCoreActions([{ type: 'drag', waypoints, ref: 's1:e1' }], { frameId: 'frame-1' }),
    /cannot be combined with another target/
  );
  assert.match(
    validateComputerCoreActions([{ type: 'drag', waypoints, to_x: 5, to_y: 5 }], { frameId: 'frame-1' }),
    /cannot be combined with another target/
  );
  // A two-point drag stays the plain form it always was.
  assert.equal(
    validateComputerCoreActions([{ type: 'drag', x: 1, y: 2, to_x: 3, to_y: 4 }], { frameId: 'frame-1' }),
    null
  );
});

test('a waypoint drag carries its frame into the dispatched step', () => {
  const command = toComputerHostCommand({
    action: 'act',
    input: {
      window_id: 'hwnd:0x1',
      frame_id: 'frame-1',
      actions: [
        {
          type: 'drag',
          waypoints: [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
          ],
        },
      ],
    },
  });
  // Without the frame the host cannot turn those pixels into screen points.
  assert.equal(command.steps[0].frame_id, 'frame-1');
  assert.equal(command.steps[0].waypoints.length, 2);
});

test('a held key is an input action that can also follow the first one', () => {
  assert.equal(
    validateComputerCoreActions([
      { type: 'key_down', keys: '{SHIFT}' },
      { type: 'key', keys: '{END}' },
      { type: 'key_up', keys: '{SHIFT}' },
    ]),
    null
  );
  assert.match(
    validateComputerCoreActions([{ type: 'key_down', keys: '{SHIFT}', x: 1, y: 2 }], { frameId: 'frame-1' }),
    /does not accept field\(s\): x, y/
  );
});

test('background is the default and explicit foreground selects the real pointer', () => {
  for (const delivery of [undefined, 'foreground', 'background']) {
    const request = {
      action: 'act',
      input: {
        window_id: 'hwnd:0x1',
        actions: [
          { type: 'click', ref: 's1:e0' },
          { type: 'type', text: 'hello' },
        ],
        ...(delivery ? { delivery } : {}),
      },
    };
    assert.equal(validateComputerToolArgs(request), null);
    const command = toComputerHostCommand(request);
    assert.equal(command.delivery, delivery ?? 'background');
    assert.equal(command.steps[0].action, 'click');
    assert.deepEqual(command.steps[1], { action: 'type', text: 'hello' });
  }
});

test('foreground-only modifiers cannot silently change explicit background delivery', () => {
  const input = { window_id: 'hwnd:0x1', actions: [{ type: 'click', ref: 's1:e0', modifiers: 'alt' }] };
  assert.match(validateComputerToolArgs({ action: 'act', input }), /alt requires/);
  assert.equal(validateComputerToolArgs({ action: 'act', input: { ...input, delivery: 'foreground' } }), null);
  assert.match(
    validateComputerToolArgs({ action: 'act', input: { ...input, delivery: 'background' } }),
    /alt requires/
  );
});

test('modified background ref clicks use pointer messages rather than losing modifiers through semantic invoke', () => {
  for (const modifiers of ['ctrl', 'shift', 'ctrl+shift']) {
    const request = {
      action: 'act',
      input: { window_id: 'hwnd:0x1', actions: [{ type: 'click', ref: 's1:e0', modifiers }] },
    };
    assert.equal(validateComputerToolArgs(request), null);
    const command = toComputerHostCommand(request);
    assert.equal(command.delivery, 'background');
    assert.equal(command.steps[0].action, 'click');
    assert.equal(command.steps[0].modifiers, modifiers);
  }
});
