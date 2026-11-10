import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionStatusScheduler } from './session-status-scheduler.mjs';

// A virtual clock: timeouts run only when the test advances it, so recompute
// counts and latencies are exact.
function virtualClock() {
  let clock = 0;
  let seq = 0;
  const queue = [];
  const timers = {
    setTimeout(fn, ms) {
      const task = { at: clock + Math.max(0, ms), seq: seq++, fn };
      queue.push(task);
      return task;
    },
    clearTimeout(task) {
      const at = queue.indexOf(task);
      if (at >= 0) queue.splice(at, 1);
    },
  };
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = queue[0];
      if (!next || next.at > end) break;
      queue.shift();
      clock = Math.max(clock, next.at);
      next.fn();
    }
    clock = Math.max(clock, end);
  };
  return {
    now: () => clock,
    spend: (ms) => {
      clock += ms;
    },
    timers,
    advance,
  };
}

function scheduler(clock, options = {}) {
  return createSessionStatusScheduler({ now: clock.now, timers: clock.timers, ...options });
}

test('a burst of marks recomputes once, one settle beat later', () => {
  const clock = virtualClock();
  const runs = [];
  const status = scheduler(clock);
  const entry = status.register({ recompute: () => runs.push(clock.now()) });
  clock.advance(16);
  assert.deepEqual(runs, [16], 'the registration pass runs right away');
  clock.advance(1000);
  for (let i = 0; i < 10; i += 1) entry.markDirty();
  clock.advance(15);
  assert.equal(runs.length, 1);
  clock.advance(1);
  assert.deepEqual(runs, [16, 1032]);
});

test('marks while a session keeps changing recompute at most every 200 ms, never later', () => {
  const clock = virtualClock();
  const runs = [];
  const status = scheduler(clock);
  const entry = status.register({ recompute: () => runs.push(clock.now()) });
  clock.advance(16);
  // A streaming turn: a mutation every 10 ms for one second.
  let lastMarkAt = 0;
  for (let t = 0; t < 1000; t += 10) {
    lastMarkAt = clock.now();
    entry.markDirty();
    clock.advance(10);
  }
  clock.advance(1000);
  const gaps = runs.slice(1).map((at, i) => at - runs[i]);
  assert.ok(
    gaps.every((gap) => gap >= 200),
    `gaps ${gaps}`
  );
  assert.deepEqual(runs, [16, 216, 416, 616, 816, 1016]);
  assert.ok(runs.at(-1) - lastMarkAt <= 216, 'the last mutation is published within one interval');
});

test('an idle session runs no pass after its first: nothing polls', () => {
  const clock = virtualClock();
  const runs = [];
  const status = scheduler(clock);
  for (let i = 0; i < 3; i += 1) status.register({ recompute: () => runs.push(clock.now()) });
  clock.advance(16);
  clock.advance(10 * 60_000);
  assert.deepEqual(runs, [16, 16, 16]);
});

test('every ready session runs once, oldest mark first, in one task', () => {
  const clock = virtualClock();
  const status = scheduler(clock);
  const order = [];
  for (let i = 0; i < 10; i += 1) {
    status.register({
      recompute() {
        order.push(i);
        clock.spend(1);
      },
    });
  }
  clock.advance(16);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(status.counters().runs, 1);
});

test('disposal stops every pass', () => {
  const clock = virtualClock();
  const runs = [];
  const status = scheduler(clock);
  const entry = status.register({ recompute: () => runs.push(clock.now()) });
  clock.advance(16);
  entry.dispose();
  entry.markDirty();
  clock.advance(60_000);
  assert.deepEqual(runs, [16]);
  assert.equal(status.size(), 0);
});

test('a disposed session is dropped at its next pass', () => {
  const clock = virtualClock();
  let disposed = false;
  let runs = 0;
  const status = scheduler(clock);
  const entry = status.register({ recompute: () => runs++, isDisposed: () => disposed });
  clock.advance(16);
  disposed = true;
  entry.markDirty();
  clock.advance(500);
  assert.equal(runs, 1);
  assert.equal(status.size(), 0);
});

test('a daemon-wide change marks every session; the subscription lives while any is registered', () => {
  const clock = virtualClock();
  let markAll = null;
  let unsubscribed = 0;
  const status = scheduler(clock, {
    subscribeGlobalChanges(listener) {
      markAll = listener;
      return () => unsubscribed++;
    },
  });
  const runs = [0, 0];
  const a = status.register({ recompute: () => runs[0]++ });
  const b = status.register({ recompute: () => runs[1]++ });
  clock.advance(1000);
  assert.deepEqual(runs, [1, 1]);
  markAll();
  clock.advance(16);
  assert.deepEqual(runs, [2, 2]);
  a.dispose();
  assert.equal(unsubscribed, 0);
  b.dispose();
  assert.equal(unsubscribed, 1);
});

test('a failing pass does not stop the other sessions', () => {
  const clock = virtualClock();
  const status = scheduler(clock);
  let runs = 0;
  status.register({
    recompute() {
      throw new Error('boom');
    },
  });
  status.register({ recompute: () => runs++ });
  clock.advance(16);
  assert.equal(runs, 1);
});
