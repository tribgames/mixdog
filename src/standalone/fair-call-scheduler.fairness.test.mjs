import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createFairCallScheduler } from './fair-call-scheduler.mjs';

function fixture(options) {
  const dispatches = [];
  let clock = 1_000;
  const scheduler = createFairCallScheduler({
    name: 'test call',
    schedule: (dispatch) => dispatches.push(dispatch),
    now: () => clock,
    ...options,
  });
  return {
    scheduler,
    dispatches,
    tick: (ms) => {
      clock += ms;
    },
    async admit() {
      dispatches.shift()?.();
      await setImmediate();
      await setImmediate();
    },
  };
}

test('an unbounded lane starts loopback work in the same microtask without a dispatch hop', async () => {
  const { scheduler, dispatches } = fixture({ activeMax: null });
  let ran = false;
  const pending = scheduler.enqueue('owner', () => {
    ran = true;
    return 'ok';
  });
  assert.equal(scheduler.active, 1);
  assert.equal(dispatches.length, 0);
  assert.equal(await pending, 'ok');
  assert.equal(ran, true);
  await setImmediate();
  assert.equal(scheduler.active, 0);
  assert.equal(scheduler.snapshot().activeMax, null);
});

test('a full queue is shared: the newcomer evicts the largest borrower, then meets its fair share', async () => {
  const { scheduler } = fixture({ activeMax: 1, queueMax: 4, minOwnerQueue: 1 });
  const first = [];
  for (let i = 0; i < 4; i++) first.push(scheduler.enqueue('alice', () => `a${i}`));
  await assert.rejects(
    scheduler.enqueue('alice', () => 'a4'),
    (error) => error.statusCode === 503 && /queue is full$/.test(error.message)
  );
  const bob1 = scheduler.enqueue('bob', () => 'b1');
  await assert.rejects(
    first[3],
    (error) => error.statusCode === 503 && /queue rebalanced for another client/.test(error.message)
  );
  const bob2 = scheduler.enqueue('bob', () => 'b2');
  await assert.rejects(first[2], (error) => error.statusCode === 503);
  await assert.rejects(
    scheduler.enqueue('bob', () => 'b3'),
    (error) => error.statusCode === 429 && /client queue is full/.test(error.message)
  );
  assert.equal(scheduler.queued, 4);
  assert.equal(scheduler.snapshot().owners, 2);
  scheduler.close();
  await Promise.allSettled([...first, bob1, bob2]);
});

test('dispatch interleaves owners by weight with smooth weighted round-robin', async () => {
  const { scheduler, admit } = fixture({ activeMax: 1, queueMax: 16 });
  const order = [];
  const all = [];
  for (const id of ['a1', 'a2', 'a3']) all.push(scheduler.enqueue('alice', () => order.push(id), { weight: 1 }));
  for (const id of ['b1', 'b2', 'b3']) all.push(scheduler.enqueue('bob', () => order.push(id), { weight: 2 }));
  for (let i = 0; i < 6; i++) await admit();
  await Promise.all(all);
  assert.deepEqual(order, ['b1', 'a1', 'b2', 'b3', 'a2', 'a3']);
  assert.equal(scheduler.queued, 0);
  assert.equal(scheduler.active, 0);
});

test('a burst admits several queued calls per dispatch turn up to the active limit', async () => {
  const { scheduler, admit, dispatches } = fixture({ activeMax: 8, dispatchBurst: 2, queueMax: 16 });
  const started = [];
  const gates = [];
  const all = [];
  for (let i = 0; i < 5; i++) {
    const gate = Promise.withResolvers();
    gates.push(gate);
    all.push(
      scheduler.enqueue('owner', () => {
        started.push(i);
        return gate.promise;
      })
    );
  }
  assert.equal(dispatches.length, 1);
  await admit();
  assert.deepEqual(started, [0, 1], 'one dispatch turn starts at most dispatchBurst calls');
  assert.equal(dispatches.length, 1, 'the burst re-arms itself for the remaining work');
  await admit();
  assert.deepEqual(started, [0, 1, 2, 3]);
  for (const gate of gates) gate.resolve();
  scheduler.close();
  // The fifth call never started; close rejects it and the test owns that.
  await Promise.allSettled(all);
});

test('close rejects queued work with the reason and refuses new work; bad callers are rejected upfront', async () => {
  const { scheduler } = fixture({ activeMax: 1 });
  const queued = scheduler.enqueue('owner', () => 'never');
  await assert.rejects(
    scheduler.enqueue('owner', 'not a function'),
    (error) => error instanceof TypeError && /must be a function/.test(error.message)
  );
  scheduler.close('going away');
  await assert.rejects(queued, (error) => error.statusCode === 503 && error.message === 'going away');
  await assert.rejects(
    scheduler.enqueue('owner', () => 'late'),
    (error) => error.statusCode === 503 && /scheduler is closed/.test(error.message)
  );
  assert.equal(scheduler.snapshot().owners, 0);
});

test('snapshot reports limits and the oldest queued wait', async () => {
  const { scheduler, tick } = fixture({ activeMax: 2, queueMax: 10, dispatchBurst: 3 });
  const pending = [scheduler.enqueue('owner', () => 1), scheduler.enqueue('owner', () => 2)];
  tick(250);
  assert.deepEqual(scheduler.snapshot(), {
    active: 0,
    queued: 2,
    owners: 1,
    activeMax: 2,
    dispatchBurst: 3,
    queueMax: 10,
    oldestWaitMs: 250,
  });
  scheduler.close();
  await Promise.allSettled(pending);
});
