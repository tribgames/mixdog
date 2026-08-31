import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertExactWindowCommandTarget,
  createWindowTargeting,
} from './computer-host-targeting.ts';

function windowRecord(id, overrides = {}) {
  return {
    id,
    title: '',
    className: '',
    app: 'notepad',
    pid: 100,
    ownerId: '',
    focused: false,
    minimized: false,
    maximized: false,
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    ...overrides,
  };
}

function targeting(windows) {
  return createWindowTargeting({ readComputerWindows: async () => windows });
}

test('an app label resolves when it names exactly one window', async () => {
  const { resolveAppWindowId } = targeting([
    windowRecord('hwnd:0x1', { app: 'notepad', title: 'report.txt' }),
    windowRecord('hwnd:0x2', { app: 'chrome', title: 'Mixdog' }),
  ]);
  assert.equal(await resolveAppWindowId({ app: 'Notepad' }), 'hwnd:0x1');
  // Title and class are searched only when no app name matches exactly.
  assert.equal(await resolveAppWindowId({ app: 'report' }), 'hwnd:0x1');
});

test('an exact app name wins over a title that merely contains the label', async () => {
  const { resolveAppWindowId } = targeting([
    windowRecord('hwnd:0x1', { app: 'notepad', title: 'untitled' }),
    windowRecord('hwnd:0x2', { app: 'chrome', title: 'notepad tips' }),
  ]);
  assert.equal(await resolveAppWindowId({ app: 'notepad' }), 'hwnd:0x1');
});

test('two matches are refused with their candidates instead of guessed', async () => {
  const { resolveAppWindowId } = targeting([
    windowRecord('hwnd:0x1', { app: 'notepad', title: 'a.txt' }),
    windowRecord('hwnd:0x2', { app: 'notepad', title: 'b.txt' }),
  ]);
  await assert.rejects(
    resolveAppWindowId({ app: 'notepad' }),
    (error) => {
      assert.match(error.message, /^ambiguous_window_target: app "notepad" matched 2 windows/);
      assert.match(error.message, /hwnd:0x1 "a\.txt"/);
      assert.match(error.message, /hwnd:0x2 "b\.txt"/);
      assert.match(error.message, /retry with one exact window_id/);
      return true;
    },
  );
});

test('a focused window does not make an ambiguous app label safe to guess', async () => {
  const { resolveAppWindowId } = targeting([
    windowRecord('hwnd:0x1', { app: 'notepad', title: 'a.txt' }),
    windowRecord('hwnd:0x2', { app: 'notepad', title: 'b.txt', focused: true }),
  ]);
  await assert.rejects(
    resolveAppWindowId({ app: 'notepad' }),
    /^Error: ambiguous_window_target: app "notepad" matched 2 windows/,
  );
});

test('an unmatched or unreadable target fails closed with its own reason', async () => {
  const { resolveAppWindowId } = targeting([windowRecord('hwnd:0x1', { app: 'chrome' })]);
  await assert.rejects(
    resolveAppWindowId({ app: 'notepad' }),
    /^Error: window_target_not_found: no visible window matched app "notepad"/,
  );
  await assert.rejects(resolveAppWindowId({ app: '   ' }), /app target is empty/);
  const blind = createWindowTargeting({ readComputerWindows: async () => null });
  await assert.rejects(
    blind.resolveAppWindowId({ app: 'notepad' }),
    /could not enumerate windows for app targeting/,
  );
});

test('the foreground target resolves only when exactly one window has focus', async () => {
  const one = targeting([
    windowRecord('hwnd:0x1', { focused: true }),
    windowRecord('hwnd:0x2'),
  ]);
  assert.equal(await one.resolveForegroundWindowId({}), 'hwnd:0x1');
  const none = targeting([windowRecord('hwnd:0x1'), windowRecord('hwnd:0x2')]);
  await assert.rejects(
    none.resolveForegroundWindowId({}),
    /no single foreground window is available; use app or window_id/,
  );
  const two = targeting([
    windowRecord('hwnd:0x1', { focused: true }),
    windowRecord('hwnd:0x2', { focused: true }),
  ]);
  await assert.rejects(two.resolveForegroundWindowId({}), /no single foreground window/);
});

test('window and menu mutations require an exact native target before dispatch', () => {
  for (const action of [
    'focus_window',
    'move_window',
    'window_state',
    'close_window',
    'invoke_menu',
  ]) {
    assert.throws(
      () => assertExactWindowCommandTarget({ action }),
      new RegExp(`${action} requires an exact window_id before dispatch`),
    );
    assert.doesNotThrow(
      () => assertExactWindowCommandTarget({ action, window_id: 'hwnd:0x1' }),
    );
  }
  assert.doesNotThrow(() => assertExactWindowCommandTarget({ action: 'launch' }));
});

test('app listing groups windows per process and puts the focused app first', async () => {
  const { listComputerApps } = targeting([
    windowRecord('hwnd:0x1', { app: 'notepad', title: 'a.txt', minimized: true }),
    windowRecord('hwnd:0x2', { app: 'notepad', title: 'b.txt' }),
    windowRecord('hwnd:0x3', { app: 'chrome', title: 'Mixdog', pid: 200, focused: true }),
  ]);
  const { apps } = JSON.parse((await listComputerApps({})).text);
  assert.deepEqual(apps.map((app) => app.name), ['chrome', 'notepad']);
  assert.equal(apps[0].focused, true);
  assert.equal(apps[1].window_count, 2);
  // A group counts as minimized only when every one of its windows is.
  assert.equal(apps[1].minimized, false);
  assert.deepEqual(apps[1].windows.map((window) => window.window_id), ['hwnd:0x1', 'hwnd:0x2']);
});
