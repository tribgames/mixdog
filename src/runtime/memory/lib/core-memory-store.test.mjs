import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test, { mock } from 'node:test'

let database
mock.module('./memory.mjs', { namedExports: {
  getDatabase: () => database,
  embeddingToSql: value => JSON.stringify(value),
} })
mock.module('./memory-embed.mjs', { namedExports: { cachedEmbedTextBatch: async () => [[1, 0]] } })
mock.module('./pg/adapter.mjs', { namedExports: { checkedConnect: pool => pool.connect() } })
const { addCore, editCore, deleteCore } = await import('./core-memory-store.mjs')

test('direct CORE add/edit/delete preserve other entries and never require an LLM judge', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE core_entries (
      id INTEGER PRIMARY KEY, element TEXT, summary TEXT, category TEXT, project_id TEXT,
      embedding TEXT, created_at INTEGER, updated_at INTEGER, status TEXT, archived_at INTEGER
    );
  `)
  database = {
    async query(sql, args = []) {
      if (sql.includes('pg_advisory_xact_lock') || sql.startsWith('SET LOCAL')) return { rows: [] }
      const statement = sqlite.prepare(sql.replace(/::(?:halfvec|bigint)/g, '').replace(/FOR UPDATE/g, '')
        .replace(/\$(\d+)/g, ':p$1'))
      const params = Object.fromEntries(args.map((value, i) => [`p${i + 1}`, value ?? null]))
      if (/^\s*SELECT/.test(sql) || sql.includes('RETURNING')) return { rows: statement.all(params) }
      return { rows: [], rowCount: Number(statement.run(params).changes) }
    },
  }
  database._pool = { connect: async () => ({ query: database.query, release() {} }) }
  try {
    const first = await addCore('/test', { summary: 'Use concise answers.', category: 'preference' }, null)
    const second = await addCore('/test', { summary: 'Keep answers short.', category: 'preference' }, null)
    assert.notEqual(first.id, second.id)
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM core_entries').get().n, 2)
    await editCore('/test', second.id, { summary: 'Use concise answers, with examples on request.', expectedProjectId: null })
    assert.equal(sqlite.prepare('SELECT summary FROM core_entries WHERE id=?').get(first.id).summary, first.summary)
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM core_entries').get().n, 2)
    await assert.rejects(deleteCore('/test', first.id, { expectedProjectId: 'other' }), /no entry/)
    await deleteCore('/test', second.id, { expectedProjectId: null })
    assert.deepEqual(sqlite.prepare('SELECT summary FROM core_entries').all().map(row => row.summary), [first.summary])
    const before = sqlite.prepare('SELECT * FROM core_entries').all()
    await assert.rejects(addCore('/test', { summary: first.summary, category: 'preference' }, null), /already exists/)
    assert.deepEqual(sqlite.prepare('SELECT * FROM core_entries').all(), before)
    sqlite.prepare(`INSERT INTO core_entries(element,summary,category,project_id,status) VALUES(?,?,?,NULL,'active')`)
      .run(first.element, 'Legacy duplicate must remain stored.', 'preference')
    const duplicates = sqlite.prepare('SELECT * FROM core_entries').all()
    await assert.rejects(addCore('/test', { element: first.element, summary: 'Do not replace the legacy pair.', category: 'preference' }, null), /already exists/)
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM core_entries').get().n, duplicates.length)
    assert.deepEqual(sqlite.prepare('SELECT summary FROM core_entries ORDER BY id').all().map(row => row.summary),
      [first.summary, 'Legacy duplicate must remain stored.'])
  } finally {
    database = null
    sqlite.close()
  }
})
