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
const pool = { name: 'webhooks-pool' };

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
  listEndpoints,
  markEndpointRun,
  readEndpointLastPayload,
  recordEndpointDelivery,
  recordEndpointEvent,
  setEndpointEnabled,
  upsertEndpoint,
} = await import('./webhooks-db.mjs');
const { listSchedules } = await import('./schedules-db.mjs');

// Registered last (below) so the bootstrap-count tests see a fresh module.
const ownershipTest = async () => {
  await listEndpoints({ dataDir: '/hooks-owner' });
  const ddl = execCalls.at(-1);
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS owner_agent_id text NOT NULL DEFAULT 'lead'/);
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS last_payload jsonb/);

  queryRows = [
    {
      name: 'legacy',
      instructions: 'p',
      enabled: true,
      owner_agent_id: null,
      model: 'x/y',
      workflow: 'solo',
      run_as_agent: false,
      has_last_payload: false,
    },
  ];
  const [legacy] = await listEndpoints({ dataDir: '/hooks-owner' });
  assert.equal(legacy.ownerAgentId, 'lead', 'a row without an owner reads as Mixy');
  for (const key of ['model', 'workflow', 'runAsAgent']) assert.equal(Object.hasOwn(legacy, key), false, key);
  assert.doesNotMatch(queryCalls.at(-1).sql, /\b(model|workflow|run_as_agent)\b/, 'legacy columns are not selected');
  assert.equal(legacy.hasLastPayload, false);
  assert.equal(Object.hasOwn(legacy, 'lastPayload'), false, 'list reads never carry the payload');
  assert.doesNotMatch(queryCalls.at(-1).sql, /SELECT[\s\S]*\blast_payload,/);

  queryRows = [{ name: 'issues', instructions: 'p', enabled: true, owner_agent_id: 'reviewer' }];
  await upsertEndpoint({ name: 'issues', instructions: 'p' }, { dataDir: '/hooks-owner' });
  let call = queryCalls.at(-1);
  assert.match(call.sql, /owner_agent_id = EXCLUDED\.owner_agent_id/);
  assert.doesNotMatch(call.sql, /last_payload\s*=/, 'an edit keeps the last event');
  assert.equal(call.params.at(-1), 'lead');
  await upsertEndpoint(
    { name: 'issues', instructions: 'p', ownerAgentId: 'reviewer', model: 'x/y' },
    { dataDir: '/hooks-owner' }
  );
  assert.equal(queryCalls.at(-1).params.at(-1), 'reviewer');
  assert.doesNotMatch(queryCalls.at(-1).sql, /\b(model|workflow|run_as_agent)\b/, 'legacy columns are not written');

  const at = new Date('2030-01-01T00:00:00Z');
  await recordEndpointEvent('issues', { body: { a: 1 }, headers: {} }, at, { dataDir: '/hooks-owner' });
  call = queryCalls.at(-1);
  assert.match(call.sql, /SET last_event_at = \$2, last_payload = \$3/);
  assert.deepEqual(call.params, ['issues', at, '{"body":{"a":1},"headers":{}}']);
  await markEndpointRun('issues', 'skipped', at, { dataDir: '/hooks-owner' });
  assert.match(queryCalls.at(-1).sql, /SET last_skipped_at = \$2 WHERE/, 'a skip leaves the failure streak');
  // Failures in a row switch it off at 5; a success, an edit or switching it on clear them.
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0/);
  assert.match(ddl, /ADD COLUMN IF NOT EXISTS result_delivery jsonb/);
  await markEndpointRun('issues', 'failed', at, { dataDir: '/hooks-owner' });
  call = queryCalls.at(-1);
  assert.match(call.sql, /enabled = enabled AND consecutive_failures \+ 1 < \$3/);
  assert.deepEqual(call.params, ['issues', at, 5]);
  await markEndpointRun('issues', 'success', at, { dataDir: '/hooks-owner' });
  assert.match(queryCalls.at(-1).sql, /SET last_success_at = \$2, consecutive_failures = 0 WHERE/);
  await setEndpointEnabled('issues', true, { dataDir: '/hooks-owner' });
  assert.match(queryCalls.at(-1).sql, /consecutive_failures = CASE WHEN \$2 THEN 0 ELSE consecutive_failures END/);
  await recordEndpointDelivery('issues', 'run_w1', { state: 'failed' }, { dataDir: '/hooks-owner' });
  assert.deepEqual(queryCalls.at(-1).params, ['issues', 'run_w1', '{"state":"failed"}']);
  await recordEndpointDelivery('issues', 'run_w1', null, { dataDir: '/hooks-owner' });
  assert.match(queryCalls.at(-1).sql, /'\{\}'::jsonb\) - \$2::text/);
  await assert.rejects(markEndpointRun('issues', 'bogus', at, { dataDir: '/hooks-owner' }), /unknown outcome/);
  queryRows = [{ last_payload: { body: { a: 1 }, headers: {} } }];
  assert.deepEqual(await readEndpointLastPayload('issues', { dataDir: '/hooks-owner' }), {
    body: { a: 1 },
    headers: {},
  });
  queryRows = [];
};

test('webhooks-db bootstraps the webhooks schema once per dataDir', async () => {
  await listEndpoints({ dataDir: '/hooks-a' });
  await listEndpoints({ dataDir: '/hooks-a' });
  assert.deepEqual(
    ensureCalls.map(({ dataDir, opts }) => ({ dataDir, schema: opts.schema })),
    [{ dataDir: '/hooks-a', schema: 'webhooks' }]
  );
  // The init gets the shared cancellation signal; a caller without one never withdraws it.
  assert.ok(ensureCalls[0].opts.signal instanceof AbortSignal);
  assert.equal(ensureCalls[0].opts.signal.aborted, false);
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

test('webhook ownership migrates ownerless endpoints to Mixy; events and run stamps are kept apart', ownershipTest);
