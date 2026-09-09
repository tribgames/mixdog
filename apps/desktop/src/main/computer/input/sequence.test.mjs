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
  assert.ok(result.rows[0].timings_ms.execution_ms >= 0);
  assert.equal(result.rows[1].timings_ms, undefined);
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

test('executed steps expose distinct phase timings without copying arbitrary metadata', async () => {
  const result = await executeComputerSequenceSteps(
    [{ action: 'click' }, { action: 'type', text: 'private-value' }],
    'hwnd:0x1',
    async (_, index) => ({
      ok: true,
      delivery_accepted: true,
      cursor_feedback: { system_theme_applied: true, system_theme_restored: true, pointer_moved: index === 0,
        text: 'private-value', x: 123 },
      timings_ms: {
        delivery_ms: index + 1, settle_ms: 150, before_windows_ms: 3,
        after_windows_ms: 4, total_ms: 160 + index,
        private_text: 'private-value', screenshot_ms: Infinity, ocr_ms: -1,
      },
    }),
  );
  assert.deepEqual(result.rows.map((row) => row.timings_ms.delivery_ms), [1, 2]);
  for (const row of result.rows) {
    assert.equal(row.timings_ms.settle_ms, 150);
    assert.equal(row.timings_ms.before_windows_ms, 3);
    assert.equal(row.timings_ms.after_windows_ms, 4);
    assert.ok(row.timings_ms.execution_ms >= 0);
    assert.equal(row.timings_ms.private_text, undefined);
    assert.equal(row.timings_ms.screenshot_ms, undefined);
    assert.equal(row.timings_ms.ocr_ms, undefined);
    assert.equal(row.delivery_accepted, true);
    assert.equal(row.cursor_feedback.system_theme_restored, true);
    assert.equal(row.cursor_feedback.text, undefined);
    assert.equal(row.cursor_feedback.x, undefined);
  }
});

test('sequence checkpoints retain only completed steps before interrupted input', async () => {
  const checkpoints = [];
  await assert.rejects(executeComputerSequenceSteps(
    [{ action: 'click' }, { action: 'type' }, { action: 'key' }],
    'hwnd:0x1',
    async (_, index) => {
      if (index === 1) throw new Error('user_input_active: interrupted');
      return { ok: true };
    },
    (completed) => checkpoints.push(completed),
  ), /user_input_active/);
  assert.deepEqual(checkpoints, [1]);
});
