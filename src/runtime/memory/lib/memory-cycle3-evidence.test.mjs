import test from 'node:test'
import assert from 'node:assert/strict'
import { collectCycle3ReviewEvidence } from './memory-cycle3-evidence.mjs'

const embed = async () => [1, 0, 0]

test('COMMON core receives separate all-project evidence for reclassification', async () => {
  const calls = []
  const search = async (_db, _query, options) => {
    calls.push(options.projectScope)
    if (options.projectScope === 'common') {
      return [{ id: 1, project_id: null, category: 'fact', summary: 'generic benchmark note' }]
    }
    return [
      { id: 1, project_id: null, category: 'fact', summary: 'generic benchmark note' },
      { id: 2, project_id: 'mixdog', category: 'rule', summary: 'Mixdog TB harness rule' },
    ]
  }
  const core = {
    id: 14,
    project_id: null,
    category: 'rule',
    element: 'TB benchmark rules',
    summary: 'Use the Mixdog TB harness.',
  }

  const result = await collectCycle3ReviewEvidence({}, [core], {
    embed,
    search,
    relatedLimit: 6,
    log: () => {},
  })

  assert.deepEqual(calls, ['common', 'all'])
  assert.match(result.coreReview, /related current memory in its current scope/)
  assert.match(result.coreReview, /scope evidence from other pools/)
  assert.match(result.coreReview, /mixdog/)
  assert.ok(result.knownPools.has('mixdog'))
})

test('project core receives COMMON evidence for project-to-COMMON review', async () => {
  const search = async (_db, _query, options) => {
    if (options.projectScope === 'mixdog') {
      return [{ id: 3, project_id: 'mixdog', category: 'preference', summary: 'local wording preference' }]
    }
    return [
      { id: 4, project_id: null, category: 'preference', summary: 'same preference used across projects' },
      { id: 3, project_id: 'mixdog', category: 'preference', summary: 'local wording preference' },
    ]
  }
  const core = {
    id: 27,
    project_id: 'mixdog',
    category: 'preference',
    element: 'Reply style',
    summary: 'Use concise replies.',
  }

  const result = await collectCycle3ReviewEvidence({}, [core], {
    embed,
    search,
    relatedLimit: 6,
    log: () => {},
  })

  assert.match(result.coreReview, /scope evidence from other pools \(top 1\)/)
  assert.match(result.coreReview, /COMMON preference/)
  assert.ok(result.knownPools.has('mixdog'))
})

test('cross-scope recall failure preserves current-scope review evidence', async () => {
  const messages = []
  const search = async (_db, _query, options) => {
    if (options.projectScope === 'all') throw new Error('cross-scope unavailable')
    return [{ id: 5, project_id: null, category: 'rule', summary: 'current rule' }]
  }
  const core = {
    id: 7,
    project_id: null,
    category: 'rule',
    element: 'Current rule',
    summary: 'Keep this rule.',
  }

  const result = await collectCycle3ReviewEvidence({}, [core], {
    embed,
    search,
    relatedLimit: 6,
    log: message => messages.push(message),
  })

  assert.match(result.coreReview, /current rule/)
  assert.match(result.coreReview, /scope evidence from other pools: \(none found\)/)
  assert.match(messages.join(''), /cross-scope recall failed/)
})
