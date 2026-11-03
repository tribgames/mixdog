import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';

import { createRequire } from 'node:module';

import { asActiveNcActivate, createMicaNative, installMicaActiveAppearance } from './window-mica.ts';

function micaWindow(hwnd, state = { visible: true, minimized: false, destroyed: false }) {
  const window = new EventEmitter();
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(hwnd);
  Object.assign(window, {
    state,
    activationReads: 0,
    getNativeWindowHandle: () => handle,
    hookWindowMessage: () => {},
    isDestroyed: () => state.destroyed,
    isMinimized: () => {
      window.activationReads++;
      return state.minimized;
    },
    isVisible: () => state.visible,
  });
  return window;
}

/** user32/comctl32 as an ordered log, with the subclass chain it would keep. */
function fakeUser32() {
  const log = [];
  const subclassed = new Set();
  let registered;
  const api = {
    log,
    subclassed,
    deliver: (hwnd, message, wParam) => {
      if (!subclassed.has(hwnd)) return { forwarded: wParam };
      let forwarded;
      api.defSubclassProc = (_h, _m, w) => {
        forwarded = BigInt(w);
        return 0;
      };
      registered.proc(Number(hwnd), message, wParam, 0n);
      return { forwarded };
    },
    defWindowProc: () => 0,
    register: (proc) => {
      log.push('register');
      registered = { proc };
      return registered;
    },
    setWindowSubclass: (hwnd, proc) => {
      assert.equal(proc, registered);
      log.push(`set ${hwnd}`);
      subclassed.add(hwnd);
      return true;
    },
    removeWindowSubclass: (hwnd, proc) => {
      assert.equal(proc, registered);
      log.push(`remove ${hwnd}`);
      subclassed.delete(hwnd);
      return true;
    },
    defSubclassProc: () => 0,
  };
  return api;
}

function fixture({ visible = true, minimized = false } = {}) {
  const window = new EventEmitter();
  const hooks = new Map();
  const calls = [];
  const subclass = { rewrite: undefined, handle: undefined, released: 0 };
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
  installMicaActiveAppearance(window, {
    activate: (hwnd) => calls.push(hwnd),
    keepActive: (hwnd, rewrite) => {
      Object.assign(subclass, { handle: hwnd, rewrite });
      return () => subclass.released++;
    },
  });
  return { window, hooks, calls, state, subclass };
}

test('a visible Mica window gets an active appearance with its full native handle', async () => {
  const { calls } = fixture();
  assert.deepEqual(calls, []);
  await nextTurn();
  assert.deepEqual(calls, [0x123456789n]);
});

test('a deactivation reaches every handler as an activation, so the window never paints inactive and then active', async () => {
  const { hooks, calls, subclass } = fixture();
  await nextTurn();
  calls.length = 0;
  assert.equal(subclass.handle, 0x123456789n);
  // Another window (a Computer Use target) took the foreground: WM_NCACTIVATE(FALSE).
  assert.equal(subclass.rewrite(0n), 1n);
  // The high word Windows sets around minimize and restore survives.
  assert.equal(subclass.rewrite(0x10000n), 0x10001n);
  assert.equal(subclass.rewrite(1n), 1n);
  // No after-the-fact repaint is queued for it: that was the visible blink.
  assert.equal(hooks.has(0x0086), false);
  await nextTurn();
  assert.deepEqual(calls, []);
  assert.equal(asActiveNcActivate(0xffff0000n), 0xffff0001n);
});

test('a minimized or closed window passes its activation changes through unchanged', async () => {
  const { window, subclass, state } = fixture();
  state.minimized = true;
  assert.equal(subclass.rewrite(0n), 0n);
  state.minimized = false;
  window.emit('closed');
  assert.equal(subclass.rewrite(0n), 0n);
  assert.equal(subclass.released, 1);
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
  hooks.get(0x031a)();
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

test('windows share one callback and leave their subclass before anything is released', () => {
  const api = fakeUser32();
  const native = createMicaNative(api);
  const first = micaWindow(1n);
  const second = micaWindow(2n);
  installMicaActiveAppearance(first, native);
  installMicaActiveAppearance(second, native);
  assert.deepEqual(api.log, ['register', 'set 1', 'set 2']);
  assert.equal(api.deliver(1n, 0x0086, 0n).forwarded, 1n);
  assert.equal(api.deliver(2n, 0x0086, 0n).forwarded, 1n);

  // Destruction removes the subclass inside WM_NCDESTROY; the later
  // 'closed' event has nothing left to remove.
  api.deliver(1n, 0x0082, 0n);
  assert.deepEqual(api.subclassed, new Set([2n]));
  first.emit('closed');
  // Closing a window whose HWND still lives removes the subclass, once.
  second.emit('closed');
  second.emit('closed');
  assert.deepEqual(api.log, ['register', 'set 1', 'set 2', 'remove 1', 'remove 2']);
  assert.equal(api.deliver(2n, 0x0086, 0n).forwarded, 0n);

  // A late 'closed' from a destroyed window never detaches a newer window
  // that was given the same HWND.
  const stale = micaWindow(3n);
  installMicaActiveAppearance(stale, native);
  api.deliver(3n, 0x0082, 0n);
  const recycled = micaWindow(3n);
  installMicaActiveAppearance(recycled, native);
  stale.emit('closed');
  assert.equal(api.deliver(3n, 0x0086, 0n).forwarded, 1n);
  assert.deepEqual(api.log.slice(5), ['set 3', 'remove 3', 'set 3']);
});

test('the real bindings install on two native windows and uninstall cleanly', {
  skip: process.platform !== 'win32',
}, () => {
  const koffi = createRequire(import.meta.url)('koffi');
  const user32 = koffi.load('user32.dll');
  const createWindow = user32.func(
    'uintptr_t __stdcall CreateWindowExW(uint32_t ex, str16 cls, str16 name, uint32_t style, int x, int y, int w, int h, uintptr_t parent, uintptr_t menu, uintptr_t inst, uintptr_t param)'
  );
  const sendMessage = user32.func(
    'intptr_t __stdcall SendMessageW(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)'
  );
  const destroyWindow = user32.func('bool __stdcall DestroyWindow(uintptr_t hwnd)');
  // Hidden STATIC windows: never shown, never activated.
  const handles = [0, 1].map(() => BigInt(createWindow(0, 'STATIC', '', 0, 0, 0, 0, 0, 0, 0, 0, 0)));
  assert.ok(handles.every((hwnd) => hwnd !== 0n));
  const windows = handles.map((hwnd) => micaWindow(hwnd, { visible: false, minimized: false, destroyed: false }));
  try {
    // Each install goes through nativeMica(), which used to redeclare its
    // named koffi prototype and throw on the second window.
    for (const window of windows) installMicaActiveAppearance(window);
    for (const window of windows) {
      sendMessage(handles[windows.indexOf(window)], 0x0086, 0, 0);
      assert.equal(window.activationReads, 1);
    }
    // The first goes through WM_NCDESTROY, the second is closed while alive.
    assert.ok(destroyWindow(handles[0]));
    windows[0].state.destroyed = true;
    windows[0].emit('closed');
    windows[1].emit('closed');
    // A window installed after both, through the same bindings, still works.
    const later = micaWindow(handles[1], { visible: false, minimized: false, destroyed: false });
    installMicaActiveAppearance(later);
    sendMessage(handles[1], 0x0086, 0, 0);
    assert.equal(later.activationReads, 1);
    later.emit('closed');
  } finally {
    destroyWindow(handles[1]);
  }
});
