import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const queries = [];
const backfillStore = new Map();
const indexedSessionIds = [];
const db = {
  exec: async () => {},
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (/INSERT INTO session_search\.messages/.test(sql)) return { rows: [], rowCount: params[0].length };
    if (/SELECT session_id, stamp/.test(sql)) {
      return {
        rows: [...backfillStore].map(([session_id, stamp]) => ({ session_id, stamp })),
        rowCount: backfillStore.size,
      };
    }
    if (/SELECT DISTINCT session_id/.test(sql)) {
      return { rows: indexedSessionIds.map((session_id) => ({ session_id })), rowCount: indexedSessionIds.length };
    }
    if (/INSERT INTO session_search\.backfill/.test(sql)) backfillStore.set(params[0], params[1]);
    return { rows: [], rowCount: 0 };
  },
};
mock.module('../memory/lib/pg/adapter.mjs', {
  namedExports: {
    ensurePgInstance: async () => ({ db, pool: {} }),
    withSchemaBootstrapLock: async (_pool, fn) => fn(),
  },
});
mock.module('../shared/plugin-paths.mjs', {
  namedExports: { resolvePluginData: () => '/resolved-plugin-data' },
});

const { ingestSessionTurn, forgetSessionSearch, backfillSessionSearch } = await import('./session-search-ingest.mjs');

const inserts = () => queries.filter((q) => /INSERT INTO session_search\.messages/.test(q.sql));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const ordinary = (id, extra = {}) => ({
  id,
  agent: 'lead',
  messages: [
    { role: 'user', content: 'hello world' },
    { role: 'assistant', content: 'hi there' },
  ],
  ...extra,
});

test('ingestSessionTurn stores an ordinary session once per transcript length', async () => {
  queries.length = 0;
  ingestSessionTurn(ordinary('sess_a'));
  await settle();
  assert.equal(inserts().length, 1);
  ingestSessionTurn(ordinary('sess_a'));
  await settle();
  assert.equal(inserts().length, 1);
  const grown = ordinary('sess_a');
  grown.messages.push({ role: 'user', content: 'more' });
  ingestSessionTurn(grown);
  await settle();
  assert.equal(inserts().length, 2);
});

test('ingestSessionTurn skips agent-only sessions and never throws', async () => {
  queries.length = 0;
  ingestSessionTurn(ordinary('sess_child', { agent: 'worker', owner: 'agent', parentSessionId: 'sess_a' }));
  ingestSessionTurn(null);
  await settle();
  assert.equal(inserts().length, 0);
});

test('forgetSessionSearch deletes messages and swallows failures', async () => {
  queries.length = 0;
  await forgetSessionSearch('sess_a');
  assert.ok(queries.some((q) => /DELETE FROM session_search\.messages/.test(q.sql) && q.params[0] === 'sess_a'));
  const original = db.query;
  db.query = async () => {
    throw new Error('pg down');
  };
  await forgetSessionSearch('sess_a');
  db.query = original;
});

test('backfill ingests changed sessions only and records stamps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-backfill-'));
  try {
    writeFileSync(join(dir, 'sess_x.json'), JSON.stringify(ordinary('sess_x')));
    writeFileSync(
      join(dir, 'sess_y.json'),
      JSON.stringify(ordinary('sess_y', { agent: 'worker', owner: 'agent', parentSessionId: 'sess_x' }))
    );
    const deps = {
      dir,
      readSession: (d, file) => JSON.parse(require_read(d, file)),
    };
    queries.length = 0;
    backfillStore.clear();
    assert.equal(await backfillSessionSearch({ deps }), 1);
    assert.equal(inserts().length, 1);
    assert.deepEqual([...backfillStore.keys()], ['sess_x']);
    queries.length = 0;
    assert.equal(await backfillSessionSearch({ deps }), 0);
    assert.equal(inserts().length, 0);
    writeFileSync(join(dir, 'sess_x.json'), JSON.stringify(ordinary('sess_x', { title: 'changed' })));
    assert.equal(await backfillSessionSearch({ deps }), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backfill drops the rows of sessions whose file is gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-prune-'));
  try {
    writeFileSync(join(dir, 'sess_kept.json'), JSON.stringify(ordinary('sess_kept')));
    const deps = { dir, readSession: (d, file) => JSON.parse(require_read(d, file)) };
    indexedSessionIds.splice(0, indexedSessionIds.length, 'sess_kept', 'sess_gone');
    queries.length = 0;
    await backfillSessionSearch({ deps });
    const deleted = queries
      .filter((q) => /DELETE FROM session_search\.messages/.test(q.sql))
      .map((q) => q.params[0]);
    assert.deepEqual(deleted, ['sess_gone']);
  } finally {
    indexedSessionIds.length = 0;
    rmSync(dir, { recursive: true, force: true });
  }
});

import { readFileSync } from 'node:fs';
function require_read(d, file) {
  return readFileSync(join(d, file), 'utf-8');
}
