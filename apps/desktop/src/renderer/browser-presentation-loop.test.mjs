import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPresentationLoop } from './browser-presentation-loop.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('visible display follows 60 Hz without overlapping reads, and input wakes a scheduled frame immediately', async () => {
  let now = 0;
  let reads = 0;
  let finish;
  let timer;
  let visible = true;
  const loop = createBrowserPresentationLoop({
    read: () => { reads++; return new Promise(resolve => { finish = resolve; }); },
    visible: () => visible, now: () => now,
    schedule: (callback, delay) => { timer = { callback, delay }; return timer; },
    cancel: () => { timer = undefined; },
    failed: error => assert.fail(error),
  });
  loop.wake();
  loop.wake();
  assert.equal(reads, 1);
  now = 5;
  finish();
  await tick();
  assert.ok(timer.delay > 11 && timer.delay < 12);
  loop.wake();
  assert.equal(reads, 2);
  assert.equal(timer, undefined);
  visible = false;
  finish();
  await tick();
  assert.equal(timer, undefined);
  loop.wake();
  assert.equal(reads, 2);
  visible = true;
  loop.wake();
  assert.equal(reads, 3);
  loop.stop();
  finish();
  await tick();
  assert.equal(timer, undefined);
});

test('capture failure backs off without replaying input and a stopped display cannot restart', async () => {
  const callbacks = [];
  let reads = 0;
  const loop = createBrowserPresentationLoop({
    read: async () => { reads++; throw new Error('capture failed'); },
    visible: () => true, now: () => 0,
    schedule: (callback, delay) => { callbacks.push({ callback, delay }); return 1; },
    cancel() {},
    failed: () => 1000,
  });
  loop.wake();
  await tick();
  assert.equal(callbacks[0].delay, 1000);
  loop.stop();
  callbacks[0].callback();
  loop.wake();
  assert.equal(reads, 1);
});
