import assert from 'node:assert/strict';
import test from 'node:test';

import { createDaemonBootCoordinator } from './daemon-boot-coordinator.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

test('desktop registration starts keychain but waits for the ready handshake before recovery', async () => {
  const scheduled = [];
  const events = [];
  const keychain = deferred();
  const coordinator = createDaemonBootCoordinator({
    schedule: (task) => scheduled.push(task),
    prewarmKeychain: async () => {
      events.push('keychain-start');
      await keychain.promise;
      events.push('keychain-ready');
    },
    recoverActiveGoals: async () => {
      events.push('recovery');
      return { found: 0, resumed: 0, skipped: 0, failed: 0 };
    },
  });

  coordinator.notifyClientRegistered({ clientKind: 'desktop' });
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  await Promise.resolve();
  assert.deepEqual(events, ['keychain-start']);

  await Promise.resolve();
  assert.deepEqual(events, ['keychain-start'], 'registration alone never starts runtime recovery');
  assert.deepEqual(coordinator.notifyDesktopReady(), { ok: true });
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  await Promise.resolve();
  assert.deepEqual(events, ['keychain-start'], 'background work joins the earlier keychain task');

  keychain.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['keychain-start', 'keychain-ready', 'recovery']);
});

test('ordinary session registration opens the background lane after registration', async () => {
  const scheduled = [];
  const events = [];
  const coordinator = createDaemonBootCoordinator({
    schedule: (task) => scheduled.push(task),
    prewarmKeychain: async () => { events.push('keychain'); },
    recoverActiveGoals: async () => {
      events.push('recovery');
      return { found: 0, resumed: 0, skipped: 0, failed: 0 };
    },
  });

  coordinator.notifyClientRegistered({ clientKind: 'session' });
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['keychain', 'recovery']);
});
