import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_EMBED_CACHE_MAX_ROWS,
  pruneEmbeddingCache,
  resolveEmbeddingCacheMaxRows,
} from './embedding-cache-retention.mjs'

test('embedding cache defaults to ten thousand rows with a positive override', () => {
  assert.equal(DEFAULT_EMBED_CACHE_MAX_ROWS, 10_000)
  assert.equal(resolveEmbeddingCacheMaxRows(undefined), 10_000)
  assert.equal(resolveEmbeddingCacheMaxRows('25000'), 25_000)
  assert.equal(resolveEmbeddingCacheMaxRows('0'), 10_000)
  assert.equal(resolveEmbeddingCacheMaxRows('invalid'), 10_000)
})

test('a legacy oversized embedding cache is truncated to reclaim disk pages', async () => {
  const calls = []
  const db = {
    query: async (sql) => {
      calls.push(sql)
      if (sql.includes('count(*)')) return { rows: [{ n: '32495' }] }
      return { rowCount: null, rows: [] }
    },
  }

  const result = await pruneEmbeddingCache(db, { maxRows: 10_000 })

  assert.deepEqual(result, { removed: 32_495, truncated: true, remaining: 0 })
  assert.equal(calls.some((sql) => sql.includes('TRUNCATE TABLE memory.embedding_cache')), true)
  assert.equal(calls.some((sql) => sql.includes('DELETE FROM memory.embedding_cache')), false)
})

test('small overflow deletes only the oldest excess rows', async () => {
  const calls = []
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      if (sql.includes('count(*)')) return { rows: [{ n: '10007' }] }
      return { rowCount: params[0], rows: [] }
    },
  }

  const result = await pruneEmbeddingCache(db, { maxRows: 10_000 })

  assert.deepEqual(result, { removed: 7, truncated: false, remaining: 10_000 })
  const deletion = calls.find(({ sql }) => sql.includes('DELETE FROM memory.embedding_cache'))
  assert.deepEqual(deletion.params, [7])
})
