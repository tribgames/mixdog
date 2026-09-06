import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteCallQueue } from './remote-call-queue.ts';

const deferred = () => Promise.withResolvers();

test('a slow read does not block another read; mutations remain ordered barriers', async () => {
  const queue = createRemoteCallQueue(2);
  const slow = deferred();
  const started = deferred();
  const seen = [];
  const first = queue.run('readProjectFile', async () => {
    seen.push('read-start');
    started.resolve();
    await slow.promise;
    seen.push('read-end');
  });
  await started.promise;
  await queue.run('getSnapshot', async () => { seen.push('snapshot'); });
  assert.deepEqual(seen, ['read-start', 'snapshot']);
  const write = queue.run('writeProjectFile', async () => { seen.push('write'); });
  const after = queue.run('getSnapshot', async () => { seen.push('after-write'); });
  await Promise.resolve();
  assert.equal(seen.includes('write'), false);
  slow.resolve();
  await Promise.all([first, write, after]);
  assert.deepEqual(seen, ['read-start', 'snapshot', 'read-end', 'write', 'after-write']);
});

test('read concurrency is bounded and disconnect never starts queued mutations', async () => {
  const queue = createRemoteCallQueue(2);
  const gate = deferred();
  let active = 0, peak = 0, writes = 0;
  const reads = Array.from({ length: 5 }, () => queue.run('getSnapshot', async () => {
    active += 1; peak = Math.max(peak, active);
    await gate.promise;
    active -= 1;
  }));
  const write = queue.run('submitToSession', async () => { writes += 1; });
  const settled = Promise.allSettled([...reads, write]);
  await Promise.resolve();
  assert.equal(peak, 2);
  queue.close();
  gate.resolve();
  const results = await settled;
  assert.equal(writes, 0);
  assert.equal(results.filter((row) => row.status === 'rejected').length, 4);
});
