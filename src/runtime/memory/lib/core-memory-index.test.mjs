import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { indexedCoreRecord, resolveCoreMemoryIndex, syncCoreMemoryIndexes } from './core-memory-index.mjs'
import { listManagedMemories, formatManagedMemories } from './generated-memory-management.mjs'
import { parseMemoryCoreRows } from '../../../tui/app/input-parsers.mjs'
import { createMemoryActionHandlers } from './memory-action-handlers.mjs'

function fixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(`
    CREATE TABLE core_entries(id INTEGER PRIMARY KEY, project_id TEXT, status TEXT, element TEXT, summary TEXT);
    CREATE TABLE entries(id INTEGER, project_id TEXT, status TEXT, is_root INTEGER, element TEXT, core_summary TEXT);
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO core_entries VALUES
      (81, NULL, 'active', 'Common', 'Common preference'),
      (150, 'alpha', 'active', 'First', 'First alpha memory'),
      (170, 'alpha', 'active', 'Second', 'Second alpha memory'),
      (200, 'beta', 'active', 'Beta', 'Beta memory');
  `)
  const db = {
    async query(statement, args = []) {
      if (statement.includes('pg_advisory_xact_lock')) return { rows: [] }
      const prepared = sql.prepare(statement.replace(/::(?:text|boolean|jsonb)/g, '').replace(/\$(\d+)/g, ':p$1'))
      const params = Object.fromEntries(args.map((value, i) => [`p${i + 1}`, typeof value === 'boolean' ? Number(value) : value]))
      return { rows: prepared.all(params) }
    },
    async transaction(run) {
      sql.exec('BEGIN')
      try { const result = await run(db); sql.exec('COMMIT'); return result }
      catch (error) { sql.exec('ROLLBACK'); throw error }
    },
  }
  return { sql, db }
}

test('real scoped indices persist, compact independently, append on move, and reject stale requests', async () => {
  const { sql, db } = fixture()
  try {
    const first = await syncCoreMemoryIndexes(db)
    const common = indexedCoreRecord({ id: 81, project_id: null }, first)
    const alpha = indexedCoreRecord({ id: 150, project_id: 'alpha' }, first)
    const beta = indexedCoreRecord({ id: 200, project_id: 'beta' }, first)
    assert.equal(common.id, 1)
    assert.equal(alpha.id, 1)
    assert.equal(beta.id, 1)
    assert.equal(indexedCoreRecord({ id: 170, project_id: 'alpha' }, first).id, 2)
    assert.equal(sql.prepare('SELECT count(*) AS n FROM meta').get().n, 3)
    assert.deepEqual(await syncCoreMemoryIndexes(db), first)
    assert.equal(await resolveCoreMemoryIndex(db, 'alpha', 1, alpha.index_revision), 150)
    await assert.rejects(resolveCoreMemoryIndex(db, 'beta', 1, alpha.index_revision), /indices changed/)
    await assert.rejects(resolveCoreMemoryIndex(db, 'alpha', 1, undefined), /index_revision required/)

    sql.exec('DELETE FROM core_entries WHERE id=150')
    const compacted = await syncCoreMemoryIndexes(db)
    const remaining = indexedCoreRecord({ id: 170, project_id: 'alpha' }, compacted)
    assert.equal(remaining.id, 1)
    assert.notEqual(remaining.index_revision, alpha.index_revision)
    await assert.rejects(resolveCoreMemoryIndex(db, 'alpha', 1, alpha.index_revision), /indices changed/)
    assert.equal(await resolveCoreMemoryIndex(db, 'alpha', 1, remaining.index_revision), 170)
    assert.equal(indexedCoreRecord({ id: 200, project_id: 'beta' }, compacted).index_revision, beta.index_revision)

    sql.exec("INSERT INTO core_entries VALUES(201, 'alpha', 'active', 'New', 'New alpha memory')")
    const added = await syncCoreMemoryIndexes(db)
    assert.equal(indexedCoreRecord({ id: 201, project_id: 'alpha' }, added).id, 2)
    sql.exec("UPDATE core_entries SET project_id='alpha' WHERE id=81")
    const moved = await syncCoreMemoryIndexes(db)
    assert.equal(indexedCoreRecord({ id: 81, project_id: 'alpha' }, moved).id, 3)
    assert.equal(indexedCoreRecord({ id: 170, project_id: 'alpha' }, moved).id, 1)
    await assert.rejects(resolveCoreMemoryIndex(db, null, 1, common.index_revision), /indices changed/)
    sql.exec("INSERT INTO core_entries VALUES(202, NULL, 'active', 'New common', 'New common memory')")
    assert.equal(indexedCoreRecord({ id: 202, project_id: null }, await syncCoreMemoryIndexes(db)).id, 1)
    sql.exec("UPDATE core_entries SET status='archived' WHERE id=170")
    const archived = await syncCoreMemoryIndexes(db)
    assert.equal(indexedCoreRecord({ id: 201, project_id: 'alpha' }, archived).id, 1)
    assert.equal(indexedCoreRecord({ id: 170, project_id: 'alpha' }, archived).id, null)
    assert.equal(sql.prepare('SELECT summary FROM core_entries WHERE id=170').get().summary, 'Second alpha memory')
  } finally { sql.close() }
})

test('lists and TUI requests carry per-scope indices and their matching revisions', async () => {
  const { sql, db } = fixture()
  try {
    const page = await listManagedMemories(db, '*', { source: 'curated' })
    assert.deepEqual(page.entries.map(row => row.id), [1, 1, 2, 1])
    const tui = parseMemoryCoreRows(formatManagedMemories(page))
    assert.equal(new Set(tui.map(row => row.value)).size, 4)
    for (let i = 0; i < tui.length; i++) {
      assert.equal(tui[i]._indexRevision, page.entries[i].index_revision)
      assert.equal(await resolveCoreMemoryIndex(db, tui[i]._projectId, tui[i]._id, tui[i]._indexRevision), page.entries[i].record_id)
    }
    const scoped = await listManagedMemories(db, 'alpha', { source: 'curated', scope_only: true, limit: 1 })
    assert.equal(scoped.entries[0].id, 1)
    const next = await listManagedMemories(db, 'alpha', { source: 'curated', scope_only: true, limit: 1, offset: scoped.nextOffset })
    assert.equal(next.entries[0].id, 2)
  } finally { sql.close() }
})

test('public mutations resolve scope and version before touching the stable record', async () => {
  const { sql, db } = fixture()
  const writes = []
  const { handleToolCall } = createMemoryActionHandlers({
    getDb: () => db, dataDir: '/test-only', readMainConfig: () => ({}),
    refreshCoreMemoryFile: () => syncCoreMemoryIndexes(db),
    editCoreImpl: async (_dir, recordId, patch) => {
      const row = sql.prepare('SELECT * FROM core_entries WHERE id=?').get(recordId)
      assert.equal(row.project_id, patch.expectedProjectId)
      writes.push(recordId)
      sql.prepare('UPDATE core_entries SET summary=?, project_id=? WHERE id=?')
        .run(patch.summary, patch.targetProjectId, recordId)
      return sql.prepare('SELECT * FROM core_entries WHERE id=?').get(recordId)
    },
    deleteCoreImpl: async (_dir, recordId, options) => {
      const row = sql.prepare('SELECT * FROM core_entries WHERE id=?').get(recordId)
      assert.equal(row.project_id, options.expectedProjectId)
      writes.push(recordId)
      sql.prepare('DELETE FROM core_entries WHERE id=?').run(recordId)
      return row
    },
  })
  const list = async project_id => {
    const result = await handleToolCall('memory', { op: 'list', project_id, scope_only: true, source: 'curated', format: 'json' })
    assert.equal(result.isError, false)
    return JSON.parse(result.content[0].text).entries
  }
  try {
    const common = (await list('common'))[0]
    const alpha = (await list('alpha'))[0]
    const oldGlobalId = await handleToolCall('memory', {
      op: 'edit', project_id: 'common', id: 81, index_revision: common.index_revision, summary: 'Wrong',
    })
    assert.equal(oldGlobalId.isError, true)
    assert.deepEqual(writes, [])
    const deleted = await handleToolCall('memory', {
      op: 'delete', project_id: 'alpha', id: 1, index_revision: alpha.index_revision,
    })
    assert.equal(deleted.isError, false)
    assert.deepEqual(writes, [150])
    const stale = await handleToolCall('memory', {
      op: 'edit', project_id: 'alpha', id: 1, index_revision: alpha.index_revision, summary: 'Wrong',
    })
    assert.equal(stale.isError, true)
    assert.deepEqual(writes, [150])
    const remaining = (await list('alpha'))[0]
    assert.equal(remaining.id, 1)
    const moved = await handleToolCall('memory', {
      op: 'edit', project_id: 'alpha', id: 1, index_revision: remaining.index_revision,
      target_project_id: 'beta', summary: 'Moved',
    })
    assert.equal(moved.isError, false)
    assert.match(moved.content[0].text, /project=beta id=2 index_revision=/)
    assert.deepEqual(writes, [150, 170])
    assert.deepEqual((await list('beta')).map(row => row.record_id), [200, 170])
    assert.equal((await list('common'))[0].index_revision, common.index_revision)
  } finally { sql.close() }
})
