import assert from 'node:assert/strict';
import test from 'node:test';
import { createKeyedSerialQueue } from './keyed-serial-queue.mjs';

test('an independent key progresses while one queue is held and then recovers from failure', async () => {
  const run = createKeyedSerialQueue();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const failure = new Error('first operation failed');
  const events = [];
  const first = run('a', async () => {
    entered.resolve();
    await release.promise;
    events.push('first');
    throw failure;
  });
  const failed = assert.rejects(first, (error) => error === failure);
  await entered.promise;
  const second = run('a', () => {
    events.push('second');
    return 2;
  });
  assert.equal(await run('b', () => 3), 3);
  assert.deepEqual(events, []);
  release.resolve();
  await failed;
  assert.equal(await second, 2);
  assert.deepEqual(events, ['first', 'second']);
});
