import assert from 'node:assert/strict'
import test from 'node:test'

import { createCompactVectorCache } from '../src/runtime/memory/lib/compact-vector-cache.mjs'

test('embedding cache compacts vectors to float32 without changing caller array semantics', () => {
  const cache = createCompactVectorCache({ maxEntries: 3, maxBytes: 4096 })
  const original = [0.25, -0.5, 0.75]
  assert.equal(cache.set('a', original), true)
  original[0] = 99

  const cached = cache.get('a')
  assert.ok(cached instanceof Float32Array)
  assert.deepEqual([...cached], [0.25, -0.5, 0.75])
  assert.equal(cache.snapshot().entries, 1)
  assert.ok(cache.snapshot().bytes < 256)
})

test('embedding cache preserves LRU hits while enforcing entry and byte bounds', () => {
  const cache = createCompactVectorCache({ maxEntries: 2, maxBytes: 1200 })
  cache.set('a', Array(64).fill(1))
  cache.set('b', Array(64).fill(2))
  assert.ok(cache.get('a'))
  cache.set('c', Array(64).fill(3))

  assert.equal(cache.has('a'), true)
  assert.equal(cache.has('b'), false)
  assert.equal(cache.has('c'), true)
  assert.equal(cache.snapshot().entries, 2)
  assert.ok(cache.snapshot().bytes <= cache.snapshot().maxBytes)

  assert.equal(cache.set('oversized', Array(1000).fill(4)), false)
  assert.equal(cache.has('oversized'), false)
})
