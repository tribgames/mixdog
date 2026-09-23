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

test('a URI launch offers the one window that appeared, without confirming the launch', () => {
  // "ms-settings:" names no process or app; Settings returns from a cloaked
  // frame without taking focus.
  const settings = { id: 'hwnd:0xD009C', pid: 900, ownerId: '', focused: false, app: 'ApplicationFrameHost' };
  const tooltip = { id: 'hwnd:0x7', pid: 11, ownerId: 'hwnd:0x1', focused: false, app: 'explorer' };
  const transition = computeComputerWindowTransition([existing], [existing, settings, tooltip], '', 0, '', true);
  assert.equal(transition.next_target.id, settings.id);
  assert.equal(transition.next_target_reason, 'launched_single_window');
  assert.equal(launchTransitionConfirmsTarget(transition, ''), false);
  // Two unrelated windows appearing leave the launch unresolved.
  const second = { ...settings, id: 'hwnd:0xE' };
  assert.equal(
    computeComputerWindowTransition([existing], [existing, settings, second], '', 0, '', true).next_target,
    undefined
  );
  // Any other action with no target never adopts a window that happened to appear.
  assert.equal(computeComputerWindowTransition([existing], [existing, settings], '', 0, '').next_target, undefined);
});

test('a folder path launch offers the explorer window that appeared', () => {
  // The running shell opens the folder: no process is reported, and the
  // app hint is only the path itself, which names no window's app.
  const folder = { id: 'hwnd:0x29B0E6C', pid: 7128, ownerId: '', focused: false, app: 'explorer' };
  const transition = computeComputerWindowTransition(
    [existing],
    [existing, folder],
    '',
    0,
    'C:\\Users\\me\\AppData\\Local\\Temp\\probe',
    true
  );
  assert.equal(transition.next_target.id, folder.id);
  assert.equal(transition.next_target_reason, 'launched_single_window');
  assert.equal(launchTransitionConfirmsTarget(transition, 'probe'), false);
});

test('the worker reports the hosted process as content_pid', () => {
  const [record] = normalizeComputerWindowRecords([{ id: 'hwnd:0x3', pid: 900, parent_pid: 4, content_pid: 4242 }]);
  assert.equal(record.contentPid, 4242);
  assert.equal(normalizeComputerWindowRecords([{ id: 'hwnd:0x4', pid: 900 }])[0].contentPid, 0);
});
