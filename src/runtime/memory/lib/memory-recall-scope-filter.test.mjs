import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendProjectScopeClause,
  projectScopePredicate,
} from './memory-recall-scope-filter.mjs'

test('projectScopePredicate keeps common/all/slug SQL shapes and param offsets', () => {
  assert.deepEqual(projectScopePredicate('common', 3), { clause: 'project_id IS NULL', params: [] })
  assert.deepEqual(projectScopePredicate('all', 3), { clause: '', params: [] })
  assert.deepEqual(projectScopePredicate(undefined, 3), { clause: '', params: [] })
  assert.deepEqual(projectScopePredicate('mixdog', 5, { column: 'e.project_id' }), {
    clause: '(e.project_id IS NULL OR e.project_id = $5)',
    params: ['mixdog'],
  })
})

test('appendProjectScopeClause binds the next placeholder without reordering existing params', () => {
  const where = ['chunk_root IS NULL']
  const params = [10]
  appendProjectScopeClause(where, params, 'mixdog')
  assert.deepEqual(where, ['chunk_root IS NULL', '(project_id IS NULL OR project_id = $2)'])
  assert.deepEqual(params, [10, 'mixdog'])
  appendProjectScopeClause(where, params, 'all')
  assert.deepEqual(params, [10, 'mixdog'])
})

test('projectScopePredicate binds truthy numeric/object scopes without coercion', () => {
  const objectScope = { id: 42 }
  assert.deepEqual(projectScopePredicate(7, 3), {
    clause: '(project_id IS NULL OR project_id = $3)',
    params: [7],
  })
  const objectPred = projectScopePredicate(objectScope, 4)
  assert.equal(objectPred.clause, '(project_id IS NULL OR project_id = $4)')
  assert.equal(objectPred.params.length, 1)
  assert.equal(objectPred.params[0], objectScope)
})
