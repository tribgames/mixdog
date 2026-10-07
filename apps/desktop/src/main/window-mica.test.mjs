import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';

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
  installMicaActiveAppearance(window, (hwnd) => calls.push(hwnd));
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
  const inactive = Buffer.alloc(8);
  const active = Buffer.alloc(8);
  active.writeBigUInt64LE(1n);
  hooks.get(0x0086)(inactive, inactive);
  hooks.get(0x0086)(active, inactive);
  hooks.get(0x0086)(inactive, inactive);
  assert.deepEqual(calls, []);
  await nextTurn();
  assert.deepEqual(calls, [0x123456789n]);
  await nextTurn();
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
  hooks.get(0x0086)();
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
