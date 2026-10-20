import assert from 'node:assert/strict';
import test from 'node:test';
import { armRemoteCallDeadline } from './remote-call-deadline.ts';

test('an overdue call probes first and fails once only after the probe window', () => {
  const pending = new Map([
    [1, {}],
    [2, {}],
  ]);
  const failures = [];
  let probes = 0,
    expire,
    delay;
  armRemoteCallDeadline(
    pending,
    1,
    (error) => failures.push(error),
    () => {
      probes += 1;
    },
    {
      setTimeout: (callback, ms) => {
        expire = callback;
        delay = ms;
        return 1;
      },
    }
  );
  assert.equal(delay, 20_000);
  expire();
  assert.equal(failures.length, 0, 'the probe decides first');
  assert.equal(probes, 1);
  assert.equal(delay, 5_000);
  expire();
  expire();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, 'mixdog remote call timed out.');
  assert.equal(probes, 1);
  assert.equal(pending.has(2), true);
});

// A silently dead leg: the probe recycles it and its close fails the call as
// interrupted (a brief drop, retried on reconnect) — never as a timeout.
test('a call the probe-triggered close settles never times out', () => {
  const pending = new Map([[1, {}]]);
  const failures = [];
  let expire;
  armRemoteCallDeadline(
    pending,
    1,
    (error) => failures.push(error),
    () => pending.delete(1),
    {
      setTimeout: (callback) => {
        expire = callback;
        return 1;
      },
    }
  );
  expire();
  expire();
  assert.deepEqual(failures, []);
});

test('a deadline that comes due while the page is frozen waits a grace before failing', () => {
  const pending = new Map([[1, {}]]);
  const failures = [];
  const scheduled = [];
  let clock = 0;
  armRemoteCallDeadline(
    pending,
    1,
    (error) => failures.push(error),
    () => {},
    { setTimeout: (callback, ms) => scheduled.push({ callback, ms }), clearTimeout() {} },
    () => clock
  );
  assert.deepEqual(
    scheduled.map((entry) => entry.ms),
    [20_000]
  );
  // A 16 s long task ran across the due time: the timer runs 6 s late.
  clock = 26_000;
  scheduled[0].callback();
  assert.equal(failures.length, 0, 'the answer may be queued behind the frozen thread');
  assert.equal(pending.has(1), true);
  assert.deepEqual(
    scheduled.map((entry) => entry.ms),
    [20_000, 5_000]
  );
  // The grace runs on time with no answer: the leg is probed, and the call
  // fails once the probe window passes with the answer still owed.
  clock = 31_000;
  scheduled[1].callback();
  assert.equal(failures.length, 0);
  assert.deepEqual(
    scheduled.map((entry) => entry.ms),
    [20_000, 5_000, 5_000]
  );
  clock = 36_000;
  scheduled[2].callback();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, 'mixdog remote call timed out.');
  assert.equal(pending.has(1), false);
});

test('the returned cancel clears the current deadline timer', () => {
  const cleared = [];
  const cancel = armRemoteCallDeadline(
    new Map([[1, {}]]),
    1,
    () => {},
    () => {},
    { setTimeout: () => 7, clearTimeout: (timer) => cleared.push(timer) }
  );
  cancel();
  assert.deepEqual(cleared, [7]);
});

test('a call already settled never fails again or probes the connection', () => {
  const pending = new Map([[1, {}]]);
  let expire,
    effects = 0;
  armRemoteCallDeadline(
    pending,
    1,
    () => {
      effects += 1;
    },
    () => {
      effects += 1;
    },
    {
      setTimeout: (callback) => {
        expire = callback;
        return 1;
      },
    }
  );
  pending.delete(1);
  expire();
  assert.equal(effects, 0);
});
