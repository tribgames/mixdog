import assert from 'node:assert/strict'
import test from 'node:test'

import { interleaveRawRows } from './recall-format.mjs'
import {
  boundRecallRowsToTemporal,
  mergeHistoricalRecallRows,
  rankLatestRecallRows,
} from './query-ranking.mjs'

test('latest recall ranks the newest topic-covered evidence and demotes query echo', () => {
  const query = 'latest BrowserPane memory result'
  const rows = [
    {
      id: 1,
      ts: 100,
      content: 'BrowserPane memory result was 420 MB',
      retrievalScore: 0.02,
    },
    {
      id: 2,
      ts: 200,
      content: 'BrowserPane memory result is 310 MB',
      retrievalScore: 0.01,
    },
    {
      id: 3,
      ts: 300,
      content: query,
      retrievalScore: 0.04,
    },
    {
      id: 4,
      ts: 400,
      content: 'unrelated deployment result',
      retrievalScore: 0.05,
    },
  ]

  assert.deepEqual(rankLatestRecallRows(rows, query).map((row) => row.id), [2, 1, 4, 3])
})

test('historical merge reserves novel root evidence without replacing the best hit', () => {
  const primary = [
    { id: 1, element: 'primary one' },
    { id: 2, element: 'primary two' },
    { id: 3, element: 'primary three' },
  ]
  const roots = [
    { id: 1, element: 'classified one', summary: 'root summary' },
    { id: 4, element: 'historical root' },
  ]

  const merged = mergeHistoricalRecallRows(primary, roots, 3, {
    includeMatchedRootSummary: true,
    rootReserve: 1,
  })

  assert.deepEqual(merged.map((row) => row.id), [1, 4, 2])
  assert.equal(merged[0]._historicalRootSummary, 'root summary')
})

test('temporal bounding keeps an out-of-window root when an in-window member matched', () => {
  const rows = [{
    id: 10,
    ts: 50,
    members: [
      { id: 11, ts: 150 },
      { id: 12, ts: 250 },
    ],
  }]

  assert.deepEqual(
    boundRecallRowsToTemporal(rows, { startMs: 100, endMs: 200 }),
    [{ id: 10, ts: 50, members: [{ id: 11, ts: 150 }] }],
  )
})

test('core memory interleave preserves the leading hybrid result', () => {
  const hybrid = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
  const core = [{ id: 'core:1' }]

  assert.deepEqual(
    interleaveRawRows(hybrid, core).map((row) => row.id),
    [1, 2, 'core:1', 3, 4],
  )
})
