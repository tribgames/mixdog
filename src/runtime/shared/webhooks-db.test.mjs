import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const ensureCalls = [];
const lockCalls = [];
const execCalls = [];
let failFor = null;
let failError = null;
const db = {
  exec: async (sql) => {
    execCalls.push(sql);
  },
  query: async () => ({ rows: [], rowCount: 0 }),
};
const pool = { name: 'webhooks-pool' };

mock.module('../memory/lib/pg/adapter.mjs', {
  namedExports: {
    ensurePgInstance: async (dataDir, opts) => {
      ensureCalls.push({ dataDir, opts });
      if (failFor === dataDir) throw failError;
      return { db, pool };
    },
    withSchemaBootstrapLock: async (pgPool, fn) => {
      lockCalls.push(pgPool);
      return fn();
    },
  },
});
mock.module('./plugin-paths.mjs', {
  namedExports: { resolvePluginData: () => '/resolved-plugin-data' },
});

const { listEndpoints } = await import('./webhooks-db.mjs');
const { listSchedules } = await import('./schedules-db.mjs');

test('webhooks-db bootstraps the webhooks schema once per dataDir', async () => {
  await listEndpoints({ dataDir: '/hooks-a' });
  await listEndpoints({ dataDir: '/hooks-a' });
  assert.deepEqual(ensureCalls, [{ dataDir: '/hooks-a', opts: { schema: 'webhooks' } }]);
  assert.deepEqual(lockCalls, [pool]);
  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0], /CREATE SCHEMA IF NOT EXISTS webhooks/);
  assert.match(execCalls[0], /CREATE TABLE IF NOT EXISTS webhooks\.endpoints/);
  assert.match(execCalls[0], /CREATE TABLE IF NOT EXISTS webhooks\.deliveries/);
});

test('webhooks keep a separate cache from schedules and retry the same failure', async () => {
  const ensureBefore = ensureCalls.length;
  const execBefore = execCalls.length;
  await listSchedules({ dataDir: '/shared' });
  await listEndpoints({ dataDir: '/shared' });
  assert.deepEqual(
    ensureCalls.slice(ensureBefore).map((entry) => entry.opts.schema),
    ['scheduler', 'webhooks']
  );
  const newExec = execCalls.slice(execBefore);
  assert.equal(newExec.filter((sql) => sql.includes('scheduler.schedules')).length, 1);
  assert.equal(newExec.filter((sql) => sql.includes('webhooks.endpoints')).length, 1);

  const boom = new Error('webhooks pg down');
  failFor = '/hooks-fail';
  failError = boom;
  const lockBefore = lockCalls.length;
  await assert.rejects(
    () => listEndpoints({ dataDir: '/hooks-fail' }),
    (error) => error === boom
  );
  assert.equal(lockCalls.length, lockBefore);
  failFor = null;
  await listEndpoints({ dataDir: '/hooks-fail' });
  assert.equal(ensureCalls.at(-1).dataDir, '/hooks-fail');
  assert.equal(ensureCalls.at(-1).opts.schema, 'webhooks');
});
