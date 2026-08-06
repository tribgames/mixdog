import assert from 'node:assert/strict';
import test from 'node:test';

import { createFairCallScheduler } from '../src/standalone/fair-call-scheduler.mjs';

const deferred = () => Promise.withResolvers();
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const capture = (promise) => promise.then(
  (value) => ({ value }),
  (error) => ({ error }),
);

test('weighted owners rotate without starving the lighter owner', async () => {
  const order = [];
  const scheduler = createFairCallScheduler({
    name: 'weighted test',
    activeMax: 1,
    queueMax: 24,
    minOwnerQueue: 1,
  });
  const work = [
    ...Array.from({ length: 4 }, () =>
      scheduler.enqueue('light', () => { order.push('light'); }, { weight: 1 })),
    ...Array.from({ length: 8 }, () =>
      scheduler.enqueue('heavy', () => { order.push('heavy'); }, { weight: 2 })),
  ];

  await Promise.all(work);

  assert.deepEqual(order.slice(0, 3), ['heavy', 'light', 'heavy']);
  assert.equal(order.filter((owner) => owner === 'light').length, 4);
  assert.equal(order.filter((owner) => owner === 'heavy').length, 8);
  assert.deepEqual(scheduler.snapshot(), {
    active: 0,
    queued: 0,
    owners: 0,
    activeMax: 1,
    dispatchBurst: 8,
    queueMax: 24,
    oldestWaitMs: 0,
  });
});

test('a full borrowed queue yields seats and enforces the new fair share', async () => {
  const scheduler = createFairCallScheduler({
    name: 'rebalance test',
    activeMax: 1,
    queueMax: 4,
    minOwnerQueue: 1,
    schedule: () => {},
    now: () => 100,
  });
  const borrowed = Array.from({ length: 4 }, (_, index) =>
    capture(scheduler.enqueue('borrower', () => index)));

  const firstNewcomer = capture(scheduler.enqueue('newcomer', () => 'first'));
  const firstDisplaced = await borrowed[3];
  assert.equal(firstDisplaced.error?.statusCode, 503);
  assert.match(firstDisplaced.error?.message || '', /queue rebalanced/);
  assert.deepEqual(scheduler.snapshot(), {
    active: 0,
    queued: 4,
    owners: 2,
    activeMax: 1,
    dispatchBurst: 8,
    queueMax: 4,
    oldestWaitMs: 0,
  });

  const secondNewcomer = capture(scheduler.enqueue('newcomer', () => 'second'));
  const secondDisplaced = await borrowed[2];
  assert.equal(secondDisplaced.error?.statusCode, 503);
  const overShare = await capture(scheduler.enqueue('newcomer', () => 'third'));
  assert.equal(overShare.error?.statusCode, 429);
  assert.match(overShare.error?.message || '', /client queue is full/);

  scheduler.close('rebalance test closed');
  const remaining = await Promise.all([
    ...borrowed.slice(0, 2),
    firstNewcomer,
    secondNewcomer,
  ]);
  assert.ok(remaining.every(({ error }) => error?.statusCode === 503));
  assert.equal(scheduler.snapshot().queued, 0);
});

test('close rejects queued work but lets already running work settle', async () => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const scheduler = createFairCallScheduler({
    name: 'close test',
    activeMax: 1,
    queueMax: 4,
    minOwnerQueue: 1,
  });
  const active = scheduler.enqueue('owner', async () => {
    started.resolve();
    return gate.promise;
  });
  const queued = capture(scheduler.enqueue('owner', () => 'never'));

  await started.promise;
  scheduler.close('close test closed');
  const queuedResult = await queued;
  assert.equal(queuedResult.error?.statusCode, 503);
  assert.match(queuedResult.error?.message || '', /close test closed/);
  await assert.rejects(
    scheduler.enqueue('owner', () => 'late'),
    /scheduler is closed/,
  );

  gate.resolve('settled');
  assert.equal(await active, 'settled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduler.snapshot(), {
    active: 0,
    queued: 0,
    owners: 0,
    activeMax: 1,
    dispatchBurst: 8,
    queueMax: 4,
    oldestWaitMs: 0,
  });
});

test('queued cancellation removes the call without revoking running work', async () => {
  let now = 100;
  const scheduler = createFairCallScheduler({
    activeMax: 1,
    queueMax: 4,
    now: () => now,
  });
  const runningGate = deferred();
  const running = scheduler.enqueue('busy', () => runningGate.promise);
  await nextTurn();

  const controller = new AbortController();
  let queuedRan = false;
  const queued = scheduler.enqueue('waiting', async () => {
    queuedRan = true;
  }, { signal: controller.signal });
  now = 175;
  assert.equal(scheduler.snapshot().oldestWaitMs, 75);
  controller.abort(new Error('pane closed'));
  await assert.rejects(queued, /pane closed/);
  assert.equal(queuedRan, false);
  assert.equal(scheduler.snapshot().queued, 0);

  runningGate.resolve('done');
  assert.equal(await running, 'done');
  scheduler.close();
});

test('unbounded dispatch bypasses the scheduler queue and starts immediately', async () => {
  const scheduled = [];
  const gates = Array.from({ length: 7 }, () => deferred());
  const started = [];
  const scheduler = createFairCallScheduler({
    activeMax: Infinity,
    queueMax: 16,
    dispatchBurst: 3,
    schedule: (run) => scheduled.push(run),
  });
  const work = gates.map((gate, index) => scheduler.enqueue(`owner-${index}`, async () => {
    started.push(index);
    return gate.promise;
  }));

  await Promise.resolve();
  assert.equal(started.length, 7);
  assert.equal(scheduled.length, 0);
  assert.equal(scheduler.snapshot().dispatchBurst, 3);

  gates.forEach((gate) => gate.resolve());
  await Promise.all(work);
});

test('unbounded dispatch can yield starts without limiting active overlap', async () => {
  const scheduled = [];
  const gates = Array.from({ length: 3 }, () => deferred());
  const started = [];
  const scheduler = createFairCallScheduler({
    activeMax: Infinity,
    queueMax: 16,
    dispatchBurst: 1,
    yieldUnbounded: true,
    schedule: (run) => scheduled.push(run),
  });
  const work = gates.map((gate, index) => scheduler.enqueue('owner', async () => {
    started.push(index);
    return gate.promise;
  }));

  await Promise.resolve();
  assert.deepEqual(started, []);
  assert.equal(scheduled.length, 1);

  scheduled.shift()();
  await Promise.resolve();
  assert.deepEqual(started, [0]);
  assert.equal(scheduler.active, 1);
  assert.equal(scheduler.queued, 2);
  assert.equal(scheduled.length, 1);

  scheduled.shift()();
  await Promise.resolve();
  assert.deepEqual(started, [0, 1]);
  assert.equal(scheduler.active, 2);
  assert.equal(scheduler.queued, 1);

  scheduled.shift()();
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(scheduler.active, 3);
  assert.equal(scheduler.queued, 0);

  gates.forEach((gate) => gate.resolve());
  await Promise.all(work);
});
