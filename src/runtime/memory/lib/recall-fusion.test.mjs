import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isSemanticOnlyRecall,
  rankRecallCandidates,
  recallEvidenceKind,
  recallLaneRanks,
  recallRrfScore,
} from './recall-fusion.mjs'

test('recall fusion gives dense and lexical retrieval one equal RRF lane each', () => {
  const denseOnly = { id: 1, dense_rank: 1, dense_sim: 0.8 }
  const lexicalOnly = { id: 2, sparse_rank: 1 }
  const both = { id: 3, dense_rank: 2, sparse_rank: 2 }

  assert.equal(recallRrfScore(denseOnly), recallRrfScore(lexicalOnly))
  assert.deepEqual(rankRecallCandidates([denseOnly, lexicalOnly, both]).map(({ id }) => id), [3, 1, 2])
})

test('multiple lexical candidate generators do not multiply lexical weight', () => {
  const oneLexicalHit = { id: 1, sparse_rank: 4 }
  const threeLexicalHits = { id: 2, sparse_rank: 4, trgm_rank: 8, exact_rank: 12 }

  assert.deepEqual(recallLaneRanks(threeLexicalHits), { denseRank: null, lexicalRank: 4 })
  assert.equal(recallRrfScore(oneLexicalHit), recallRrfScore(threeLexicalHits))
})

test('fixed RRF abstains only from invalid or non-positive semantic evidence', () => {
  const ranked = rankRecallCandidates([
    { id: 1, dense_rank: 1, dense_sim: -1 },
    { id: 2, dense_rank: 2, dense_sim: Number.NaN },
    { id: 3, dense_rank: 3, dense_sim: 0.8 },
  ])
  assert.deepEqual(ranked.map(({ id }) => id), [3])
})

test('semantic-only retrieval is explicit without changing RRF ordering', () => {
  assert.equal(recallEvidenceKind({ dense_rank: 1, dense_sim: 0.82 }), 'semantic')
  assert.equal(recallEvidenceKind({ sparse_rank: 1 }), 'lexical')
  assert.equal(isSemanticOnlyRecall([
    { _retrievalEvidence: 'semantic' },
    { _retrievalEvidence: 'semantic' },
  ]), true)
  assert.equal(isSemanticOnlyRecall([
    { _retrievalEvidence: 'semantic' },
    { _retrievalEvidence: 'lexical' },
  ]), false)
})
