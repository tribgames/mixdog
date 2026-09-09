import test from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORY_GRADE, computeEntryScore } from './memory-score.mjs'

test('all generated categories age uniformly without immortal rules', () => {
  const now = 400 * 86_400_000
  const scores = Object.keys(CATEGORY_GRADE).map(category => computeEntryScore(category, 0, now))
  assert.equal(new Set(scores).size, 1)
  assert.ok(scores[0] > 0)
  assert.ok(scores[0] < computeEntryScore('rule', now, now))
  assert.equal(computeEntryScore('unknown', 0, now), null)
})
