import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorSurfacePool } from './editor-surface-pool.ts';

test('tab switches reuse one surface and stale releases cannot dispose its new owner', async () => {
  const pool = new EditorSurfacePool();
  let created = 0;
  let disposed = 0;
  const detached = [];
  const create = () => {
    created++;
    return { editor: { dispose: () => disposed++ }, element: { remove() {} } };
  };
  const a = {};
  const b = {};
  const first = pool.acquire('pane', a, create, () => detached.push('a'));
  pool.release('pane', a);
  assert.equal(pool.acquire('pane', b, create, () => detached.push('b')), first);
  pool.release('pane', a);
  await Promise.resolve();
  assert.equal(created, 1);
  assert.equal(disposed, 0);
  assert.deepEqual(detached, ['a']);
  pool.release('pane', b);
  await Promise.resolve();
  assert.equal(disposed, 1);
  assert.deepEqual(detached, ['a', 'b']);
});

test('split panes have independent surfaces and unused panes have none', async () => {
  const pool = new EditorSurfacePool();
  let created = 0;
  let disposed = 0;
  const create = () => {
    created++;
    return { editor: { dispose: () => disposed++ }, element: { remove() {} } };
  };
  await Promise.resolve();
  assert.equal(created, 0);
  const a = {};
  const b = {};
  assert.notEqual(pool.acquire('left', a, create, () => {}), pool.acquire('right', b, create, () => {}));
  pool.release('left', a);
  await Promise.resolve();
  assert.equal(disposed, 1);
  pool.release('right', b);
  await Promise.resolve();
  assert.equal(disposed, 2);
});
