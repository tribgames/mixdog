import assert from 'node:assert/strict'
import test from 'node:test'

import { resetEmbeddingColumnsForModel } from './memory.mjs'

function mockDb({ entriesDims = 640, coreDims = 640, identityMatches = true } = {}) {
  const execs = []
  const queries = []
  return {
    execs,
    queries,
    async exec(sql) {
      execs.push(sql)
    },
    async query(sql, params = []) {
      queries.push({ sql, params })
      if (sql.includes('FROM pg_attribute')) {
        return { rows: [{ atttypmod: params[0] === 'entries' ? entriesDims : coreDims }] }
      }
      if (sql.includes('SELECT value = $2::jsonb')) {
        return { rows: identityMatches ? [{ matches: true }] : [] }
      }
      return { rows: [] }
    },
  }
}

const identity = { model: 'onnx-community/harrier-oss-v1-270m-ONNX', dtype: 'q4' }

test('matching embedding dimensions and identity keep stored vectors', async () => {
  const db = mockDb()
  assert.equal(await resetEmbeddingColumnsForModel(db, 640, identity), false)
  assert.deepEqual(db.execs, [])
})

test('a model identity change invalidates vectors even at the same dimensions', async () => {
  const db = mockDb({ identityMatches: false })
  assert.equal(await resetEmbeddingColumnsForModel(db, 640, identity), true)
  assert.ok(db.execs.some((sql) => sql.includes('UPDATE entries SET embedding = NULL')))
  assert.ok(db.execs.some((sql) => sql.includes('UPDATE core_entries SET embedding = NULL')))
  assert.ok(db.execs.some((sql) => sql.includes('DROP TABLE IF EXISTS memory.embedding_cache')))
  assert.ok(db.queries.some(({ params }) => params[0] === 'embedding.current_model'))
})

test('a dimension change rebuilds both halfvec columns', async () => {
  const db = mockDb({ entriesDims: 384, coreDims: 384 })
  assert.equal(await resetEmbeddingColumnsForModel(db, 640, identity), true)
  assert.ok(db.execs.some((sql) => sql.includes('ALTER TABLE entries ALTER COLUMN embedding TYPE halfvec(640)')))
  assert.ok(db.execs.some((sql) => sql.includes('ALTER TABLE core_entries ALTER COLUMN embedding TYPE halfvec(640)')))
})
