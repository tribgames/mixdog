import assert from 'node:assert/strict';
import test from 'node:test';

import { createSyncWaiters } from './sync-waiters.mjs';

test('settling one session resolves every matching waiter in order and leaves other sessions waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sync = createSyncWaiters();
  const settled = [];
  const first = sync.wait('session-a', 10).then((value) => settled.push(['first', value]));
  const other = sync.wait('session-b', 20).then((value) => settled.push(['other', value]));
  const last = sync.wait('session-a', 30).then((value) => settled.push(['last', value]));

  sync.settle('session-a', true);
  await Promise.all([first, last]);
  assert.deepEqual(settled, [
    ['first', true],
    ['last', true],
  ]);

  t.mock.timers.tick(20);
  await other;
  assert.deepEqual(settled, [
    ['first', true],
    ['last', true],
    ['other', false],
  ]);
});

test('failing all sync waiters resolves mixed sessions in order without affecting later waits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sync = createSyncWaiters();
  const order = [];
  const pending = ['session-a', 'session-b', 'session-a'].map((id, index) =>
    sync.wait(id, 100).then((value) => {
      order.push(index);
      return value;
    })
  );

  sync.failAll();
  assert.deepEqual(await Promise.all(pending), [false, false, false]);
  assert.deepEqual(order, [0, 1, 2]);

  const next = sync.wait('session-c', 100);
  sync.settle('session-c', true);
  assert.equal(await next, true);
});
