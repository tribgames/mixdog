import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Upgrading the root embed text must never leave old roots without a vector:
// the sweep replaces vectors in place, keeps its progress across restarts, and
// a failed step changes nothing.
test('the root text sweep replaces vectors in place and keeps its progress', async (t) => {
  // Private PGDATA and runtime metadata; never the user's memory service.
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-root-sweep-'));
  process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime');
  process.env.MIXDOG_DATA_DIR = directory;
  const { openDatabase, closeDatabase, embeddingToSql, startRootEmbedSweep, ROOT_EMBED_SWEEP_META_KEY } = await import(
    './memory.mjs'
  );
  const { sweepRootEmbedText } = await import('./memory-embed.mjs');
  const { stopPgForShutdown } = await import('./pg/supervisor.mjs');
  let passed = false;
  t.after(async () => {
    await closeDatabase(directory);
    await stopPgForShutdown();
    if (passed) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    else t.diagnostic(`Retained isolated PostgreSQL artifacts: ${directory}`);
  });
  const identity = { model: 'isolated-sweep-test', dimensions: 384 };
  let db = await openDatabase(directory, 384, identity);

  // A store from before the sweep: summarized roots with summary-only vectors
  // and no sweep state.
  const oldVector = [1, ...Array(383).fill(0)];
  const newVector = [0, 1, ...Array(382).fill(0)];
  await db.query('DELETE FROM meta WHERE key = $1', [ROOT_EMBED_SWEEP_META_KEY]);
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    const { rows } = await db.query(
      `INSERT INTO entries(ts,role,content,source_ref,session_id,project_id,is_root,element,summary,category,status,last_seen_at,embedding)
       VALUES ($1,'assistant',$2,$3,'s','p',1,$4,'summary','fact','active',$1,$5::halfvec) RETURNING id`,
      [i * 1000, `first message ${i}`, `sweep:${i}`, `root ${i}`, embeddingToSql(oldVector)]
    );
    ids.push(Number(rows[0].id));
  }
  const vectorState = async () =>
    (
      await db.query(
        `SELECT id, (embedding = $1::halfvec) AS replaced FROM entries WHERE is_root = 1 AND embedding IS NOT NULL ORDER BY id`,
        [embeddingToSql(newVector)]
      )
    ).rows.map((row) => [Number(row.id), row.replaced]);
  const sweepState = async () =>
    (await db.query('SELECT value FROM meta WHERE key = $1', [ROOT_EMBED_SWEEP_META_KEY])).rows.map((r) => r.value);

  // Concurrent starts leave one sweep at the top; no vector is released.
  await Promise.all([startRootEmbedSweep(db), startRootEmbedSweep(db)]);
  assert.deepEqual(await sweepState(), [{ cursor: ids[2] + 1, done: false }]);
  assert.deepEqual(await vectorState(), [
    [ids[0], false],
    [ids[1], false],
    [ids[2], false],
  ]);

  const texts = [];
  const embedBatch = async (_db, batch) => {
    texts.push(...batch);
    return batch.map(() => newVector);
  };
  const failing = async () => {
    throw new Error('embedding worker unavailable');
  };

  // Newest roots first; the stored text includes the first message.
  assert.deepEqual(await sweepRootEmbedText(db, { batchSize: 2, embedBatch }), {
    claimed: 2,
    replaced: 2,
    done: false,
  });
  assert.deepEqual(texts.sort(), ['root 2 — summary\n\nfirst message 2', 'root 3 — summary\n\nfirst message 3']);
  assert.deepEqual(await sweepState(), [{ cursor: ids[1], done: false }]);

  // A failed step rolls back: cursor and the remaining old vector stay.
  await assert.rejects(sweepRootEmbedText(db, { batchSize: 2, embedBatch: failing }), /embedding worker unavailable/);
  assert.deepEqual(await sweepState(), [{ cursor: ids[1], done: false }]);

  // Progress survives a restart; reopening never restarts or clears the sweep.
  await closeDatabase(directory);
  db = await openDatabase(directory, 384, identity);
  assert.deepEqual(await sweepState(), [{ cursor: ids[1], done: false }]);
  assert.deepEqual(await vectorState(), [
    [ids[0], false],
    [ids[1], true],
    [ids[2], true],
  ]);

  assert.deepEqual(await sweepRootEmbedText(db, { batchSize: 2, embedBatch }), { claimed: 1, replaced: 1, done: true });
  assert.deepEqual(await sweepState(), [{ cursor: ids[0], done: true }]);
  assert.deepEqual(await vectorState(), [
    [ids[0], true],
    [ids[1], true],
    [ids[2], true],
  ]);
  assert.deepEqual(await sweepRootEmbedText(db, { batchSize: 2, embedBatch }), { claimed: 0, replaced: 0, done: true });
  passed = true;
});
