import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';

import { createRequire } from 'node:module';

import { installMicaActiveAppearance } from './window-mica.ts';

function fixture({ visible = true, minimized = false } = {}) {
  const window = new EventEmitter();
  const hooks = new Map();
  const calls = [];
  const state = { visible, minimized, destroyed: false };
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x123456789n);
  Object.assign(window, {
    getNativeWindowHandle: () => handle,
    hookWindowMessage: (message, callback) => hooks.set(message, callback),
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
  });
  installMicaActiveAppearance(window, { activate: (hwnd) => calls.push(hwnd) });
  return { window, hooks, calls, state };
}

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
// through a koffi call, so dragging the window by its title bar ran Chromium's
// move loop on koffi's stack, and a garbage collection there aborted the app.
test('real Mica windows keep their native window procedure', { skip: process.platform !== 'win32' }, async () => {
  const koffi = createRequire(import.meta.url)('koffi');
  const user32 = koffi.load('user32.dll');
  const createWindow = user32.func(
    'uintptr_t __stdcall CreateWindowExW(uint32_t ex, str16 cls, str16 name, uint32_t style, int x, int y, int w, int h, uintptr_t parent, uintptr_t menu, uintptr_t inst, uintptr_t param)'
  );
  const windowProc = user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)');
  const destroyWindow = user32.func('bool __stdcall DestroyWindow(uintptr_t hwnd)');
  const GWLP_WNDPROC = -4;
  // Hidden STATIC windows: never shown, never activated. Two of them, since
  // every install goes through the same process-wide bindings.
  const handles = [0, 1].map(() => BigInt(createWindow(0, 'STATIC', '', 0, 0, 0, 0, 0, 0, 0, 0, 0)));
  assert.ok(handles.every((hwnd) => hwnd !== 0n));
  try {
    for (const hwnd of handles) {
      const before = windowProc(hwnd, GWLP_WNDPROC);
      const window = new EventEmitter();
      const handle = Buffer.alloc(8);
      handle.writeBigUInt64LE(hwnd);
      Object.assign(window, {
        getNativeWindowHandle: () => handle,
        hookWindowMessage: () => {},
        isDestroyed: () => false,
        isMinimized: () => false,
        isVisible: () => true,
      });
      installMicaActiveAppearance(window);
      await nextTurn();
      assert.equal(windowProc(hwnd, GWLP_WNDPROC), before);
      window.emit('closed');
    }
  } finally {
    for (const hwnd of handles) destroyWindow(hwnd);
  }
});
