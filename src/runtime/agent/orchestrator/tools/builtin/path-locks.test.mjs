import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import { _pathLockCountForTest, withPathLock } from './path-locks.mjs';

test('a settled path lock leaves no entry behind', async () => {
  const before = _pathLockCountForTest();
  await withPathLock('/tmp/path-lock-a', async () => 'done');
  await assert.rejects(
    withPathLock('/tmp/path-lock-b', async () => {
      throw new Error('boom');
    })
  );
  await nextTurn();
  assert.equal(_pathLockCountForTest(), before);
});

test('overlapping calls on one path still run in order and then release', async () => {
  const before = _pathLockCountForTest();
  const order = [];
  let releaseFirst;
  const first = withPathLock('/tmp/path-lock-c', () => new Promise((resolve) => (releaseFirst = resolve)));
  const second = withPathLock('/tmp/path-lock-c', async () => order.push('second'));
  await nextTurn();
  order.push('first-open');
  releaseFirst();
  await Promise.all([first, second]);
  await nextTurn();
  assert.deepEqual(order, ['first-open', 'second']);
  assert.equal(_pathLockCountForTest(), before);
});
