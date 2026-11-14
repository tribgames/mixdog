import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';

import { createRequire } from 'node:module';
import { join } from 'node:path';

import { installMicaActiveAppearance, MICA_BUILD_FILE, MICA_LIBRARY_FILE, nativeMica } from './window-mica.ts';

function fakeWindow(hwnd, { visible = true, minimized = false } = {}) {
  const window = new EventEmitter();
  const hooks = new Map();
  const state = { visible, minimized, destroyed: false };
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(hwnd);
  Object.assign(window, {
    getNativeWindowHandle: () => handle,
    hookWindowMessage: (message, callback) => hooks.set(message, callback),
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
  });
  return { window, hooks, state };
}

// The fallback when the native library is unavailable: the v1.4.5 hook and
// deferred repaint.
function fixture(options) {
  const { window, hooks, state } = fakeWindow(0x123456789n, options);
  const calls = [];
  installMicaActiveAppearance(window, {
    activate: (hwnd) => calls.push(hwnd),
    keepActive: () => false,
    release: () => assert.fail('nothing was installed'),
  });
  return { window, hooks, calls, state };
}

test('with the native window procedure, deactivation is not hooked and closing removes it', async () => {
  const { window, hooks } = fakeWindow(0x123456789n);
  const calls = [];
  installMicaActiveAppearance(window, {
    activate: (hwnd) => calls.push(['activate', hwnd]),
    keepActive: (hwnd) => calls.push(['keepActive', hwnd]) > 0,
    release: (hwnd) => calls.push(['release', hwnd]),
  });
  assert.deepEqual([...hooks.keys()].sort(), [0x031a, 0x0320]);
  await nextTurn();
  window.emit('closed');
  assert.deepEqual(calls, [
    ['keepActive', 0x123456789n],
    ['activate', 0x123456789n],
    ['release', 0x123456789n],
  ]);
});

test('a missing native module is reported and the window falls back to the deferred repaint', async () => {
  const reports = [];
  const library = join(import.meta.dirname, 'missing', MICA_LIBRARY_FILE);
  const native = nativeMica(library, (event, details) => reports.push({ event, ...details }));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].event, 'mica-native-unavailable');
  assert.equal(reports[0].library, library);
  assert.ok(reports[0].message);
  assert.equal(native.keepActive(0x123456789n), false);
  native.activate(0x123456789n);
  native.release(0x123456789n);
  const { window, hooks } = fakeWindow(0x123456789n, { visible: false });
  installMicaActiveAppearance(window, native);
  assert.ok(hooks.has(0x0086));
  window.emit('closed');
});

test('the bindings forward to the module and report a refused install', () => {
  const calls = [];
  const reports = [];
  let accept = true;
  const module = {
    install: (hwnd) => calls.push(['install', hwnd]) > 0 && accept,
    uninstall: (hwnd) => calls.push(['uninstall', hwnd]) > 0,
    activate: (hwnd) => calls.push(['activate', hwnd]),
  };
  const native = nativeMica('lib', (event, details) => reports.push({ event, ...details }), (library) => {
    assert.equal(library, 'lib');
    return module;
  });
  assert.equal(native.keepActive(7n), true);
  native.activate(7n);
  native.release(7n);
  accept = false;
  assert.equal(native.keepActive(8n), false);
  assert.deepEqual(calls, [['install', 7n], ['activate', 7n], ['uninstall', 7n], ['install', 8n]]);
  assert.deepEqual(reports, [{ event: 'mica-native-install-failed', library: 'lib' }]);
});

test('a visible Mica window gets an active appearance with its full native handle', async () => {
  const { calls } = fixture();
  assert.deepEqual(calls, []);
  await nextTurn();
  assert.deepEqual(calls, [0x123456789n]);
});

test('activation changes are handled after native dispatch and coalesced without polling', async () => {
  const { hooks, calls } = fixture();
  await nextTurn();
  calls.length = 0;
  hooks.get(0x0086)();
  hooks.get(0x0086)();
  hooks.get(0x0086)();
  assert.deepEqual(calls, []);
  await nextTurn();
  assert.deepEqual(calls, [0x123456789n]);
  await nextTurn();
  assert.equal(calls.length, 1);
});

test('theme and DWM color changes restore the backdrop appearance', async () => {
  const { hooks, calls } = fixture();
  await nextTurn();
  calls.length = 0;
  for (const message of [0x031a, 0x0320]) {
    hooks.get(message)();
    await nextTurn();
  }
  assert.deepEqual(calls, [0x123456789n, 0x123456789n]);
});

test('hidden and minimized windows are left alone until shown or restored', async () => {
  const { window, hooks, calls, state } = fixture({ visible: false });
  await nextTurn();
  assert.deepEqual(calls, []);
  state.visible = true;
  window.emit('show');
  await nextTurn();
  assert.equal(calls.length, 1);
  state.minimized = true;
  hooks.get(0x0086)();
  await nextTurn();
  assert.equal(calls.length, 1);
  state.minimized = false;
  window.emit('restore');
  await nextTurn();
  assert.equal(calls.length, 2);
});

test('closing cancels pending work and cannot schedule more native calls', async () => {
  const { window, hooks, calls, state } = fixture();
  window.emit('closed');
  state.destroyed = true;
  hooks.get(0x031a)();
  window.emit('show');
  await nextTurn();
  assert.deepEqual(calls, []);
});

test('a window destroyed before its queued update never touches its stale HWND', async () => {
  const { calls, state } = fixture();
  state.destroyed = true;
  await nextTurn();
  assert.deepEqual(calls, []);
});

// Issue #325: a window procedure written in JavaScript forwards every message
// through a foreign call, so dragging the window by its title bar ran
// Chromium's move loop on that stack, and a garbage collection there aborted
// the app. The procedure that keeps the frame active is native: installing it
// registers no callback, yet a deactivation no longer reaches the frame. The
// probe windows are made through koffi (a test-only dependency until it is
// removed); the module under test uses none.
test('real Mica windows keep a native window procedure that answers deactivation as activation', {
  skip: process.platform !== 'win32',
}, async () => {
  const crate = join(import.meta.dirname, '..', '..', '..', '..', 'native', 'mixdog-window');
  // The crate's own linker setup (.cargo/config.toml) applies from its directory.
  execFileSync('cargo', ['build', '--locked', '--release'], { cwd: crate, stdio: 'ignore', windowsHide: true });
  const library = join(process.env.CARGO_TARGET_DIR || join(crate, 'target'), 'release', MICA_BUILD_FILE);

  const koffi = createRequire(import.meta.url)('koffi');
  const user32 = koffi.load('user32.dll');
  const createWindow = user32.func(
    'uintptr_t __stdcall CreateWindowExW(uint32_t ex, str16 cls, str16 name, uint32_t style, int x, int y, int w, int h, uintptr_t parent, uintptr_t menu, uintptr_t inst, uintptr_t param)'
  );
  const sendMessage = user32.func(
    'intptr_t __stdcall SendMessageW(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)'
  );
  const defWindowProc = user32.func(
    'intptr_t __stdcall DefWindowProcW(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)'
  );
  const windowInfo = user32.func('bool __stdcall GetWindowInfo(uintptr_t hwnd, _Inout_ uint8_t *info)');
  const destroyWindow = user32.func('bool __stdcall DestroyWindow(uintptr_t hwnd)');
  const WS_ACTIVECAPTION = 1;
  // WINDOWINFO: cbSize, rcWindow, rcClient, dwStyle, dwExStyle, dwWindowStatus, ...
  const captionActive = (hwnd) => {
    const info = Buffer.alloc(60);
    info.writeUInt32LE(info.length, 0);
    assert.ok(windowInfo(hwnd, info));
    return info.readUInt32LE(44) === WS_ACTIVECAPTION;
  };
  const deactivate = (hwnd) => sendMessage(hwnd, 0x0086, 0, 0);
  const activate = (hwnd) => sendMessage(hwnd, 0x0086, 1, 0);

  const registered = [];
  const register = koffi.register;
  koffi.register = (...args) => {
    registered.push(args);
    return register.apply(koffi, args);
  };
  const reports = [];
  // Hidden STATIC windows: never shown, never activated. Two of them, since
  // every install goes through the same bindings.
  const handles = [0, 1].map(() => BigInt(createWindow(0, 'STATIC', '', 0, 0, 0, 0, 0, 0, 0, 0, 0)));
  assert.ok(handles.every((hwnd) => hwnd !== 0n));
  try {
    const native = nativeMica(library, (event, details) => reports.push({ event, ...details }));
    for (const hwnd of handles) {
      activate(hwnd);
      deactivate(hwnd);
      assert.equal(captionActive(hwnd), false, 'the probe sees a plain deactivation');
      const { window } = fakeWindow(hwnd);
      installMicaActiveAppearance(window, native);
      await nextTurn();
      assert.equal(captionActive(hwnd), true);
      deactivate(hwnd);
      assert.equal(captionActive(hwnd), true, 'the native procedure rewrote the deactivation');
      // Chromium deactivates the frame with a direct DefWindowProc call while
      // it handles WM_ACTIVATE; the procedure sets it active again afterwards.
      defWindowProc(hwnd, 0x0086, 0, 0);
      assert.equal(captionActive(hwnd), false);
      sendMessage(hwnd, 0x0006, 0, 0);
      assert.equal(captionActive(hwnd), true, 'the frame is active again after WM_ACTIVATE');
      window.emit('closed');
      deactivate(hwnd);
      assert.equal(captionActive(hwnd), false, 'closing removed the native procedure');
    }
    // Destroying a window with the procedure installed removes it natively.
    const { window } = fakeWindow(handles[0]);
    installMicaActiveAppearance(window, native);
    assert.ok(destroyWindow(handles[0]));
    handles[0] = 0n;
    window.emit('closed');
  } finally {
    koffi.register = register;
    for (const hwnd of handles) if (hwnd) destroyWindow(hwnd);
  }
  assert.deepEqual(registered, []);
  assert.deepEqual(reports, []);
});
