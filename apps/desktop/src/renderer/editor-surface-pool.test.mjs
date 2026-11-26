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
  assert.equal(
    pool.acquire('pane', b, create, () => detached.push('b')),
    first
  );
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
  assert.notEqual(
    pool.acquire('left', a, create, () => {}),
    pool.acquire('right', b, create, () => {})
  );
  pool.release('left', a);
  await Promise.resolve();
  assert.equal(disposed, 1);
  pool.release('right', b);
  await Promise.resolve();
  assert.equal(disposed, 2);
});

test('pool notifies onActive on first mount, ignores tab switches, and notifies onEmpty only when the last surface releases', async () => {
  const events = [];
  const pool = new EditorSurfacePool({
    onActive: () => events.push('active'),
    onEmpty: () => events.push('empty'),
  });
  const create = () => ({ editor: { dispose() {} }, element: { remove() {} } });
  const a = {};
  const b = {};
  const c = {};

  pool.acquire('left', a, create, () => {});
  assert.deepEqual(events, ['active']);

  // Tab switch within the same pane keeps the pool active.
  pool.release('left', a);
  pool.acquire('left', b, create, () => {});
  await Promise.resolve();
  assert.deepEqual(events, ['active']);

  // Second split pane does not re-trigger onActive, and closing one pane does not trigger onEmpty.
  pool.acquire('right', c, create, () => {});
  pool.release('right', c);
  await Promise.resolve();
  assert.deepEqual(events, ['active']);

  // Releasing the last surface fires onEmpty; acquiring again fires onActive.
  pool.release('left', b);
  await Promise.resolve();
  assert.deepEqual(events, ['active', 'empty']);

  pool.acquire('left', a, create, () => {});
  assert.deepEqual(events, ['active', 'empty', 'active']);
});
