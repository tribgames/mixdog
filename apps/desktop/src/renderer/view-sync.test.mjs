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
    synchronize: () => { const request = Promise.withResolvers(); reads.push(request); return request.promise; },
    state: (state) => states.push(state), error: () => {},
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
    requestFrame: (callback) => { flush = callback; return 1; },
    cancelFrame() {},
    onError: () => { throw new Error('diagnostic failure'); },
  });
  coordinator.schedule({}, () => { throw new Error('pane failure'); });
  coordinator.schedule({}, () => seen.push('sibling updated'));
  flush(0);
  assert.deepEqual(seen, ['sibling updated']);
});

test('only interrupted durable creations are retried, not application errors', async () => {
  let attempts = 0, recoveries = 0;
  const result = await recoverableCreation(async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('lost receipt'), { code: 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED' });
    return 'same-session';
  }, async () => { recoveries++; });
  assert.equal(result, 'same-session');
  assert.equal(attempts, 2);
  assert.equal(recoveries, 1);
  await assert.rejects(recoverableCreation(async () => { throw new Error('invalid project'); },
    async () => { throw new Error('must not retry'); }), /invalid project/);
});
