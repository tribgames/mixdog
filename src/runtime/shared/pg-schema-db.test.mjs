import assert from 'node:assert/strict';
import test from 'node:test';

import { createPgSchemaDb } from './pg-schema-db.mjs';

function opener(overrides = {}) {
  const calls = { ensure: [], lock: [], exec: [] };
  const handles = new Map();
  const getDb = createPgSchemaDb({
    schema: 'scheduler',
    ddl: 'DDL-SCHEDULER',
    defaultDataDir: () => '/plugin-data',
    ensurePg: async (dataDir, opts) => {
      calls.ensure.push({ dataDir, opts });
      const handle = handles.get(dataDir) ?? {
        db: {
          exec: async (sql) => {
            calls.exec.push({ dataDir, sql });
          },
        },
        pool: { dataDir },
      };
      handles.set(dataDir, handle);
      return handle;
    },
    withLock: async (pool, fn) => {
      calls.lock.push(pool);
      return fn();
    },
    ...overrides,
  });
  return { getDb, calls, handles };
}

test('same dataDir shares in-flight init and runs locked DDL once', async () => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const { getDb, calls } = opener({
    ensurePg: async (dataDir, opts) => {
      calls.ensure.push({ dataDir, opts });
      started.resolve();
      await gate.promise;
      return {
        db: {
          exec: async (sql) => {
            calls.exec.push({ dataDir, sql });
          },
        },
        pool: { dataDir },
      };
    },
  });
  const first = getDb('/a');
  await started.promise;
  const second = getDb('/a');
  gate.resolve();
  assert.equal(await first, await second);
  assert.equal(calls.ensure.length, 1);
  assert.deepEqual(calls.ensure[0], { dataDir: '/a', opts: { schema: 'scheduler' } });
  assert.deepEqual(calls.lock, [{ dataDir: '/a' }]);
  assert.deepEqual(calls.exec, [{ dataDir: '/a', sql: 'DDL-SCHEDULER' }]);
});

test('distinct dataDir keys keep separate handles', async () => {
  const { getDb, calls, handles } = opener();
  const a = await getDb('/a');
  const b = await getDb('/b');
  assert.notEqual(a, b);
  assert.equal(a, handles.get('/a').db);
  assert.equal(b, handles.get('/b').db);
  assert.equal(calls.ensure.length, 2);
});

test('omitted and undefined dataDir use the default key without aliasing an explicit path', async () => {
  const { getDb, calls, handles } = opener();
  const implied = await getDb();
  assert.equal(await getDb(undefined), implied);
  assert.equal(calls.ensure.length, 1);
  assert.equal(calls.ensure[0].dataDir, '/plugin-data');
  const explicit = await getDb('/other');
  assert.notEqual(explicit, implied);
  assert.equal(explicit, handles.get('/other').db);
});

test('init failure evicts the cache and rethrows the same error', async () => {
  const boom = new Error('pg down');
  let fail = true;
  const { getDb, calls } = opener({
    ensurePg: async (dataDir, opts) => {
      calls.ensure.push({ dataDir, opts });
      if (fail) throw boom;
      return {
        db: {
          exec: async (sql) => {
            calls.exec.push({ dataDir, sql });
          },
        },
        pool: { dataDir },
      };
    },
  });
  await assert.rejects(
    () => getDb('/a'),
    (error) => error === boom
  );
  assert.equal(calls.lock.length, 0);
  fail = false;
  const db = await getDb('/a');
  assert.equal(calls.ensure.length, 2);
  assert.equal(calls.exec.length, 1);
  assert.equal(await getDb('/a'), db);
});

test('lock failure also evicts and preserves error identity', async () => {
  const boom = new Error('lock busy');
  let fail = true;
  const { getDb, calls } = opener({
    withLock: async (pool, fn) => {
      calls.lock.push(pool);
      if (fail) throw boom;
      return fn();
    },
  });
  await assert.rejects(
    () => getDb('/a'),
    (error) => error === boom
  );
  fail = false;
  await getDb('/a');
  assert.equal(calls.lock.length, 2);
  assert.equal(calls.exec.length, 1);
});

test('each opener keeps its own schema, DDL and cache', async () => {
  const calls = { ensure: [], exec: [] };
  const ensurePg = async (dataDir, opts) => {
    calls.ensure.push({ dataDir, opts });
    return {
      db: {
        exec: async (sql) => {
          calls.exec.push(sql);
        },
      },
      pool: { schema: opts.schema },
    };
  };
  const withLock = async (_pool, fn) => fn();
  const schedules = createPgSchemaDb({
    schema: 'scheduler',
    ddl: 'DDL-SCHEDULER',
    defaultDataDir: () => '/plugin-data',
    ensurePg,
    withLock,
  });
  const webhooks = createPgSchemaDb({
    schema: 'webhooks',
    ddl: 'DDL-WEBHOOKS',
    defaultDataDir: () => '/plugin-data',
    ensurePg,
    withLock,
  });
  const schedDb = await schedules('/shared');
  const hookDb = await webhooks('/shared');
  assert.notEqual(schedDb, hookDb);
  assert.deepEqual(
    calls.ensure.map((entry) => entry.opts.schema),
    ['scheduler', 'webhooks']
  );
  assert.deepEqual(calls.exec, ['DDL-SCHEDULER', 'DDL-WEBHOOKS']);
  assert.equal(await schedules('/shared'), schedDb);
  assert.equal(await webhooks('/shared'), hookDb);
  assert.equal(calls.ensure.length, 2);
});
