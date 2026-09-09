import test from 'node:test'
import assert from 'node:assert/strict'
import { loadMemorySourceEvidence, formatMemorySourceEvidence } from './memory-source-evidence.mjs'

test('review evidence preserves source identity and role without inventing missing evidence', async () => {
  const rows = [{ id: 1 }, { id: 2 }]
  const evidence = await loadMemorySourceEvidence({
    query: async () => ({ rows: [
      { root_id: 1, id: 10, role: 'user', content: 'Only for this document.' },
      { root_id: 1, id: 11, role: 'assistant', content: 'Proposed, not verified.' },
      { root_id: 1, id: 12, role: 'tool', content: 'x'.repeat(900) },
    ] }),
  }, rows)
  const formatted = JSON.parse(formatMemorySourceEvidence(rows, evidence))
  assert.deepEqual(formatted[0].sources[0], { id: 10, role: 'user', content: 'Only for this document.' })
  assert.equal(formatted[0].sources[1].role, 'assistant')
  assert.equal(formatted[0].sources[2].content.length, 400)
  assert.deepEqual(formatted[1].sources, [])
})
