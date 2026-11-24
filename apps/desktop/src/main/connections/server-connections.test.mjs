import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectionPool } from './pool.ts';
import { createServerConnections } from './server-connections.ts';

function fixture({ failStart = false, detached } = {}) {
  const pool = new ConnectionPool();
  const made = [];
  const connections = createServerConnections({
    pool,
    detached,
    create: (record) => {
      const connection = {
        id: record.id,
        kind: 'ssh',
        started: false,
        disposed: false,
        start: async () => {
          if (failStart) throw new Error('no dial');
          connection.started = true;
        },
        dispose: async () => {
          connection.disposed = true;
        },
      };
      made.push(connection);
      return connection;
    },
  });
  return { pool, made, connections };
}

test('a server window gets its connection started and in the pool, once per server', async () => {
  const { pool, made, connections } = fixture();
  const first = await connections.attach({ id: 'srv' });
  assert.equal(first.started, true);
  assert.equal(pool.get('srv'), first);
  assert.equal(await connections.attach({ id: 'srv' }), first);
  assert.equal(made.length, 1);
});

test('a connection that cannot start leaves nothing in the pool and is closed', async () => {
  const { pool, made, connections } = fixture({ failStart: true });
  await assert.rejects(connections.attach({ id: 'srv' }), /no dial/);
  assert.equal(pool.has('srv'), false);
  assert.equal(made[0].disposed, true);
});

test('detaching drops the connection from the pool and closes it', async () => {
  const { pool, made, connections } = fixture();
  await connections.attach({ id: 'srv' });
  await connections.detach('srv');
  assert.equal(pool.has('srv'), false);
  assert.equal(made[0].disposed, true);
  await connections.detach('srv');
});

test('quitting closes every server connection and leaves this PC out of it', async () => {
  const { pool, made, connections } = fixture();
  const local = { id: 'local', kind: 'local' };
  pool.add(local);
  await connections.attach({ id: 'a' });
  await connections.attach({ id: 'b' });
  await connections.closeAll();
  assert.deepEqual(
    made.map((connection) => connection.disposed),
    [true, true]
  );
  assert.deepEqual(pool.list(), [local]);
});

test('a detached server connection is reported gone, also when it cannot close', async () => {
  const gone = [];
  const { made, connections } = fixture({ detached: (id) => gone.push(id) });
  await connections.attach({ id: 'srv' });
  made[0].dispose = async () => {
    throw new Error('stuck');
  };
  await assert.rejects(connections.detach('srv'), /stuck/);
  assert.deepEqual(gone, ['srv']);
});

test('a detach that finishes after a re-attach of the same id does not report the new connection gone', async () => {
  const gone = [];
  const { made, connections } = fixture({ detached: (id) => gone.push(id) });
  await connections.attach({ id: 'srv' });
  let finish;
  made[0].dispose = () => new Promise((resolve) => (finish = resolve));
  const detaching = connections.detach('srv');
  await connections.attach({ id: 'srv' });
  finish();
  await detaching;
  assert.deepEqual(gone, []);
});
