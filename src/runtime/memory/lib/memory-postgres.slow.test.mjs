import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('isolated PostgreSQL covers fresh schema, legacy CORE conflicts, aliases and real retrieval SQL', async t => {
  // Both PGDATA and discovery/stop metadata are private to this test process.
  // Never attach to or stop the user's memory service.
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-memory-postgres-'))
  process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime')
  process.env.MIXDOG_DATA_DIR = directory
  t.diagnostic(`Retained isolated PostgreSQL artifacts: ${directory}`)
  const { openDatabase, closeDatabase, ensureCurrentSchemaExtensions, embeddingToSql } = await import('./memory.mjs')
  const { stopPgForShutdown } = await import('./pg/supervisor.mjs')
  t.after(async () => {
    await closeDatabase(directory)
    await stopPgForShutdown()
  })
  const identity = { model: 'isolated-sql-test', dimensions: 384 }
  let db = await openDatabase(directory, 384, identity)
  const actualData = (await db.query('SHOW data_directory')).rows[0].data_directory
  assert.equal(resolve(actualData).toLowerCase(), resolve(directory, 'pgdata').toLowerCase())
  const { ensureCoreKeyIndex } = await import('./core-memory-uniqueness.mjs')
  const { applyHistoryReview } = await import('./memory-cycle2-mutations.mjs')
  const { searchRelevantHybrid } = await import('./memory-recall-store.mjs')
  const { retrieveEntries } = await import('./memory-retrievers.mjs')
  const { runCycle2 } = await import('./memory-cycle2.mjs')
  const { makeChunkQuality, assessChunkQuality } = await import('./memory-chunk-quality.mjs')

  // This index belongs to the freshly allocated test cluster, never a live DB.
  await db.exec('DROP INDEX core_entries_unique_proj_elem')
  await db.query(`INSERT INTO core_entries(element,summary,category,project_id,created_at,updated_at)
    VALUES ('legacy-key','First approved preference','preference',NULL,1,1),
           ('legacy-key','Second approved preference','preference',NULL,2,2)`)
  const beforeCore = (await db.query('SELECT id,summary FROM core_entries ORDER BY id')).rows
  await ensureCurrentSchemaExtensions(db, 384, identity)
  assert.deepEqual((await db.query('SELECT id,summary FROM core_entries ORDER BY id')).rows, beforeCore)
  assert.equal(await ensureCoreKeyIndex(db), false)

  const vector = [1, ...Array(383).fill(0)]
  const roots = []
  for (let i = 1; i <= 3; i++) {
    const row = (await db.query(`
      INSERT INTO entries(ts,role,content,source_ref,session_id,project_id,is_root,element,summary,category,status,last_seen_at,embedding)
      VALUES ($1,'user',$2,$3,$4,'project',1,$5,$6,'fact','pending',$1,$7::halfvec) RETURNING *
    `, [i * 1000, `audit original source ${i} `.repeat(30), `audit:${i}`, `session:${i}`,
      `audit-${i}`, `audit summary ${i}`, embeddingToSql(vector)])).rows[0]
    const quality = makeChunkQuality(row.summary, [row])
    await db.query('UPDATE entries SET chunk_root=id, chunk_quality=$2::jsonb WHERE id=$1', [row.id, JSON.stringify(quality)])
    roots.push({ ...row, chunk_root: row.id, chunk_quality: quality })
  }
  const [older, current, independent] = roots
  assert.equal(await applyHistoryReview(db, current, 'merge', {
    older_id: older.id, older_ts: older.ts, older_element: older.element, older_summary: older.summary,
  }), true)
  for (const original of roots) {
    const stored = (await db.query('SELECT * FROM entries WHERE id=$1', [original.id])).rows[0]
    assert.equal(stored.content, original.content)
    assert.equal(stored.chunk_root, original.chunk_root)
    assert.equal(assessChunkQuality(stored, [stored]).usable, true)
  }
  const recalled = await searchRelevantHybrid(db, 'audit', { projectScope: 'project', limit: 2, queryVector: vector })
  assert.deepEqual(new Set(recalled.map(row => Number(row.id))), new Set([Number(current.id), Number(independent.id)]))
  const pages = []
  for (let offset = 0; offset < 3; offset++) {
    pages.push((await retrieveEntries(db, { projectScope: 'project', sort: 'date', limit: 1, offset })).map(row => Number(row.id)))
  }
  assert.deepEqual(pages, [[Number(independent.id)], [Number(current.id)], []])
  assert.deepEqual((await retrieveEntries(db, { projectScope: 'project', ts_to: 1500 })).map(row => Number(row.id)), [Number(older.id)])

  const result = await runCycle2(db, { coalesce_max_drains: 0 }, {
    preset: 'test',
    callLlm: async (_request, prompt) => JSON.stringify(JSON.parse(prompt.split('\n\n').at(-1))
      .map(row => ({ id: Number(row.id), action: 'keep' }))),
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.processed, 1)
  await closeDatabase(directory)
  db = await openDatabase(directory, 384, identity)
  assert.deepEqual((await db.query('SELECT id,summary FROM core_entries ORDER BY id')).rows, beforeCore)
  assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM entries')).rows[0].count), 3)

  // Explicitly resolve the test fixture's conflict; migration may now install
  // the index without deleting either curated record.
  await db.query(`UPDATE core_entries SET element='resolved-key' WHERE id=$1`, [beforeCore[1].id])
  assert.equal(await ensureCoreKeyIndex(db), true)
  assert.deepEqual((await db.query('SELECT id,summary FROM core_entries ORDER BY id')).rows, beforeCore)
})
