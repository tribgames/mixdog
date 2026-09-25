import assert from 'node:assert/strict';
import test from 'node:test';
import { computerResultRecovery, computerToolErrorRecovery } from './error-recovery.mjs';
import { computerErrorCode } from './error-code.mjs';

test('native and host error separators preserve the same safe category', () => {
  for (const separator of [':', '|']) {
    const error = `Error: target_mismatch${separator}private window details`;
    assert.equal(computerErrorCode(error), 'target_mismatch');
    assert.equal(computerToolErrorRecovery(error).next, 'capture');
  }
  assert.equal(computerErrorCode(new Error('target_mismatch|private')), 'target_mismatch');
  assert.equal(computerErrorCode('unstructured private text'), '');
  assert.equal(computerErrorCode(`${'a'.repeat(81)}: private`), '');
});

test('cleanup recovery requires user Stop and verified cleanup, not an unconditional restart', () => {
  const recovery = computerToolErrorRecovery('computer_cleanup_pending: failed');
  assert.equal(recovery.next, 'user');
  assert.match(recovery.guidance, /ask the user to press Ctrl\+Alt\+Esc/);
  assert.match(recovery.guidance, /verify worker exit/);
  assert.match(recovery.guidance, /do not replay input or reset the guard/i);
});

test('only a definite no-input refusal permits choosing delivery without mandatory recapture', () => {
  assert.equal(
    computerResultRecovery({
      code: 'background_unsupported',
      delivery_accepted: false,
    }).next,
    'select_delivery'
  );
  for (const delivery_accepted of [true, null, undefined]) {
    assert.equal(computerResultRecovery({ code: 'background_unsupported', delivery_accepted }).next, 'capture');
  }
  assert.equal(
    computerResultRecovery({
      code: 'background_unsupported',
      delivery_accepted: false,
      input_may_have_executed: true,
    }).next,
    'capture'
  );
});

test('observation and target-local cleanup failures never authorize repeating completed input', () => {
  const observation = computerResultRecovery({ code: 'observation_unavailable', completed: true });
  assert.equal(observation.next, 'capture');
  assert.match(observation.guidance, /Do not repeat input/);
  const cleanup = computerToolErrorRecovery('computer_background_cleanup_unconfirmed: no receipt');
  assert.equal(cleanup.next, 'user');
  assert.match(cleanup.guidance, /does not itself prove/);
  assert.match(cleanup.guidance, /Do not replay input/);
});

test('mode failures do not instruct a blind retry or a delivery switch', () => {
  const input = { input: { window_id: 'hwnd:0x1', delivery: 'foreground' } };
  assert.equal(computerResultRecovery({ code: 'foreground_unavailable' }, input).next, 'user');
  assert.equal(computerResultRecovery({ code: 'background_unsupported' }, input).next, 'capture');
  for (const code of ['input_cleanup_unconfirmed', 'privileged_worker_cleanup_unconfirmed']) {
    assert.equal(computerToolErrorRecovery(`${code}: failed`, input).next, 'user');
  }
  assert.equal(computerToolErrorRecovery('computer_cursor_unavailable: no input sent', input).next, 'diagnose');
});

test('window, lease and user-yield codes keep their next actions', () => {
  const input = { input: { app: 'Notepad' } };
  assert.equal(computerResultRecovery({ code: 'window_stale' }, input).next, 'list');
  assert.equal(computerResultRecovery({ code: 'stale_frame' }, input).next, 'capture');
  assert.match(
    computerResultRecovery({ code: 'computer_target_in_use' }, input).guidance,
    /Another session owns app "Notepad"/
  );
  assert.equal(computerResultRecovery({ code: 'computer_user_control_active' }, input).next, 'wait_for_user');
  assert.equal(computerResultRecovery({ code: 'pixel_unavailable' }, input).next, 'capture');
  assert.equal(computerResultRecovery({ code: 'unknown_code' }, input), undefined);
});

test('a native timeout requires diagnosis and preserves possible execution instead of suggesting replacement input', () => {
  const recovery = computerToolErrorRecovery('computer_command_timeout: input host restarted', {
    action: 'menu',
    input: { window_id: 'hwnd:0x1' },
  });
  assert.equal(recovery.next, 'diagnose');
  assert.match(recovery.guidance, /may have executed/);
  assert.match(recovery.guidance, /Do not repeat it or switch delivery modes/);
  assert.match(recovery.guidance, /verified recovery/);
  assert.match(recovery.guidance, /capture window hwnd:0x1/);
});

test('a foreground refusal caused by the user own input asks for a settled capture, not host diagnosis', () => {
  const recovery = computerToolErrorRecovery(
    'foreground_input_not_ready: the last observation was not foreground-ready',
    {
      action: 'act',
      input: { window_id: 'hwnd:0x1' },
    }
  );
  assert.equal(recovery.next, 'capture');
  assert.match(recovery.guidance, /No input was sent/);
  assert.match(recovery.guidance, /background delivery/);
});

test('a read-only timeout sends the caller to another read route instead of a cleanup investigation', () => {
  const recovery = computerToolErrorRecovery(
    'computer_command_timeout: command exceeded 2500ms; the input host was restarted',
    { action: 'capture', input: { window_id: 'hwnd:0x1' } }
  );
  assert.equal(recovery.next, 'capture');
  assert.match(recovery.guidance, /sent no input/);
  assert.match(recovery.guidance, /mode="state" or "som"/);
  assert.doesNotMatch(recovery.guidance, /may have executed/);
});
