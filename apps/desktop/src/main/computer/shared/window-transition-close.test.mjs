import assert from 'node:assert/strict';
import test from 'node:test';
import { computeComputerWindowTransition } from './window-transition.ts';
import { executeComputerSequenceSteps } from '../input/sequence.ts';

const main = { id: 'hwnd:0x1', pid: 11, ownerId: '', focused: false };
const menu = { id: 'hwnd:0x2', pid: 11, ownerId: main.id, className: '#32768', focused: false };
const unrelated = { id: 'hwnd:0x3', pid: 22, ownerId: '', focused: true };

test('closing a background popup returns to its owner without taking another app focus', () => {
  const transition = computeComputerWindowTransition([main, menu, unrelated], [main, unrelated], menu.id);
  assert.equal(transition.next_target.id, main.id);
  assert.equal(transition.next_target_reason, 'owner_window_restored');
  assert.equal(transition.focused_before, unrelated.id);
  assert.equal(transition.focused_after, unrelated.id);
  assert.deepEqual(transition.closed_windows, [menu]);
});

test('closing nested popups finds the nearest surviving owner', () => {
  const submenu = { ...menu, id: 'hwnd:0x4', ownerId: menu.id };
  const before = [main, menu, submenu];
  assert.equal(computeComputerWindowTransition(before, [main, menu], submenu.id).next_target.id, menu.id);
  assert.equal(computeComputerWindowTransition(before, [main], submenu.id).next_target.id, main.id);
});

test('a closed window without a surviving owner never guesses a same-process or focused target', () => {
  for (const ownerId of ['', 'hwnd:0x9', menu.id]) {
    const target = { ...menu, ownerId };
    const transition = computeComputerWindowTransition([main, target, unrelated], [main, unrelated], target.id);
    assert.equal(transition.next_target, undefined);
  }
  assert.equal(computeComputerWindowTransition([main, menu], [main, menu], menu.id).next_target, undefined);
});

test('Esc closes the popup once and makes the parent the next observation target', async () => {
  const transition = computeComputerWindowTransition([main, menu], [main], menu.id);
  const actions = [];
  const result = await executeComputerSequenceSteps(
    [
      { action: 'key', keys: 'esc' },
      { action: 'type', text: 'must not run in parent' },
    ],
    menu.id,
    async (command) => {
      actions.push(command.action);
      return { ok: true, window_transition: transition };
    }
  );
  assert.deepEqual(actions, ['key']);
  assert.equal(result.completedSteps, 1);
  assert.equal(result.finalWindowId, main.id);
  assert.equal(result.stoppedReason, 'target_transition');
  assert.equal(result.rows[1].status, 'skipped');
});

test('a launcher discovers an opened direct child process but never an unrelated app', () => {
  const editor = { ...main, id: 'hwnd:0x5', pid: 33, parentPid: main.pid, focused: true };
  const transition = computeComputerWindowTransition([main, unrelated], [main, unrelated, editor], main.id);
  assert.equal(transition.next_target.id, editor.id);
  assert.equal(transition.next_target_reason, 'child_process_window_opened');
  assert.equal(
    computeComputerWindowTransition([main], [main, { ...editor, parentPid: 99 }], main.id).next_target,
    undefined
  );
});

test('launch resolves a direct child process without guessing unrelated broker windows', () => {
  const child = { ...main, id: 'hwnd:0x5', pid: 33, parentPid: 44, app: 'child-app' };
  const transition = computeComputerWindowTransition([unrelated], [unrelated, child], '', 44, 'launcher');
  assert.equal(transition.next_target.id, child.id);
  assert.equal(transition.next_target_reason, 'launched_process_window');
  assert.equal(
    computeComputerWindowTransition([unrelated], [unrelated, { ...child, parentPid: 55 }], '', 44, 'launcher')
      .next_target,
    undefined
  );
  assert.equal(
    computeComputerWindowTransition([unrelated], [unrelated, child, { ...child, id: 'hwnd:0x6' }], '', 44, 'launcher')
      .next_target,
    undefined
  );
});
