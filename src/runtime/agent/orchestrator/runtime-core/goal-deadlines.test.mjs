import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalDeadlines } from './goal-deadlines.mjs';

function fixture(t, now) {
  const queued = [];
  const commits = [];
  const errors = [];
  let reads = 0;
  const goal = {
    id: 'goal-1',
    status: 'active',
    timeLimitMs: 60_000,
    timeUsedMs: 0,
    lastStartedAt: 1_000,
    warningRevision: 0,
  };
  const controller = createGoalDeadlines({
    now: () => now,
    deadlineWarningMs: [30_000],
    readRecord() {
      reads += 1;
      return { goal: structuredClone(goal) };
    },
    withMutation(_id, operation) {
      const deferred = Promise.withResolvers();
      queued.push(async () => {
        try {
          deferred.resolve(await operation());
        } catch (error) {
          deferred.reject(error);
        }
      });
      return deferred.promise;
    },
    commit: async (id, next) => {
      commits.push({ id, goal: next });
    },
    onStorageError: (error) => errors.push(error),
  });
  t.after(() => controller.close());
  return { controller, queued, commits, errors, reads: () => reads };
}

for (const kind of ['warning', 'expiry']) {
  test(`closing a Goal deadline controller retires an already-queued ${kind}`, async (t) => {
    const f = fixture(t, kind === 'warning' ? 31_000 : 61_000);
    if (kind === 'warning') f.controller.armDeadline('session-1');
    else f.controller.limitIfExpired('session-1');
    await Promise.resolve();
    assert.equal(f.queued.length, 1);
    f.controller.close();
    await f.queued[0]();
    await Promise.resolve();
    assert.deepEqual(f.commits, []);
    assert.deepEqual(f.errors, []);
  });
}

test('a closed Goal deadline controller cannot re-arm itself after an accepted write settles', (t) => {
  const f = fixture(t, 1_000);
  f.controller.close();
  f.controller.armDeadline('session-1');
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.queued, []);
});

test('an expired Goal keeps no suspend anchor once its expiry commit has re-armed the deadline', async (t) => {
  const record = {
    goal: { id: 'goal-1', status: 'active', timeLimitMs: 60_000, timeUsedMs: 0, lastStartedAt: 1_000 },
  };
  let wall = 1_000;
  let controller;
  controller = createGoalDeadlines({
    now: () => wall,
    monotonicNow: () => wall,
    suspendDetectable: true,
    deadlineWarningMs: [],
    readRecord: () => ({ goal: structuredClone(record.goal) }),
    withMutation: (id, operation) => Promise.resolve().then(() => operation(id)),
    // The real store re-arms the deadline on every commit.
    commit: async (id, next) => {
      record.goal = structuredClone(next);
      controller.armDeadline(id);
    },
    stampLive: async () => {},
    onStorageError: (error) => {
      throw error;
    },
  });
  t.after(() => controller.close());

  controller.armDeadline('session-1');
  assert.equal(controller.anchorCount(), 1);
  wall = 100_000;
  controller.limitIfExpired('session-1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(record.goal.status, 'duration_reached');
  assert.equal(controller.anchorCount(), 0);
});
