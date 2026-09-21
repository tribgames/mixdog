import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeComputerWindowTransition,
  launchTransitionConfirmsTarget,
  normalizeComputerWindowRecords,
} from './window-transition.ts';

const existing = { id: 'hwnd:0x1', pid: 11, ownerId: '', focused: true, app: 'explorer' };

test('a frame-hosted window is matched by the process that owns its content', () => {
  // The packaged app runs as pid 4242; the window belongs to the frame host.
  const frame = {
    id: 'hwnd:0x2',
    pid: 900,
    parentPid: 0,
    contentPid: 4242,
    ownerId: '',
    focused: true,
    app: 'ApplicationFrameHost',
  };
  const transition = computeComputerWindowTransition(
    [existing],
    [{ ...existing, focused: false }, frame],
    '',
    4242,
    'calculator'
  );
  assert.equal(transition.next_target.id, frame.id);
  assert.equal(transition.next_target_reason, 'launched_process_window');
  assert.equal(launchTransitionConfirmsTarget(transition, 'calc'), true);
});

test('an unrelated frame window is still not the launched app', () => {
  const frame = {
    id: 'hwnd:0x2',
    pid: 900,
    parentPid: 0,
    contentPid: 55,
    ownerId: '',
    focused: true,
    app: 'ApplicationFrameHost',
  };
  const transition = computeComputerWindowTransition(
    [existing],
    [{ ...existing, focused: false }, frame],
    '',
    4242,
    'calculator'
  );
  assert.equal(transition.next_target_reason, 'launched_window_focused');
  assert.equal(launchTransitionConfirmsTarget(transition, 'calc'), false);
});

test('the worker reports the hosted process as content_pid', () => {
  const [record] = normalizeComputerWindowRecords([{ id: 'hwnd:0x3', pid: 900, parent_pid: 4, content_pid: 4242 }]);
  assert.equal(record.contentPid, 4242);
  assert.equal(normalizeComputerWindowRecords([{ id: 'hwnd:0x4', pid: 900 }])[0].contentPid, 0);
});
