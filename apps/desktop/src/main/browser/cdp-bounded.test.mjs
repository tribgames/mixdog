import assert from 'node:assert/strict';
import test from 'node:test';

import { bounded } from './cdp-bounded.ts';
import { createUserWait } from './user-wait.ts';

const never = () => new Promise(() => {});

test('the ceiling still ends a command that overruns it, calling the cancel hook once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let timedOut = 0;
  const outcome = assert.rejects(
    bounded(never(), 42_000, 'browser click', undefined, () => (timedOut += 1), createUserWait()),
    /browser click timed out after 42000ms/
  );
  t.mock.timers.tick(41_999);
  assert.equal(timedOut, 0);
  t.mock.timers.tick(1);
  await outcome;
  assert.equal(timedOut, 1);
});

test('time spent waiting for the person does not count against the ceiling; what was left still does', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const wait = createUserWait();
  let timedOut = 0;
  const outcome = assert.rejects(
    bounded(never(), 42_000, 'browser submit', undefined, () => (timedOut += 1), wait),
    /browser submit timed out after 42000ms/
  );
  t.mock.timers.tick(30_000); // the page work before the approval card
  const release = wait.begin();
  t.mock.timers.tick(6 * 60 * 60_000); // the person takes hours
  assert.equal(timedOut, 0, 'no timeout while the card is open');
  release();
  t.mock.timers.tick(11_999);
  assert.equal(timedOut, 0, 'the 12 s that were left run in full');
  t.mock.timers.tick(1);
  await outcome;
  assert.equal(timedOut, 1);
});

test('overlapping waits reopen the clock only when the last one closes; a wait open from the start never arms it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const wait = createUserWait();
  const first = wait.begin();
  const second = wait.begin();
  let timedOut = 0;
  const outcome = assert.rejects(
    bounded(never(), 1_000, 'browser upload', undefined, () => (timedOut += 1), wait),
    /timed out/
  );
  t.mock.timers.tick(60_000);
  first();
  first(); // releasing twice is harmless
  t.mock.timers.tick(60_000);
  assert.equal(timedOut, 0, 'one wait is still open');
  second();
  t.mock.timers.tick(999);
  assert.equal(timedOut, 0);
  t.mock.timers.tick(1);
  await outcome;
  assert.equal(timedOut, 1);
});

test('stopping the command settles it at once while the card is open, and leaves nothing subscribed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const wait = createUserWait();
  let listeners = 0;
  const subscribe = wait.subscribe;
  wait.subscribe = (listener) => {
    listeners += 1;
    const stop = subscribe(listener);
    return () => {
      listeners -= 1;
      stop();
    };
  };
  const controller = new AbortController();
  const stopped = new Error('stopped by the user');
  const outcome = assert.rejects(
    bounded(never(), 42_000, 'browser submit', controller.signal, undefined, wait),
    (error) => error === stopped
  );
  wait.begin();
  assert.equal(listeners, 1);
  t.mock.timers.tick(10 * 60_000);
  controller.abort(stopped);
  await outcome;
  assert.equal(listeners, 0);
});

test('a command that finishes while the card is open returns its value and unsubscribes', async () => {
  const wait = createUserWait();
  let listeners = 0;
  const subscribe = wait.subscribe;
  wait.subscribe = (listener) => {
    listeners += 1;
    const stop = subscribe(listener);
    return () => {
      listeners -= 1;
      stop();
    };
  };
  const release = wait.begin();
  assert.equal(await bounded(Promise.resolve('done'), 42_000, 'browser submit', undefined, undefined, wait), 'done');
  release();
  assert.equal(listeners, 0);
});

test('without a user wait the ceiling behaves exactly as before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const outcome = assert.rejects(
    bounded(never(), 5_000, 'CDP Page.navigate'),
    /CDP Page.navigate timed out after 5000ms/
  );
  t.mock.timers.tick(5_000);
  await outcome;
});
