import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalRequestQueue } from './request-queue.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise(setImmediate);
function fixture(unload = async () => {}) {
  const timers = [];
  const queue = createLocalRequestQueue({
    idleTtlSeconds: 10, unload,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  });
  return { queue, timers };
}

test('one request owns the runtime and cancelling queued work does not interrupt its owner', async () => {
  const gate = deferred();
  const { queue } = fixture();
  const first = queue.run(() => gate.promise);
  await flush();
  const controller = new AbortController();
  const stages = [];
  const second = queue.run(() => assert.fail('cancelled work must not reach the provider'), {
    signal: controller.signal, onStageChange: (stage) => stages.push(stage),
  });
  assert.equal(queue.status().activeRequests, 1);
  assert.equal(queue.status().queuedRequests, 1);
  const rejected = assert.rejects(second, /cancel queued/);
  controller.abort(new Error('cancel queued'));
  await rejected;
  assert.equal(queue.status().activeRequests, 1);
  assert.deepEqual(stages, ['reconnecting']);
  gate.resolve('first response');
  assert.equal(await first, 'first response');
});

test('idle unload waits for all active and queued work and serializes with the next request', async () => {
  const a = deferred(), b = deferred(), unloading = deferred();
  let unloads = 0, thirdStarted = false;
  const { queue, timers } = fixture(async () => { unloads++; await unloading.promise; });
  const first = queue.run(() => a.promise);
  const second = queue.run(() => b.promise);
  await flush();
  assert.equal(timers.length, 0);
  a.resolve();
  await first;
  await flush();
  assert.equal(queue.status().activeRequests, 1);
  assert.equal(timers.length, 0);
  b.resolve();
  await second;
  assert.equal(timers.length, 1);
  timers[0].fn();
  const third = queue.run(async () => { thirdStarted = true; });
  await flush();
  assert.equal(unloads, 1);
  assert.equal(thirdStarted, false);
  unloading.resolve();
  await third;
  assert.equal(thirdStarted, true);
  queue.configure(0);
  assert.equal(queue.status().idleDeadline, null);
  assert.equal(timers.at(-1).cleared, true);
});

test('stop cancels active and queued work, rejects new work during shutdown, and permits later reuse', async () => {
  const unloading = deferred();
  const { queue } = fixture(() => unloading.promise);
  const first = queue.run((signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await flush();
  const second = queue.run(() => assert.fail('queued work must not start during shutdown'));
  const failures = [assert.rejects(first, /inference stopped/), assert.rejects(second, /inference stopped/)];
  const stopping = queue.stop();
  await assert.rejects(queue.run(() => {}), /is stopping/);
  unloading.resolve();
  await stopping;
  await Promise.all(failures);
  assert.equal(queue.status().activeRequests, 0);
  assert.equal(queue.status().queuedRequests, 0);
  assert.equal(await queue.run(async () => 'reused'), 'reused');
});

test('unchanged configuration does not keep extending idle lifetime and queue overflow is bounded', async () => {
  const { queue, timers } = fixture();
  await queue.run(async () => {});
  queue.configure(10);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].cleared, false);
  assert.throws(() => queue.configure(-1), /idleTtlSeconds/);
  const gate = deferred();
  const bounded = createLocalRequestQueue({ maxQueue: 0, idleTtlSeconds: 0 });
  const active = bounded.run(() => gate.promise);
  await assert.rejects(bounded.run(() => {}), /queue is full/);
  gate.resolve();
  await active;
});
