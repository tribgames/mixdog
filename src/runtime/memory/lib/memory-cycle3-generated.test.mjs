import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGeneratedReview, reviewGeneratedMemories } from './memory-cycle3-generated.mjs'

const rows = [{ id: 1, project_id: null, element: 'Lesson', core_summary: 'Already in the tool.' }]

function reviewDb() {
  let reads = 0
  let writes = 0
  let policy = {}
  const tx = { query: async (_sql, args) => {
    if (args[0] === 1 && args[1] === null) return { rows }
    writes++
    if (typeof args[0] === 'string') policy = { ...policy, ...JSON.parse(args[1]) }
    return { rows: [] }
  } }
  return {
    db: {
      query: async (_sql, args) => {
        reads++
        if (reads === 1) return { rows }
        if (reads === 2) return { rows: [] }
        return tx.query(_sql, args)
      },
      transaction: fn => fn(tx),
    },
    state: () => ({ writes, policy }),
  }
}

test('generated review excludes a duplicate without editing curated memory or removing source text', async () => {
  const fixture = reviewDb()
  const result = await reviewGeneratedMemories(fixture.db, {
    rulesDigest: 'The tool owns this guarantee.',
    callLlm: async prompt => {
      assert.match(prompt, /Original evidence/)
      return JSON.stringify([{ id: 1, action: 'exclude', reason: 'Duplicates tool contract.' }])
    },
    now: 10,
  })
  assert.equal(result.reviewed, 1)
  assert.equal(result.excluded, 1)
  assert.equal(fixture.state().policy.excluded, true)
  assert.equal(rows[0].core_summary, 'Already in the tool.')
})

test('proposal mode reports exclusion without any writes', async () => {
  const fixture = reviewDb()
  const result = await reviewGeneratedMemories(fixture.db, {
    rulesDigest: '', apply: false,
    callLlm: async () => JSON.stringify([{ id: 1, action: 'exclude', reason: 'Duplicate.' }]),
  })
  assert.equal(result.proposedExcluded, 1)
  assert.equal(result.excluded, 0)
  assert.equal(fixture.state().writes, 0)
})

test('malformed, missing and duplicate verdicts leave records untouched', async () => {
  assert.equal(parseGeneratedReview('[]', rows), null)
  assert.equal(parseGeneratedReview('[{"id":1,"action":"delete","reason":"x"}]', rows), null)
  assert.equal(parseGeneratedReview('[{"id":1,"action":"keep","reason":""}]', rows), null)
  assert.equal(parseGeneratedReview('[{"id":1,"action":"keep","reason":"x"},{"id":1,"action":"keep","reason":"x"}]', [...rows, { id: 2 }]), null)
  const fixture = reviewDb()
  const result = await reviewGeneratedMemories(fixture.db, { rulesDigest: '', callLlm: async () => 'broken' })
  assert.equal(result.error, 'invalid_generated_verdicts')
  assert.equal(fixture.state().writes, 0)
})

test('empty generated pool does not call the model', async () => {
  const result = await reviewGeneratedMemories({ query: async () => ({ rows: [] }) }, {
    rulesDigest: '', callLlm: async () => { throw new Error('must not call') },
  })
  assert.equal(result.reviewed, 0)
  assert.equal(result.error, undefined)
})
