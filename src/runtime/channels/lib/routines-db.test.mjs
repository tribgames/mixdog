import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const queries = [];
let answer = async () => ({ rows: [] });
const db = {
  exec: async () => {},
  query: async (sql, params) => {
    queries.push({ sql, params });
    return answer(sql, params);
  },
};
mock.module('../../memory/lib/pg/adapter.mjs', {
  namedExports: {
    ensurePgInstance: async () => ({ db, pool: {} }),
    withSchemaBootstrapLock: async (_pool, fn) => fn(),
  },
});
mock.module('../../shared/plugin-paths.mjs', {
  namedExports: { resolvePluginData: () => '/routines-data' },
});

const { deleteRoutinesOwnedBy } = await import('./routines-db.mjs');

test("a bot's routines go in one statement keyed by their current owner, never by a name list", async () => {
  queries.length = 0;
  answer = async () => ({
    rows: [
      { kind: 'webhook', name: 'clerk-hook' },
      { kind: 'schedule', name: 'mail-review' },
      { kind: 'schedule', name: 'inbox-zero' },
    ],
  });
  assert.deepEqual(await deleteRoutinesOwnedBy('clerk'), {
    schedules: ['inbox-zero', 'mail-review'],
    webhooks: ['clerk-hook'],
  });
  assert.equal(queries.length, 1, 'all or nothing: one statement');
  const [{ sql, params }] = queries;
  assert.deepEqual(params, ['clerk']);
  // Every table is matched by the row's owner at delete time: a routine moved
  // to another bot meanwhile is not matched; delivery logs follow their endpoints.
  assert.match(sql, /DELETE FROM scheduler\.schedules WHERE owner_agent_id = \$1/);
  assert.match(sql, /DELETE FROM webhooks\.endpoints WHERE owner_agent_id = \$1/);
  assert.match(sql, /DELETE FROM webhooks\.deliveries WHERE endpoint IN \(SELECT name FROM endpoints\)/);
  assert.doesNotMatch(sql, /\bname\s*=\s*\$/);
});

test('a purge that fails deletes nothing and rejects; an owner is required', async () => {
  queries.length = 0;
  answer = async () => {
    throw new Error('canceling statement due to lock timeout');
  };
  await assert.rejects(deleteRoutinesOwnedBy('clerk'), /lock timeout/);
  assert.equal(queries.length, 1, 'no statement ran besides the one that failed');
  await assert.rejects(deleteRoutinesOwnedBy(''), /an owner is required/);
  assert.equal(queries.length, 1);
});
