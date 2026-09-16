import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

const store = await import('./memory-recall-store.mjs')
mock.module('./memory-recall-store.mjs', {
  namedExports: { ...store, searchRelevantHybrid: (db, query, options) => db.search(query, options) },
})
const { createQueryHandlers } = await import('./query-handlers.mjs')

function fixture(count = 600) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: i + 1, ts: Date.now() - i * 1000, is_root: 1, chunk_root: i + 1,
    role: 'user', project_id: null, session_id: 'test-session', category: 'fact', status: 'pending',
    element: `item-${i + 1}`, summary: `MARKER_${String(i + 1).padStart(4, '0')} needle`,
    content: `MARKER_${String(i + 1).padStart(4, '0')} needle`, duplicate_of: null,
    retrievalScore: 1, rrf: 1, _retrievalEvidence: 'lexical',
  }))
  const db = {
    rows, searches: [],
    async search(_query, options) {
      this.searches.push(options)
      return this.rows.slice(0, options.limit).map(row => ({ ...row }))
    },
    async query(sql, args = []) {
      if (sql.includes('WITH eligible AS')) {
        const ids = new Set(this.rows.map(row => row.id))
        return { rows: this.rows.filter(row => row.duplicate_of == null || !ids.has(row.duplicate_of))
          .slice(Number(args.at(-1)), Number(args.at(-1)) + Number(args.at(-2))).map(row => ({ ...row })) }
      }
      return { rows: [] }
    },
    transaction: run => run(db),
  }
  const handlers = createQueryHandlers({
    getDb: () => db, log: () => {}, resolveProjectScope: () => null,
    embeddingOnDemandCanStart: () => false, getBootTimestamp: () => 0, getTraceDb: () => null,
  })
  return { db, ...handlers }
}

test('public recall preserves every supported page boundary, including the last offset', async () => {
  const f = fixture()
  for (const query of ['needle', '']) {
    for (const offset of [0, 99, 100, 499, 500]) {
      for (const limit of [1, 10, 100]) {
        const result = await f.handleSearch({ query, projectScope: 'all', offset, limit })
        assert.ok(result.text.includes(`MARKER_${String(offset + 1).padStart(4, '0')}`), `${query || 'browse'} offset=${offset} limit=${limit}`)
        assert.ok(result.text.includes(`MARKER_${String(offset + limit).padStart(4, '0')}`))
        assert.equal(result.text.includes(`MARKER_${String(offset + limit + 1).padStart(4, '0')}`), false)
      }
    }
  }
  assert.ok(f.db.searches.some(options => options.limit >= 600))
})

test('public historical enrichment cannot reintroduce an alias beside its representative', async () => {
  const f = fixture(2)
  const ts = Date.parse('2024-01-15T00:00:00Z')
  Object.assign(f.db.rows[0], { ts, summary: 'LEGACY_ALIAS needle', content: 'LEGACY_ALIAS needle', duplicate_of: 2 })
  Object.assign(f.db.rows[1], { ts: ts + 1, summary: 'CANONICAL_RECORD needle', content: 'CANONICAL_RECORD needle' })
  f.db.search = async (_query, options) => [{ ...f.db.rows[options.rootOnly ? 1 : 0] }]
  const result = await f.handleSearch({ query: 'needle', period: '2024-01-01~2024-01-31', projectScope: 'all', limit: 10 })
  assert.equal(result.text.includes('LEGACY_ALIAS'), false)
  assert.equal(result.text.includes('CANONICAL_RECORD'), true)
})

test('public enrichment filters time before duplicate grouping', async () => {
  const f = fixture(2)
  Object.assign(f.db.rows[0], { ts: Date.parse('2024-01-15T00:00:00Z'), summary: 'IN_WINDOW needle', content: 'IN_WINDOW needle', duplicate_of: 2 })
  Object.assign(f.db.rows[1], { ts: Date.parse('2025-01-15T00:00:00Z'), summary: 'OUT_OF_WINDOW needle', content: 'OUT_OF_WINDOW needle' })
  f.db.search = async (_query, options) => [{ ...f.db.rows[options.rootOnly ? 1 : 0] }]
  const result = await f.handleSearch({ query: 'needle', period: '2024-01-01~2024-01-31', projectScope: 'all', limit: 10 })
  assert.equal(result.text.includes('IN_WINDOW'), true)
  assert.equal(result.text.includes('OUT_OF_WINDOW'), false)
})
