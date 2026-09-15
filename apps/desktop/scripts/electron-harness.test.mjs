import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import test from 'node:test';

import {
  electronProcessEnv,
  waitForChildExit,
  withTempWorkspace,
} from './electron-harness.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

test('electronProcessEnv copies extras and always drops ELECTRON_RUN_AS_NODE', () => {
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const env = electronProcessEnv({ MIXDOG_HARNESS: '1', ELECTRON_RUN_AS_NODE: '1' });
    assert.equal(env.MIXDOG_HARNESS, '1');
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous;
  }
});

test('waitForChildExit returns the child status and coalesces a missing code to 124', async () => {
  const zero = fakeChild();
  const zeroDone = waitForChildExit(zero);
  zero.emit('exit', 0, null);
  assert.equal(await zeroDone, 0);

  const missing = fakeChild();
  const missingDone = waitForChildExit(missing, { fallbackCode: 124 });
  missing.emit('exit', null, null);
  assert.equal(await missingDone, 124);
});

test('waitForChildExit rejects the default signalMessage', async () => {
  const child = fakeChild();
  const pending = waitForChildExit(child);
  child.emit('exit', null, 'SIGTERM');
  await assert.rejects(pending, /process was terminated by SIGTERM/);
});

test('waitForChildExit rejects an error event', async () => {
  const child = fakeChild();
  const pending = waitForChildExit(child);
  child.emit('error', new Error('spawn ENOENT'));
  await assert.rejects(pending, /spawn ENOENT/);
});

test('waitForChildExit timeout kills once and settles once', async () => {
  const child = fakeChild();
  let kills = 0;
  child.kill = () => {
    kills += 1;
  };
  const late = [];
  const onUnhandled = (error) => late.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      waitForChildExit(child, {
        timeoutMs: 15,
        timeoutMessage: 'harness fixture exceeded 15ms',
      }),
      /harness fixture exceeded 15ms/,
    );
    assert.equal(kills, 1);
    child.emit('error', new Error('late error'));
    child.emit('exit', null, 'SIGKILL');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(late, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('waitForChildExit kill-on-timeout uses fallback 124 for a null code', async () => {
  const child = fakeChild();
  child.kill = () => {
    child.emit('exit', null, 'SIGTERM');
  };
  let timedOut = false;
  const code = await waitForChildExit(child, {
    timeoutMs: 15,
    onTimeout: 'kill',
    rejectOnSignal: false,
    fallbackCode: 124,
    onTimedOut: () => {
      timedOut = true;
    },
  });
  assert.equal(timedOut, true);
  assert.equal(code, 124);
});

test('withTempWorkspace removes the staging directory after success and failure', async () => {
  let kept;
  await withTempWorkspace('mixdog-harness-ok-', async (staging) => {
    kept = staging;
  });
  await assert.rejects(access(kept), { code: 'ENOENT' });

  let failed;
  await assert.rejects(
    withTempWorkspace('mixdog-harness-fail-', async (staging) => {
      failed = staging;
      throw new Error('fixture failed');
    }),
    /fixture failed/,
  );
  await assert.rejects(access(failed), { code: 'ENOENT' });
});
