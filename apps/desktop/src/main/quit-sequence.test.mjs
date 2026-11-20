import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IN_TREE_DAEMON_STOP_GRACE_MS,
  PG_FORCED_STOP_AT_MS,
} from '../shared/core-src/standalone/daemon-stop-budget.mjs';
import { createDesktopQuitSequence, DESKTOP_DAEMON_STOP_TIMEOUT_MS, stopCoreForQuit } from './quit-sequence.ts';

function harness({ teardown } = {}) {
  const events = [];
  const windows = [
    { isDestroyed: () => false, hide: () => events.push('hide:main') },
    { isDestroyed: () => true, hide: () => events.push('hide:destroyed') },
    { isDestroyed: () => false, hide: () => events.push('hide:server') },
  ];
  let finishTeardown;
  const sequence = createDesktopQuitSequence({
    windows: () => windows,
    teardown:
      teardown ??
      (() => {
        events.push('teardown:start');
        return new Promise((resolve) => {
          finishTeardown = () => {
            events.push('teardown:end');
            resolve();
          };
        });
      }),
    exit: () => events.push('exit'),
    relaunch: () => events.push('relaunch'),
    onError: (error) => events.push(`error:${error?.message}`),
  });
  return { events, sequence, finish: () => finishTeardown() };
}

test('a quit hides every window before any teardown starts, then exits once teardown settles', async () => {
  const { events, sequence, finish } = harness();
  const quit = sequence.begin();
  assert.deepEqual(events, ['hide:main', 'hide:server'], 'windows are gone synchronously, nothing torn down yet');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['hide:main', 'hide:server', 'teardown:start']);
  assert.equal(sequence.quitting, true);
  // A repeated quit request joins the same sequence.
  assert.equal(sequence.begin(), quit);
  finish();
  await quit;
  assert.deepEqual(events, ['hide:main', 'hide:server', 'teardown:start', 'teardown:end', 'exit']);
});

test('a failing teardown still exits', async () => {
  const { events, sequence } = harness({
    teardown: async () => {
      throw new Error('detach failed');
    },
  });
  await sequence.begin();
  assert.deepEqual(events, ['hide:main', 'hide:server', 'error:detach failed', 'exit']);
});

test('a second launch during the teardown relaunches once instead of reviving the quitting app', async () => {
  const { events, sequence, finish } = harness();
  assert.equal(sequence.secondInstance(), false, 'while running, the caller activates its window');
  const quit = sequence.begin();
  assert.equal(sequence.secondInstance(), true);
  assert.equal(sequence.secondInstance(), true);
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await quit;
  assert.deepEqual(
    events.filter((event) => event === 'relaunch' || event === 'exit'),
    ['relaunch', 'exit']
  );
});

function stopHarness({ request = 'sent', error = null, exits = true, requestMs = 40 } = {}) {
  const events = [];
  let clock = 1_000;
  const outcomes = [];
  return {
    events,
    outcomes,
    run: () =>
      stopCoreForQuit({
        now: () => clock,
        request: async (timeoutMs) => {
          events.push(`request:${timeoutMs}`);
          clock += requestMs;
          return { request, error, elapsedMs: requestMs };
        },
        exit: async (remainingMs) => {
          events.push(`exit-wait:${remainingMs}`);
          clock += exits ? 300 : remainingMs;
          return exits;
        },
        record: (outcome) => {
          events.push('record');
          outcomes.push(outcome);
        },
      }),
  };
}

test('a quit asks the core to stop, waits for its exit within the remaining time, and records the outcome before the app exits', async () => {
  const stop = stopHarness();
  const events = stop.events;
  const sequence = createDesktopQuitSequence({
    windows: () => [],
    teardown: async () => {
      events.push('teardown');
      await stop.run();
    },
    exit: () => events.push('exit'),
    relaunch: () => {},
  });
  await sequence.begin();
  assert.deepEqual(events, [
    `teardown`,
    `request:${DESKTOP_DAEMON_STOP_TIMEOUT_MS}`,
    `exit-wait:${DESKTOP_DAEMON_STOP_TIMEOUT_MS - 40}`,
    'record',
    'exit',
  ]);
  assert.deepEqual(stop.outcomes, [
    {
      request: 'sent',
      error: null,
      requestMs: 40,
      exited: true,
      elapsedMs: 340,
      timeoutMs: DESKTOP_DAEMON_STOP_TIMEOUT_MS,
    },
  ]);
});

test('a core that does not leave within the wait is recorded as not exited, with the refusal that explains it', async () => {
  const stop = stopHarness({ request: 'refused', error: 'mixdogd: the core refused', exits: false });
  const outcome = await stop.run();
  assert.equal(outcome.exited, false);
  assert.equal(outcome.request, 'refused');
  assert.equal(outcome.error, 'mixdogd: the core refused');
  assert.equal(
    outcome.elapsedMs,
    DESKTOP_DAEMON_STOP_TIMEOUT_MS,
    'the wait ends at the limit, the request counted in it'
  );
  assert.equal(stop.outcomes.length, 1);
});

test('the in-tree daemon stop wait stays bounded: a measured healthy shutdown is ~0.6 s', () => {
  assert.ok(DESKTOP_DAEMON_STOP_TIMEOUT_MS >= 1_000 && DESKTOP_DAEMON_STOP_TIMEOUT_MS <= 5_000);
  // The one contract with the core: the launcher's wait, from which the core derives its database fallback point (5000 - 800 = 4200 ms).
  assert.equal(DESKTOP_DAEMON_STOP_TIMEOUT_MS, IN_TREE_DAEMON_STOP_GRACE_MS);
  assert.equal(PG_FORCED_STOP_AT_MS, 4_200);
});

test('a teardown that never settles still exits once its bound passes, after the timeout hook', async () => {
  const events = [];
  const sequence = createDesktopQuitSequence({
    windows: () => [],
    teardown: () => new Promise(() => events.push('teardown:hung')),
    exit: () => events.push('exit'),
    relaunch: () => events.push('relaunch'),
    teardownTimeoutMs: 20,
    onTeardownTimeout: () => events.push('timeout'),
  });
  await sequence.begin();
  assert.deepEqual(events, ['teardown:hung', 'timeout', 'exit']);
});

test('a teardown that settles within its bound never fires the timeout hook', async () => {
  const events = [];
  const sequence = createDesktopQuitSequence({
    windows: () => [],
    teardown: async () => events.push('teardown'),
    exit: () => events.push('exit'),
    relaunch: () => {},
    teardownTimeoutMs: 1_000,
    onTeardownTimeout: () => events.push('timeout'),
  });
  await sequence.begin();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(events, ['teardown', 'exit']);
});
