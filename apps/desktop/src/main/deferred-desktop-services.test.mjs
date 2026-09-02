import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { scheduleDeferredDesktopServices } from './deferred-desktop-services.ts';

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function fakeWindow() {
  const window = new EventEmitter();
  const webContents = new EventEmitter();
  let destroyed = false;
  window.webContents = webContents;
  window.isDestroyed = () => destroyed;
  webContents.isDestroyed = () => destroyed;
  window.destroy = () => {
    destroyed = true;
    window.emit('closed');
  };
  return window;
}

test('deferred services wait for service readiness and a fresh quiet phase', async () => {
  const ready = deferred();
  const window = fakeWindow();
  const timers = [];
  const cleared = [];
  let starts = 0;
  scheduleDeferredDesktopServices(window, {
    awaitServiceReady: () => ready.promise,
    start: () => { starts += 1; },
    quietMs: 2_000,
    setTimer(task, delayMs) {
      const timer = { task, delayMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { cleared.push(timer); },
  });

  await Promise.resolve();
  assert.equal(timers.length, 0);
  ready.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 2_000);

  window.webContents.emit('before-input-event');
  assert.equal(timers.length, 2);
  assert.deepEqual(cleared, [timers[0]]);
  timers[1].task();
  await Promise.resolve();
  assert.equal(starts, 1);
});

test('closing the window cancels deferred services before readiness', async () => {
  const ready = deferred();
  const window = fakeWindow();
  let starts = 0;
  let cancelled = 0;
  scheduleDeferredDesktopServices(window, {
    awaitServiceReady: () => ready.promise,
    start: () => { starts += 1; },
    onCancelled: () => { cancelled += 1; },
  });

  window.destroy();
  ready.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(starts, 0);
  assert.equal(cancelled, 1);
});
