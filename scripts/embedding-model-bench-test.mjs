import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateScoredRows,
  attachPositiveIds,
  buildEvaluation,
  classifyQueryLanguage,
  documentMatchesFilter,
  MODEL_SPECS,
  prepareBm25Documents,
  rankBm25,
  rankEqualRrf,
  scoreRanking,
  selectDeterministicCorpus,
} from './lib/embedding-model-bench-core.mjs'

test('official model contracts are represented without query-dependent branches', () => {
  assert.equal(MODEL_SPECS.granite97.pooling, 'cls')
  assert.equal(MODEL_SPECS.e5small.queryPrefix, 'query: ')
  assert.equal(MODEL_SPECS.e5small.documentPrefix, 'passage: ')
  assert.equal(MODEL_SPECS.embeddinggemma.queryPrefix, 'task: search result | query: ')
  assert.match(MODEL_SPECS.qwen3.queryPrefix, /^Instruct:/)
})

test('language splits distinguish Korean, English, and mixed queries', () => {
  assert.equal(classifyQueryLanguage('세션 전환 문제'), 'ko')
  assert.equal(classifyQueryLanguage('embedding worker crash'), 'en')
  assert.equal(classifyQueryLanguage('embedding 오류 원인'), 'mixed')
})

test('evaluation filters apply scope, category, and explicit time uniformly', () => {
  const filter = {
    projectScope: 'mixdog',
    categories: ['decision'],
    startMs: 100,
    endMs: 200,
  }
  assert.equal(documentMatchesFilter({ projectId: null, category: 'decision', ts: 150 }, filter), true)
  assert.equal(documentMatchesFilter({ projectId: 'mixdog', category: 'decision', ts: 150 }, filter), true)
  assert.equal(documentMatchesFilter({ projectId: 'other', category: 'decision', ts: 150 }, filter), false)
  assert.equal(documentMatchesFilter({ projectId: 'mixdog', category: 'fact', ts: 150 }, filter), false)
  assert.equal(documentMatchesFilter({ projectId: 'mixdog', category: 'decision', ts: 250 }, filter), false)
})

test('positive labels are attached only inside the evaluation filter', () => {
  const evaluation = buildEvaluation('fixture.json', {
    id: 'case-1',
    label: 'fixture',
    args: { query: 'where is alpha', period: 'all', projectScope: 'mixdog' },
    expect: { topNContains: ['alpha'], topN: 5 },
  })
  const documents = [
    { id: 1, textLower: 'alpha result', projectId: 'mixdog', category: 'fact', ts: 1 },
    { id: 2, textLower: 'alpha elsewhere', projectId: 'other', category: 'fact', ts: 1 },
  ]
  const attached = attachPositiveIds(evaluation, documents)
  assert.deepEqual(attached.positiveIdsByTarget, [[1]])
  assert.equal(attached.candidateCount, 1)
})

test('a target found in an eligible member promotes its root relevance', () => {
  const evaluation = buildEvaluation('fixture.json', {
    id: 'case-member',
    label: 'fixture member',
    args: { query: 'where is member answer', period: 'all', projectScope: 'mixdog' },
    expect: { topNContains: ['member answer'], topN: 5 },
  })
  const documents = [
    { id: 10, textLower: 'root summary', projectId: 'other', category: 'fact', ts: 1 },
  ]
  const matches = new Map([['member answer', [{
    rootId: 10,
    projectId: 'mixdog',
    category: 'fact',
    ts: 1,
  }]]])
  const attached = attachPositiveIds(evaluation, documents, matches)
  assert.deepEqual(attached.positiveIdsByTarget, [[10]])
  assert.deepEqual(attached.extraCandidateIds, [10])
  assert.equal(attached.candidateCount, 1)
})

test('deterministic corpus sampling keeps every positive root', () => {
  const documents = Array.from({ length: 20 }, (_, index) => ({ id: index + 1 }))
  const evaluations = [{ positiveIdsByTarget: [[2, 18], [7]] }]
  const first = selectDeterministicCorpus(documents, evaluations, 8)
  const second = selectDeterministicCorpus([...documents].reverse(), evaluations, 8)
  assert.equal(first.documents.length, 8)
  assert.deepEqual(
    new Set(first.documents.map((document) => document.id)),
    new Set(second.documents.map((document) => document.id)),
  )
  for (const id of [2, 7, 18]) assert.ok(first.documents.some((document) => document.id === id))
})

test('positive caps bound broad substring labels deterministically', () => {
  const documents = Array.from({ length: 30 }, (_, index) => ({ id: index + 1 }))
  const evaluations = [{ positiveIdsByTarget: [Array.from({ length: 20 }, (_, index) => index + 1)] }]
  const selection = selectDeterministicCorpus(documents, evaluations, 10, 3)
  assert.equal(selection.documents.length, 10)
  assert.equal(selection.positiveDocuments, 3)
  assert.match(selection.method, /up-to-3-positive-roots-per-target/)
})

test('BM25 and equal RRF produce deterministic standard rankings', () => {
  const documents = [
    { text: 'alpha alpha beta' },
    { text: 'beta gamma' },
    { text: 'alpha delta' },
  ]
  const bm25 = rankBm25('alpha', [0, 1, 2], prepareBm25Documents(documents))
  assert.equal(bm25[0].index, 0)
  assert.deepEqual(rankEqualRrf(
    [{ index: 2, score: 0.9 }, { index: 0, score: 0.8 }, { index: 1, score: 0.7 }],
    bm25,
  ).map((row) => row.index), [0, 2, 1])
})

test('ranking metrics score observable target ranks and language aggregates', () => {
  const documents = [{ id: 10, text: 'wrong' }, { id: 20, text: 'right' }, { id: 30, text: 'also right' }]
  const evaluation = {
    targets: ['right'],
    positiveIdsByTarget: [[20, 30]],
  }
  const score = scoreRanking(evaluation, [
    { index: 0, score: 0.9 },
    { index: 1, score: 0.8 },
    { index: 2, score: 0.7 },
  ], documents)
  assert.equal(score.mrrAt10, 0.5)
  assert.equal(score.recallAt5, 1)
  assert.ok(score.ndcgAt10 > 0 && score.ndcgAt10 < 1)
  const aggregate = aggregateScoredRows([{ ...score, language: 'en' }])
  assert.equal(aggregate.overall.mrrAt10, 0.5)
  assert.equal(aggregate.byLanguage.en.cases, 1)
})
