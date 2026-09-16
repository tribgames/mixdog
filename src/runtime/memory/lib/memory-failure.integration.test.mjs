import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { runCycle2 } from './memory-cycle2.mjs';

const policy = await import('./memory-ops-policy.mjs');
const projectsRoot = mkdtempSync(join(tmpdir(), 'mixdog-memory-failures-'));
mock.module('./memory-ops-policy.mjs', {
  namedExports: {
    ...policy,
    runFullBackfill: (db, options) => policy.runFullBackfill(db, { ...options, projectsRoot }),
  },
});
const { createMemoryActionHandlers } = await import('./memory-action-handlers.mjs');

function failingEmbeddingDb(stage) {
  const releases = [];
  const client = {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      if (sql.includes('SELECT id FROM memory.entries') && stage !== 'commit') throw new Error('claim failed');
      if (sql === 'COMMIT' && stage === 'commit') throw new Error('commit failed');
      if (sql === 'ROLLBACK' && stage === 'rollback') throw new Error('rollback failed');
      return { rows: [] };
    },
    release(error) {
      releases.push(error);
    },
  };
  return { query: async () => ({ rows: [] }), _pool: { connect: async () => client }, releases };
}

for (const stage of ['claim', 'commit', 'rollback']) {
  test(`an embedding ${stage} failure cannot mark cycle2 successful`, async () => {
    const db = failingEmbeddingDb(stage);
    const result = await runCycle2(db, { coalesce_max_drains: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.storeFault, true);
    assert.match(result.error, new RegExp(`${stage} failed`));
    assert.ok(db.releases.some((error) => error instanceof Error));
  });
}

test('direct cycle, flush, rebuild and backfill all surface a model failure', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('COUNT(*)')) return { rows: [{ c: 0 }] };
      if (sql.includes('CROSS JOIN LATERAL')) return { rows: [] };
      if (sql.includes('SELECT id, ts, element, summary, project_id')) {
        return { rows: [{ id: 1, ts: 1, element: 'review', summary: 'Pending review', project_id: null }] };
      }
      return { rows: [], rowCount: 0 };
    },
    transaction: (run) => run(db),
    _pool: {
      connect: async () => ({
        query: async (sql) => ({ rows: sql.includes('pg_try_advisory_lock') ? [{ got: true }] : [{ unlocked: true }] }),
        release() {},
      }),
    },
  };
  const finalized = [];
  const { handleMemoryAction } = createMemoryActionHandlers({
    getDb: () => db,
    dataDir: projectsRoot,
    log: () => {},
    readMainConfig: () => ({ cycle2: { coalesce_max_drains: 0 } }),
    awaitCycle1Run: async () => ({ chunks: 0, processed: 0 }),
    startCycle1Run: async () => ({ chunks: 0, processed: 0 }),
    getSchedulerCycle1InFlight: () => null,
    finalizeCycle2Run: async (result) => {
      finalized.push(result);
    },
    getCycle2CallLlm: () => async () => {
      throw new Error('model failed');
    },
    ingestTranscriptFile: async () => 0,
  });
  for (const action of ['cycle2', 'flush', 'rebuild', 'backfill']) {
    const result = await handleMemoryAction({ action, confirm: 'REBUILD MEMORY' });
    assert.equal(result.isError, true, action);
    assert.match(result.text, /model failed/, action);
  }
  assert.equal(finalized.length, 4);
  assert.ok(finalized.every((result) => result.ok === false));
});

test('backfill never turns count-query failure or cancellation into an empty successful run', async () => {
  const callbacks = {
    projectsRoot,
    ingestTranscriptFile: async () => 0,
    runCycle1: async () => ({ processed: 0 }),
    runCycle2: async () => ({ ok: true }),
  };
  await assert.rejects(
    policy.runFullBackfill(
      {
        query: async () => {
          throw new Error('count failed');
        },
      },
      callbacks
    ),
    /count failed/
  );
  const controller = new AbortController();
  controller.abort(new Error('stop backfill'));
  await assert.rejects(
    policy.runFullBackfill({ query: async () => ({ rows: [{ c: 0 }] }) }, { ...callbacks, signal: controller.signal }),
    /stop backfill/
  );
  const partial = await policy.runFullBackfill(
    { query: async () => ({ rows: [{ c: 0 }] }) },
    {
      ...callbacks,
      runCycle2: async () => ({ ok: false, processed: 3, error: 'late failure' }),
    }
  );
  assert.equal(partial.ok, false);
  assert.equal(partial.reviewed, 3);
  assert.match(partial.error, /late failure/);
});
