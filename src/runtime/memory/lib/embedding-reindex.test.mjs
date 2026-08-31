import assert from 'node:assert/strict'
import test from 'node:test'

import { drainEmbeddingReindex } from './embedding-reindex.mjs'

test('embedding reindex resumes timed-out entry passes and then fills core memory', async () => {
  const results = [
    { attempted: 32, succeeded: 32, failed: [], timedOut: true },
    { attempted: 4, succeeded: 4, failed: [], timedOut: false },
  ]
  let waits = 0
  const summary = await drainEmbeddingReindex({
    flushEntries: async () => results.shift(),
    backfillCore: async () => 3,
    wait: async () => { waits += 1 },
  })
  assert.deepEqual(summary, {
    passes: 2,
    attempted: 36,
    succeeded: 36,
    failed: 0,
    coreFilled: 3,
  })
  assert.equal(waits, 1)
})

test('embedding reindex stops retrying a timed-out pass that made no progress', async () => {
  let calls = 0
  const summary = await drainEmbeddingReindex({
    flushEntries: async () => {
      calls += 1
      return { attempted: 32, succeeded: 0, failed: Array(32).fill(0), timedOut: true }
    },
  })
  assert.equal(calls, 1)
  assert.equal(summary.failed, 32)
})
