import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

mock.module('./memory-embed.mjs', {
  namedExports: {
    flushEmbeddingDirty: async () => ({ attempted: 0, succeeded: 0, failed: [] }),
    syncRootEmbedding: async () => {},
    inferChunkProjectId: (members) => members[0].project_id,
  },
});
const { runCycle1 } = await import('./memory-cycle1.mjs');
const { assessChunkQuality } = await import('./memory-chunk-quality.mjs');

function database({ changeBeforeCommit = false } = {}) {
  let entries = [1, 2].map((id) => ({
    id,
    ts: id * 1000,
    role: id === 1 ? 'user' : 'assistant',
    session_id: 's',
    content: 'A pending request, its constraints and repeated details. '.repeat(10),
    project_id: 'project',
    chunk_root: null,
    is_root: 0,
    status: 'pending',
    error_count: 50,
  }));
  const writes = [];
  const db = {
    get entries() {
      return entries;
    },
    writes,
    query: async (sql, params = []) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ c: entries.length }] };
      if (sql.includes('WITH eligible_sessions')) return { rows: structuredClone(entries).reverse() };
      if (sql.includes('SELECT value FROM meta')) return { rows: [] };
      if (sql.includes('FOR UPDATE')) {
        const rows = structuredClone(entries.filter((entry) => params[0].includes(entry.id)));
        if (changeBeforeCommit) rows[0].content = 'Changed while the LLM was running.';
        return { rows };
      }
      if (sql.includes('UPDATE entries')) {
        writes.push({ sql, params });
        if (sql.includes('error_count = COALESCE')) {
          for (const entry of entries.filter((entry) => params[0].includes(entry.id))) {
            entry.reviewed_at = params[1];
            entry.error_count += 1;
          }
          return { rows: params[0].map((id) => ({ id })) };
        }
        if (sql.includes('is_root = 1')) {
          Object.assign(
            entries.find((entry) => entry.id === params[0]),
            {
              chunk_root: params[0],
              is_root: 1,
              element: params[1],
              category: params[2],
              summary: params[3],
              chunk_quality: JSON.parse(params[7]),
            }
          );
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SET chunk_root = $1, project_id = $2')) {
          for (const entry of entries.filter((entry) => params[2].includes(entry.id))) entry.chunk_root = params[0];
          return { rows: [], rowCount: params[2].length };
        }
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    transaction: async (callback) => {
      const saved = structuredClone(entries);
      try {
        return await callback(db);
      } catch (error) {
        entries = saved;
        throw error;
      }
    },
  };
  db._pool = { connect: async () => ({ query: db.query, release() {} }) };
  return db;
}

const options = (callLlm) => ({ preset: 'test', callLlm });
const config = { min_batch: 1, coalesce_max_drains: 0 };

test('cycle1 commits provenance atomically while leaving every source body unchanged', async () => {
  const db = database();
  const originals = db.entries.map((entry) => entry.content);
  const result = await runCycle1(
    db,
    config,
    options(async (request) => {
      assert.equal(request.mode, 'cycle1');
      return '1,2|pending request|task|The request remains pending.';
    })
  );
  assert.equal(result.processed, 2);
  assert.equal(result.chunks, 1);
  assert.equal(result.quality.verification_calls, 0);
  assert.equal(result.quality.grouping_calls, 1);
  assert.deepEqual(
    db.entries.map((entry) => entry.content),
    originals
  );
  assert.equal(assessChunkQuality(db.entries[0], db.entries).usable, true);
  assert.deepEqual(
    db.entries.map((entry) => entry.chunk_root),
    [1, 1]
  );
});

test('omission commits the good chunk and cools only the omitted source without archive or retry', async () => {
  const db = database();
  const result = await runCycle1(
    db,
    config,
    options(async () => '1|incomplete|task|Pending.')
  );
  assert.equal(result.chunks, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.quality.grouping_calls, 1);
  assert.deepEqual(result.failed_row_ids, []);
  assert.deepEqual(result.omitted_row_ids, [2]);
  assert.deepEqual(
    db.entries.map((entry) => entry.chunk_root),
    [1, null]
  );
  assert.deepEqual(
    db.entries.map((entry) => entry.status),
    ['pending', 'pending']
  );
  assert.deepEqual(
    db.entries.map((entry) => entry.error_count),
    [50, 51]
  );
  assert.equal(result.quality.omitted_marked_rows, 0);
});

test('transport errors remain visible and never archive or commit healthy rows', async () => {
  const db = database();
  const result = await runCycle1(
    db,
    config,
    options(async () => {
      throw new Error('usage limit');
    })
  );
  assert.equal(result.invalid_chunks[0].reason, 'llm_error');
  assert.equal(result.invalid_chunks[0].error, 'usage limit');
  assert.deepEqual(result.failed_row_ids, [1, 2]);
  assert.equal(
    db.entries.every((entry) => entry.chunk_root === null),
    true
  );
});

test('a changed source rejects the transaction and retains original rows', async () => {
  const db = database({ changeBeforeCommit: true });
  const result = await runCycle1(
    db,
    config,
    options(async () => '1,2|request|task|Pending request.')
  );
  assert.equal(result.chunks, 0);
  assert.deepEqual(result.failed_row_ids, [1, 2]);
  assert.equal(
    db.entries.every((entry) => entry.is_root === 0 && entry.chunk_root === null),
    true
  );
});

test('cancellation during the single call prevents all source and metadata writes', async () => {
  const db = database();
  const controller = new AbortController();
  await assert.rejects(
    runCycle1(db, config, {
      ...options(async () => {
        controller.abort(new Error('cancelled'));
        return '1,2|request|task|Pending.';
      }),
      signal: controller.signal,
    }),
    /cancelled/
  );
  assert.equal(db.writes.length, 0);
});
