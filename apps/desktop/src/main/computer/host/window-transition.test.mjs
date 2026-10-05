import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterComputerUseInternalWindows,
  filterComputerUseWindowListText,
  registerComputerUseInternalWindow,
} from '../overlay/internal-windows.ts';
import {
  computeComputerWindowTransition,
  launchTransitionConfirmsTarget,
  relatedWindowIdsForFrame,
} from '../shared/window-transition.ts';

function windowRecord(id, overrides = {}) {
  return {
    id,
    title: '',
    className: '',
    app: 'fixture',
    pid: 100,
    ownerId: '',
    focused: false,
    minimized: false,
    maximized: false,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...overrides,
  };
}

test('Computer Use overlay windows never become automation transition targets', () => {
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0xb305can);
  const unregister = registerComputerUseInternalWindow({
    getNativeWindowHandle: () => handle,
  });
  try {
    const target = windowRecord('hwnd:0x2F1B18', { pid: 44224 });
    const cursorOverlay = windowRecord('hwnd:0xB305CA', {
      pid: 44224,
      width: 210,
      height: 82,
    });
    const after = filterComputerUseInternalWindows([target, cursorOverlay]);
    const transition = computeComputerWindowTransition([target], after, target.id);
    assert.deepEqual(
      after.map((window) => window.id),
      [target.id]
    );
    assert.equal(transition.opened_windows.length, 0);
    assert.equal(transition.next_target, undefined);
    assert.equal(
      filterComputerUseWindowListText(
        `Windows:\r\n${target.id} | app=fixture\r\n${cursorOverlay.id} | app=Mixdog`,
        after
      ),
      `Windows:\r\n${target.id} | app=fixture`
    );
  } finally {
    unregister();
  }
});

test('computer window transition selects one deterministic successor', () => {
  const main = windowRecord('hwnd:0x1', { title: 'main', focused: true });
  const chat = windowRecord('hwnd:0x2', { title: 'chat', focused: true });
  const transition = computeComputerWindowTransition(
    [main],
    [{ ...main, focused: false }, chat, windowRecord('hwnd:0x9', { title: 'unrelated', pid: 999 })],
    main.id
  );
  assert.equal(transition.next_target?.id, chat.id);
  assert.equal(transition.next_target_reason, 'single_same_process_window_opened');
  assert.deepEqual(
    transition.opened_windows.map((window) => window.id),
    [chat.id]
  );

  const inactiveSingle = computeComputerWindowTransition([main], [main, { ...chat, focused: false }], main.id);
  assert.equal(inactiveSingle.next_target?.id, chat.id);
  assert.equal(inactiveSingle.next_target_reason, 'single_same_process_window_opened');

  const ambiguous = computeComputerWindowTransition(
    [main],
    [main, { ...chat, focused: false }, windowRecord('hwnd:0x3', { title: 'other' })],
    main.id
  );
  assert.equal(ambiguous.next_target, undefined);

  const launched = computeComputerWindowTransition(
    [main],
    [main, windowRecord('hwnd:0x4', { title: 'launched', pid: 404 })],
    '',
    404
  );
  assert.equal(launched.next_target?.id, 'hwnd:0x4');
  assert.equal(launched.next_target_reason, 'launched_process_window');

  const delegated = computeComputerWindowTransition(
    [main, windowRecord('hwnd:0x5', { app: 'Notepad', pid: 505 })],
    [{ ...main, focused: false }, windowRecord('hwnd:0x5', { app: 'Notepad', pid: 505, focused: true })],
    '',
    606,
    'notepad.exe'
  );
  assert.equal(delegated.next_target?.id, 'hwnd:0x5');
  assert.equal(delegated.next_target_reason, 'launched_app_focused');
  assert.deepEqual(
    delegated.changed_windows.map((window) => window.id),
    ['hwnd:0x5']
  );

  const delegatedExisting = computeComputerWindowTransition(
    [main, windowRecord('hwnd:0x9', { app: 'Notepad', pid: 505 })],
    [main, windowRecord('hwnd:0x9', { app: 'Notepad', pid: 505 })],
    '',
    606,
    'Notepad'
  );
  assert.equal(delegatedExisting.next_target?.id, 'hwnd:0x9');
  assert.equal(delegatedExisting.next_target_reason, 'launched_app_existing');

  const delegatedOpened = computeComputerWindowTransition(
    [main],
    [{ ...main, focused: false }, windowRecord('hwnd:0x6', { app: 'Notepad', pid: 505, focused: true })],
    '',
    606,
    'notepad.exe'
  );
  assert.equal(delegatedOpened.next_target?.id, 'hwnd:0x6');
  assert.equal(delegatedOpened.next_target_reason, 'launched_app_opened');

  const shellAssociated = computeComputerWindowTransition(
    [main],
    [{ ...main, focused: false }, windowRecord('hwnd:0x7', { app: 'Notepad', pid: 707, focused: true })],
    '',
    606,
    'C:\\fixtures\\document.txt'
  );
  // A window that opened and took focus during the launch is worth observing
  // next, but a broker-hosted app under another name never confirms the launch.
  assert.equal(shellAssociated.next_target?.id, 'hwnd:0x7');
  assert.equal(shellAssociated.next_target_reason, 'launched_window_focused');
  assert.equal(launchTransitionConfirmsTarget(shellAssociated, 'C:\\fixtures\\document.txt'), false);

  const reusedShellWindow = computeComputerWindowTransition(
    [
      main,
      windowRecord('hwnd:0x8', {
        app: 'Notepad',
        pid: 707,
        title: 'previous.txt - Notepad',
      }),
    ],
    [
      { ...main, focused: false },
      windowRecord('hwnd:0x8', {
        app: 'Notepad',
        pid: 707,
        title: 'document.txt - Notepad',
        focused: true,
      }),
    ],
    '',
    606,
    'C:\\fixtures\\document.txt'
  );
  assert.equal(reusedShellWindow.next_target, undefined);
  assert.deepEqual(reusedShellWindow.changed_windows, []);
  assert.equal(launchTransitionConfirmsTarget(reusedShellWindow, 'C:\\fixtures\\document.txt'), false);
  assert.equal(launchTransitionConfirmsTarget(delegatedExisting, 'notepad.exe'), true);
  assert.equal(launchTransitionConfirmsTarget(delegatedExisting, 'C:\\fixtures\\document.txt'), false);
  assert.equal(
    launchTransitionConfirmsTarget(
      {
        ...delegatedExisting,
        next_target: {
          ...delegatedExisting.next_target,
          title: 'document.txt - Notepad',
        },
      },
      'C:\\fixtures\\document.txt'
    ),
    true
  );
  assert.equal(launchTransitionConfirmsTarget(delegatedExisting, 'https://example.com'), false);
});

test('computer frame admits only captured owned-window descendants', () => {
  const main = windowRecord('hwnd:0x1');
  const menu = windowRecord('hwnd:0x2', { ownerId: main.id });
  const nested = windowRecord('hwnd:0x3', { ownerId: menu.id });
  const unrelated = windowRecord('hwnd:0x4');
  assert.deepEqual(relatedWindowIdsForFrame([main, menu, nested, unrelated], main.id), [main.id, menu.id, nested.id]);
  const inactiveTransition = computeComputerWindowTransition([main], [main, menu], main.id);
  assert.equal(inactiveTransition.next_target, undefined);
  const transition = computeComputerWindowTransition(
    [main],
    [
      { ...main, focused: false },
      { ...menu, focused: true },
    ],
    main.id
  );
  assert.equal(transition.next_target?.id, menu.id);
  assert.equal(transition.next_target_reason, 'owned_window_opened');
});
