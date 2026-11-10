import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { flushSearchEmbeddings } from './memory-embed.mjs';

const embedding = await import('./memory-embed.mjs');
let flush = async () => ({ succeeded: 0 });
mock.module('./memory-embed.mjs', {
  namedExports: { ...embedding, flushSearchEmbeddings: (...args) => flush(...args) },
});
const policy = await import('./memory-ops-policy.mjs');
const projectsRoot = mkdtempSync(join(tmpdir(), 'mixdog-memory-maintenance-'));
test.after(() => rmSync(projectsRoot, { recursive: true, force: true }));
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
  test(`explicit embedding maintenance propagates ${stage} failures`, async () => {
    const db = failingEmbeddingDb(stage);
    await assert.rejects(
      flushSearchEmbeddings(db),
      (error) => error.code === 'MEMORY_STORE_FAULT' && error.message.includes(`${stage} failed`)
    );
    assert.ok(db.releases.some((error) => error instanceof Error));
  });
}

function harness(overrides = {}) {
  const db = {
    async query(sql) {
      if (sql.includes('COUNT(*)')) return { rows: [{ c: 0 }] };
      return { rows: [], rowCount: 0 };
    },
    transaction: (run) => run(db),
  };
  return {
    ...createMemoryActionHandlers({
      getDb: () => db,
      dataDir: projectsRoot,
      log: () => {},
      readMainConfig: () => ({}),
      awaitCycle1Run: async () => ({ chunks: 2, processed: 4 }),
      startCycle1Run: async () => ({ chunks: 2, processed: 4 }),
      getSchedulerCycle1InFlight: () => null,
      ingestTranscriptFile: async () => 0,
      ...overrides,
    }),
  };
}

test('flush, rebuild and backfill finish embeddings', async () => {
  let embeddings = 0;
  flush = async () => {
    embeddings++;
    return { succeeded: 3 };
  };
  const h = harness();
  for (const action of ['flush', 'rebuild', 'backfill']) {
    const result = await h.handleMemoryAction({ action, confirm: 'REBUILD MEMORY' });
    assert.notEqual(result.isError, true);
    assert.match(result.text, new RegExp(`^${action}:`));
  }
  assert.equal(embeddings, 3);
});

test('maintenance surfaces embedding failures instead of reporting success', async () => {
  flush = async () => {
    throw new Error('embedding incomplete');
  };
  const h = harness();
  for (const action of ['flush', 'rebuild']) {
    await assert.rejects(h.handleMemoryAction({ action, confirm: 'REBUILD MEMORY' }), /embedding incomplete/);
  }
  const result = await h.handleMemoryAction({ action: 'backfill' });
  assert.equal(result.isError, true);
  assert.match(result.text, /embedding incomplete/);
});

test('summarization failures and cancellation still reach the caller', async () => {
  const h = harness({
    awaitCycle1Run: async () => {
      throw new Error('model failed');
    },
    startCycle1Run: async () => {
      throw new Error('model failed');
    },
  });
  for (const action of ['cycle1', 'flush', 'rebuild']) {
    await assert.rejects(h.handleMemoryAction({ action, confirm: 'REBUILD MEMORY' }), /model failed/);
  }
  const controller = new AbortController();
  controller.abort(new Error('stop maintenance'));
  await assert.rejects(h.handleMemoryAction({ action: 'flush' }, controller.signal), /stop maintenance/);
});

test('backfill preserves failures and partial progress', async () => {
  const callbacks = {
    projectsRoot,
    ingestTranscriptFile: async () => 0,
    runCycle1: async () => ({ processed: 1 }),
    flushEmbeddings: async () => ({ succeeded: 0 }),
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
  const counts = [1, 0, 0];
  const partial = await policy.runFullBackfill(
    { query: async () => ({ rows: [{ c: counts.shift() }] }) },
    {
      ...callbacks,
      flushEmbeddings: async () => {
        throw new Error('late embedding failure');
      },
    }
  );
  assert.equal(partial.ok, false);
  assert.equal(partial.cycle1_iters, 1);
  assert.equal(partial.unclassified, 0);
  assert.match(partial.error, /late embedding failure/);
});
