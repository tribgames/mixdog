import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createRemoteViewSync } from './remote-view-sync.ts';
import { createFrameCoordinator } from './interaction-frame-scheduler.ts';
import { recoverableCreation } from './recoverable-creation.ts';

test('only the latest subscription and connection may complete synchronization', async () => {
  const reads = [];
  const states = [];
  const sync = createRemoteViewSync({
    synchronize: () => {
      const request = Promise.withResolvers();
      reads.push(request);
      return request.promise;
    },
    state: (state) => states.push(state),
    error: () => {},
    interrupted: () => new Error('interrupted'),
  });
  sync.open();
  const firstReady = sync.request();
  firstReady.catch(() => {});
  reads[0].resolve();
  await setImmediate();
  assert.equal(states.includes('connected'), false);
  assert.equal(reads.length, 2);
  sync.close();
  await assert.rejects(firstReady, /interrupted/);
  sync.open();
  reads[1].resolve(); // Obsolete completion must not release the replacement.
  await setImmediate();
  assert.equal(states.includes('connected'), false);
  const ready = sync.ready();
  reads[2].resolve();
  await ready;
  assert.equal(states.at(-1), 'connected');
  sync.close();
});

test('one failing pane or diagnostic cannot discard a sibling scheduled update', () => {
  let flush;
  const seen = [];
  const coordinator = createFrameCoordinator({
    requestFrame: (callback) => {
      flush = callback;
      return 1;
    },
    cancelFrame() {},
    onError: () => {
      throw new Error('diagnostic failure');
    },
  });
  coordinator.schedule({}, () => {
    throw new Error('pane failure');
  });
  coordinator.schedule({}, () => seen.push('sibling updated'));
  flush(0);
  assert.deepEqual(seen, ['sibling updated']);
});

test('only interrupted durable creations are retried, not application errors', async () => {
  let attempts = 0,
    recoveries = 0;
  const result = await recoverableCreation(
    async () => {
      attempts++;
      if (attempts === 1)
        throw Object.assign(new Error('lost receipt'), { code: 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED' });
      return 'same-session';
    },
    async () => {
      recoveries++;
    }
  );
  assert.equal(result, 'same-session');
  assert.equal(attempts, 2);
  assert.equal(recoveries, 1);
  await assert.rejects(
    recoverableCreation(
      async () => {
        throw new Error('invalid project');
      },
      async () => {
        throw new Error('must not retry');
      }
    ),
    /invalid project/
  );
});

test('three failed synchronizations in a row recycle the connection, and a new connection retries at full speed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  let recycled = 0;
  let failing = true;
  const sync = createRemoteViewSync({
    synchronize: async () => {
      attempts += 1;
      if (failing) throw new Error('host rejected the sync');
    },
    state: () => {},
    error: () => {},
    interrupted: () => new Error('interrupted'),
    recycle: () => {
      recycled += 1;
    },
  });
  sync.open();
  const waiting = sync.ready();
  waiting.catch(() => {});
  await setImmediate();
  assert.equal(attempts, 1);
  t.mock.timers.tick(250);
  await setImmediate();
  assert.equal(attempts, 2);
  assert.equal(recycled, 0);
  t.mock.timers.tick(500);
  await setImmediate();
  assert.equal(attempts, 3);
  assert.equal(recycled, 1, 'the third failure asks the owner for a fresh connection');
  // The owner's recycle closes this connection, which ends every wait.
  sync.close();
  await assert.rejects(waiting, /interrupted/);

  // The replacement connection must not inherit the grown backoff.
  failing = false;
  sync.open();
  await setImmediate();
  assert.equal(attempts, 4);
  failing = true;
  const attemptsBefore = attempts;
  sync.close();
  failing = true;
  sync.open();
  await setImmediate();
  assert.equal(attempts, attemptsBefore + 1);
  t.mock.timers.tick(250);
  await setImmediate();
  assert.equal(attempts, attemptsBefore + 2, 'first retry after open waits the base delay, not the previous 1 s+');
  sync.close();
});
