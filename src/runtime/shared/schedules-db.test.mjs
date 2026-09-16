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
const pool = { name: 'schedules-pool' };

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

const { listSchedules } = await import('./schedules-db.mjs');

test('schedules-db bootstraps the scheduler schema once per dataDir', async () => {
  await listSchedules({ dataDir: '/sched-a' });
  await listSchedules({ dataDir: '/sched-a' });
  assert.deepEqual(ensureCalls, [{ dataDir: '/sched-a', opts: { schema: 'scheduler' } }]);
  assert.deepEqual(lockCalls, [pool]);
  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0], /CREATE TABLE IF NOT EXISTS scheduler\.schedules/);
  assert.match(execCalls[0], /CONSTRAINT schedules_when_xor CHECK/);
});

test('omitted schedules dataDir uses resolvePluginData and retries the same failure', async () => {
  await listSchedules();
  assert.deepEqual(ensureCalls.at(-1), { dataDir: '/resolved-plugin-data', opts: { schema: 'scheduler' } });

  const boom = new Error('schedules pg down');
  failFor = '/sched-fail';
  failError = boom;
  const lockBefore = lockCalls.length;
  await assert.rejects(
    () => listSchedules({ dataDir: '/sched-fail' }),
    (error) => error === boom
  );
  assert.equal(lockCalls.length, lockBefore);
  failFor = null;
  await listSchedules({ dataDir: '/sched-fail' });
  assert.equal(ensureCalls.at(-1).dataDir, '/sched-fail');
  assert.equal(lockCalls.at(-1), pool);
});
