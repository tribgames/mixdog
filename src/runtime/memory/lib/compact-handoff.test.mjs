import assert from 'node:assert/strict'
import test from 'node:test'

import { compactHandoffRows } from './compact-handoff.mjs'
import { renderEntryLines } from './recall-format.mjs'

const member = (id, sourceTurn, role, content) => ({
  id,
  ts: sourceTurn * 1000,
  session_id: 'session',
  source_turn: sourceTurn,
  role,
  content,
})

test('compact handoff uses one summary per completed episode and every RAW row for pending episodes', () => {
  const rows = [
    {
      id: 100,
      ts: 2000,
      session_id: 'session',
      source_turn: 1,
      is_root: 1,
      summary: 'completed episode summary',
      members: [
        member(1, 1, 'user', 'summarized request'),
        member(2, 2, 'assistant', 'summarized answer'),
      ],
    },
    {
      id: 200,
      ts: 4000,
      session_id: 'session',
      source_turn: 3,
      is_root: 1,
      summary: '',
      members: [
        member(3, 3, 'user', 'pending request'),
        member(4, 4, 'assistant', 'pending answer'),
      ],
    },
    member(5, 5, 'user', 'repeat'),
    member(6, 6, 'assistant', 'repeat'),
    member(7, 7, 'user', 'repeat'),
  ]

  const projected = compactHandoffRows(rows)
  assert.deepEqual(
    projected.map((row) => row.id).sort((a, b) => a - b),
    [3, 4, 5, 6, 7, 100],
  )
  assert.equal(projected.some((row) => row.id === 1 || row.id === 2), false)
  assert.equal(projected.filter((row) => row.content === 'repeat').length, 3)
})

test('compact handoff excludes the exact latest five-user range and splits an overlapping summary to RAW', () => {
  const rows = [
    {
      id: 100,
      ts: 4000,
      session_id: 'session',
      source_turn: 1,
      is_root: 1,
      summary: 'summary overlaps the preserved tail',
      members: [
        member(1, 1, 'user', 'old request'),
        member(2, 2, 'assistant', 'old answer'),
        member(3, 3, 'user', 'tail request 1'),
        member(4, 4, 'assistant', 'tail answer 1'),
      ],
    },
    member(5, 5, 'user', 'tail request 2'),
    member(6, 6, 'assistant', 'tail answer 2'),
    member(7, 7, 'user', 'tail request 3'),
    member(8, 8, 'assistant', 'tail answer 3'),
    member(9, 9, 'user', 'tail request 4'),
    member(10, 10, 'assistant', 'tail answer 4'),
    member(11, 11, 'user', 'tail request 5'),
    member(12, 12, 'assistant', 'tail answer 5'),
  ]

  const projected = compactHandoffRows(rows, { preserveLatestUserTurns: 5 })
  assert.deepEqual(
    projected.map((row) => row.id).sort((a, b) => a - b),
    [1, 2],
  )
  assert.equal(projected.some((row) => row.id === 100), false)
})

test('lossless compact rendering does not clip a large RAW episode body', () => {
  const suffix = 'RAW-END-MARKER'
  const projected = compactHandoffRows([
    member(1, 1, 'user', `${'x'.repeat(9000)}${suffix}`),
  ])
  const rendered = renderEntryLines(projected, {
    pendingMarks: false,
    recencyOrder: true,
    maxBodyChars: null,
  })
  assert.match(rendered, new RegExp(suffix))
})
