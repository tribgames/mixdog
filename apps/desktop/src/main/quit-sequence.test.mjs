import assert from 'node:assert/strict';
import test from 'node:test';

import { createDesktopQuitSequence, DESKTOP_DAEMON_STOP_TIMEOUT_MS } from './quit-sequence.ts';

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

test('the in-tree daemon stop wait stays bounded: a measured healthy shutdown is ~0.6 s', () => {
  assert.ok(DESKTOP_DAEMON_STOP_TIMEOUT_MS >= 1_000 && DESKTOP_DAEMON_STOP_TIMEOUT_MS <= 5_000);
});
