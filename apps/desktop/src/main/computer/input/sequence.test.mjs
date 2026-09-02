import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyComputerSequenceObservation,
  executeComputerSequenceSteps,
} from './sequence.ts';

test('a thrown sequence step becomes one failed row and skips every remaining step', async () => {
  const steps = [
    { action: 'click', window_id: 'hwnd:0x1' },
    { action: 'type', window_id: 'hwnd:0x1', text: 'value' },
    { action: 'key', window_id: 'hwnd:0x1', keys: '{ENTER}' },
  ];
  const result = await executeComputerSequenceSteps(
    steps,
    'hwnd:0x1',
    async () => {
      throw new Error('foreground_unavailable: target could not be activated');
    },
  );

  assert.equal(result.completedSteps, 0);
  assert.equal(result.stoppedReason, 'foreground_unavailable');
  assert.equal(result.finalWindowId, 'hwnd:0x1');
  assert.deepEqual(result.rows.map((row) => row.status), ['failed', 'skipped', 'skipped']);
  assert.equal(result.rows[0].code, 'foreground_unavailable');
  assert.match(result.rows[0].message, /target could not be activated/);
  assert.equal(result.rows[1].reason, 'foreground_unavailable');
});

test('a successful target transition counts the action and skips unsafe continuations', async () => {
  const steps = [
    { action: 'click', window_id: 'hwnd:0x1' },
    { action: 'type', window_id: 'hwnd:0x1', text: 'value' },
  ];
  const result = await executeComputerSequenceSteps(
    steps,
    'hwnd:0x1',
    async () => ({
      ok: true,
      action: 'click',
      effect: 'confirmed',
      verdict: { decision: 'verify_fresh_state' },
      window_transition: {
        next_target: { id: 'hwnd:0x2' },
      },
    }),
  );

  assert.equal(result.completedSteps, 1);
  assert.equal(result.stoppedReason, 'target_transition');
  assert.equal(result.finalWindowId, 'hwnd:0x2');
  assert.deepEqual(result.rows.map((row) => row.status), ['succeeded', 'skipped']);
});

test('semantic observation remains usable when only pixels are unavailable', () => {
  assert.deepEqual(classifyComputerSequenceObservation({
    ok: true,
    pixel_status: 'unavailable',
    returned_elements: 3,
  }), {
    unavailable: false,
    pixelUnavailable: true,
  });
  assert.deepEqual(classifyComputerSequenceObservation({
    ok: false,
    pixel_status: 'unavailable',
    returned_elements: 0,
  }), {
    unavailable: true,
    pixelUnavailable: true,
  });
});
