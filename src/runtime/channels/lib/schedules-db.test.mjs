import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const ensureCalls = [];
const lockCalls = [];
const execCalls = [];
let failFor = null;
let failError = null;
const queryCalls = [];
let queryRows = [];
const db = {
  exec: async (sql) => {
    execCalls.push(sql);
  },
  query: async (sql, params) => {
    queryCalls.push({ sql, params });
    return { rows: queryRows, rowCount: queryRows.length };
  },
};
const pool = { name: 'schedules-pool' };

mock.module('../../memory/lib/pg/adapter.mjs', {
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
mock.module('../../shared/plugin-paths.mjs', {
  namedExports: { resolvePluginData: () => '/resolved-plugin-data' },
});

const {
  listSchedules,
  markScheduleFailure,
  markScheduleSkipped,
  markScheduleSuccess,
  recordScheduleDelivery,
  setEnabled,
  upsertSchedule,
} = await import('./schedules-db.mjs');

// Registered last (below) so the bootstrap-count tests see a fresh module.
const ownershipTest = async () => {
  await listSchedules({ dataDir: '/sched-owner' });
  const ddl = execCalls.at(-1);
  // The idempotent bootstrap migration fills every existing row with 'lead'.
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS owner_agent_id text NOT NULL DEFAULT 'lead'/);
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS last_skipped_at timestamptz/);

  // A model-only row from before routines were bot-based loads as its owner's
  // (Mixy when none); its legacy model/workflow/run_as_agent columns stay in
  // the table but are neither selected nor read.
  queryRows = [
    {
      name: 'legacy',
      prompt: 'p',
      target: 'session',
      owner_agent_id: null,
      model: 'x/y',
      workflow: 'solo',
      run_as_agent: false,
    },
  ];
  const [legacy] = await listSchedules({ dataDir: '/sched-owner' });
  assert.equal(legacy.ownerAgentId, 'lead', 'a row without an owner reads as Mixy');
  for (const key of ['model', 'workflow', 'runAsAgent']) assert.equal(Object.hasOwn(legacy, key), false, key);
  assert.doesNotMatch(queryCalls.at(-1).sql, /\b(model|workflow|run_as_agent)\b/, 'legacy columns are not selected');

  queryRows = [{ name: 'daily', prompt: 'p', target: 'session', owner_agent_id: 'lead' }];
  await upsertSchedule(
    { name: 'daily', prompt: 'p', target: 'session', whenCron: '0 9 * * *' },
    { dataDir: '/sched-owner' }
  );
  let call = queryCalls.at(-1);
  assert.match(call.sql, /owner_agent_id = EXCLUDED\.owner_agent_id/);
  assert.doesNotMatch(call.sql, /\b(model|workflow|run_as_agent)\b/, 'legacy columns are not written');
  assert.equal(call.params.at(-1), 'lead');

  queryRows = [{ name: 'pr', prompt: 'p', target: 'session', owner_agent_id: 'reviewer' }];
  const saved = await upsertSchedule(
    { name: 'pr', prompt: 'p', target: 'session', whenCron: '0 9 * * 1-5', ownerAgentId: 'reviewer' },
    { dataDir: '/sched-owner' }
  );
  call = queryCalls.at(-1);
  assert.equal(call.params.at(-1), 'reviewer');
  assert.equal(saved.ownerAgentId, 'reviewer');

  const at = new Date('2030-01-01T00:00:00Z');
  await markScheduleSkipped('pr', at, { dataDir: '/sched-owner' });
  call = queryCalls.at(-1);
  assert.match(call.sql, /SET last_skipped_at = \$2/);
  assert.deepEqual(call.params, ['pr', at]);
  queryRows = [];
};

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

test('schedule ownership migrates ownerless rows to Mixy and defaults new rows to her', ownershipTest);

test('failures in a row pause a schedule at 5; a success, an edit or switching it on clears them', async () => {
  const opts = { dataDir: '/sched-health' };
  await listSchedules(opts);
  const ddl = execCalls.at(-1);
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0/);
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS result_delivery jsonb/);

  queryRows = [
    { name: 'flaky', consecutive_failures: 5, enabled: false, result_delivery: { run_1: { state: 'failed' } } },
  ];
  const at = new Date('2030-01-01T00:00:00Z');
  const paused = await markScheduleFailure('flaky', at, opts);
  let call = queryCalls.at(-1);
  assert.match(call.sql, /consecutive_failures = consecutive_failures \+ 1/);
  assert.match(call.sql, /enabled = enabled AND consecutive_failures \+ 1 < \$3/);
  assert.deepEqual(call.params, ['flaky', at, 5]);
  assert.equal(paused.consecutiveFailures, 5);
  assert.deepEqual(paused.resultDelivery, { run_1: { state: 'failed' } });

  await markScheduleSuccess('flaky', at, opts);
  assert.match(queryCalls.at(-1).sql, /SET last_success_at = \$2, consecutive_failures = 0/);
  await setEnabled('flaky', true, opts);
  call = queryCalls.at(-1);
  assert.match(call.sql, /consecutive_failures = CASE WHEN \$2 THEN 0 ELSE consecutive_failures END/);
  assert.deepEqual(call.params, ['flaky', true]);
  await upsertSchedule({ name: 'flaky', prompt: 'p', target: 'session', whenCron: '0 9 * * *' }, opts);
  assert.match(queryCalls.at(-1).sql, /consecutive_failures = 0/);

  await recordScheduleDelivery('flaky', 'run_1', { state: 'pending' }, opts);
  call = queryCalls.at(-1);
  assert.match(call.sql, /result_delivery = COALESCE\(result_delivery, '\{\}'::jsonb\) \|\| jsonb_build_object/);
  assert.deepEqual(call.params, ['flaky', 'run_1', '{"state":"pending"}']);
  await recordScheduleDelivery('flaky', 'run_1', null, opts);
  call = queryCalls.at(-1);
  assert.match(call.sql, /NULLIF\(COALESCE\(result_delivery, '\{\}'::jsonb\) - \$2::text, '\{\}'::jsonb\)/);
  assert.deepEqual(call.params, ['flaky', 'run_1']);
  queryRows = [];
});
