import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { DEFAULT_CAPTURE_AFTER_DELAY_MS } from '../shared/common.ts';
import { dialogSuccessorWatch, dialogWatchSettled, settleWindowTransition } from './window-settle.ts';

const windowRecord = (id, extra = {}) => ({
  id,
  title: '',
  className: '',
  app: 'notepad',
  pid: 10,
  parentPid: 0,
  ownerId: '',
  focused: false,
  minimized: false,
  maximized: false,
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  ...extra,
});

const main = windowRecord('hwnd:0x1', { title: 'round1 - 메모장', focused: true });
const dialog = windowRecord('hwnd:0x2', {
  title: '다른 이름으로 저장',
  className: '#32770',
  ownerId: main.id,
  focused: true,
});

const transition = (extra = {}) => ({
  observed: true,
  opened_windows: [],
  closed_windows: [],
  changed_windows: [],
  focused_before: main.id,
  focused_after: main.id,
  ...extra,
});

test('a menu command that promises a dialog keeps watching for it', () => {
  const path = ['파일', '다른 이름으로 저장...'];
  assert.equal(dialogSuccessorWatch('invoke_menu', path, transition()), 'expected');
  assert.equal(dialogSuccessorWatch('invoke_menu', ['파일', '저장'], transition()), 'none');
  // Nothing to wait for once the window is listed.
  assert.equal(dialogSuccessorWatch('invoke_menu', path, transition({ opened_windows: [dialog] })), 'none');
});

test('focus belonging to no listed window is the gap a modal leaves while it is created', () => {
  assert.equal(dialogSuccessorWatch('click', undefined, transition({ focused_after: '' })), 'focus_gap');
  assert.equal(dialogSuccessorWatch('click', undefined, transition()), 'none');
  // A window that just closed explains the gap on its own.
  assert.equal(
    dialogSuccessorWatch('click', undefined, transition({ focused_after: '', closed_windows: [dialog] })),
    'none'
  );
});

test('a focus gap settles as soon as some window owns focus, a promised dialog only when it exists', () => {
  assert.equal(dialogWatchSettled('focus_gap', transition({ focused_after: '' })), false);
  assert.equal(dialogWatchSettled('focus_gap', transition()), true);
  assert.equal(dialogWatchSettled('expected', transition()), false);
  assert.equal(dialogWatchSettled('expected', transition({ opened_windows: [dialog] })), true);
});

test('a dialog created after the settle scan is still reported as the successor', async () => {
  let scans = 0;
  const host = {
    assertExecutionNotAborted() {},
    async readComputerWindows() {
      scans += 1;
      // The dialog does not exist yet when the first scan runs.
      return scans <= 1 ? [main] : [{ ...main, focused: false }, dialog];
    },
  };
  const outcome = await settleWindowTransition(host, {
    command: { action: 'invoke_menu', path: ['파일', '다른 이름으로 저장...'] },
    action: 'invoke_menu',
    windowsBefore: [main],
    targetWindowId: main.id,
    pid: 10,
    appHint: 'notepad',
    timings: {},
  });
  assert.ok(scans > 1, 'the watch has to scan again after the dialog appears');
  assert.deepEqual(
    outcome.transition.opened_windows.map((window) => window.id),
    [dialog.id]
  );
  assert.equal(outcome.transition.next_target.id, dialog.id);
  assert.equal(outcome.transition.next_target_reason, 'owned_window_opened');
});

test('a promised dialog that never appears ends on its own budget', async (t) => {
  // Virtual clock: timers and performance.now advance together, 10 ms at a time.
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let scans = 0;
  const host = {
    assertExecutionNotAborted() {},
    async readComputerWindows() {
      scans += 1;
      return [main];
    },
  };
  let done = false;
  const settling = settleWindowTransition(host, {
    command: { action: 'invoke_menu', path: ['파일', '설정...'] },
    action: 'invoke_menu',
    windowsBefore: [main],
    targetWindowId: main.id,
    pid: 10,
    appHint: 'notepad',
    timings: {},
  }).finally(() => {
    done = true;
  });
  const budget = DEFAULT_CAPTURE_AFTER_DELAY_MS + 1_200;
  while (!done && clock <= budget + 500) {
    clock += 10;
    mock.timers.tick(10);
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  const outcome = await settling;
  assert.equal(clock, budget, 'the watch ends exactly at the settle delay plus the expected-dialog budget');
  assert.deepEqual(outcome.transition.opened_windows, []);
  assert.ok(scans > 1);
});
