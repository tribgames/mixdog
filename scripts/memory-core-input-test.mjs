import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeCoreInput } from '../src/runtime/memory/lib/core-memory-store.mjs'
import { createMemoryActionHandlers } from '../src/runtime/memory/lib/memory-action-handlers.mjs'

test('core content aliases summary and derives a bounded element', () => {
  const content = 'A durable preference that callers should receive concise answers.'
  const input = normalizeCoreInput({ content, category: 'preference' }, {
    requireElement: true,
    requireSummary: true,
    requireCategory: true,
  })
  assert.equal(input.summary, content)
  assert.equal(input.element, content.slice(0, 40))
  assert.deepEqual(input.errors, [])
})

test('core add reports every invalid field and cwd project hint together', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-core-input-'))
  await mkdir(join(cwd, '.mixdog'))
  await writeFile(join(cwd, '.mixdog', 'project.id'), 'owner/repo\n')
  try {
    const { handleMemoryAction } = createMemoryActionHandlers({
      getDb: () => ({}),
      dataDir: cwd,
      readMainConfig: () => ({}),
    })
    const result = await handleMemoryAction({
      action: 'core',
      op: 'add',
      cwd,
      element: 'x'.repeat(41),
      summary: 'y'.repeat(101),
      category: 'unknown',
    })
    assert.equal(result.isError, true)
    assert.equal(
      result.text,
      'core add: project_id required — pass "common" for COMMON pool, or project slug like "owner/repo" for scoped pool (cwd suggests "owner/repo"); element too long (41/40 chars, remove 1); summary too long (101/100 chars, remove 1); invalid category "unknown". Valid: rule, constraint, decision, fact, goal, preference, task, issue',
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('core add rejects blank project_id in the batched error', async () => {
  const { handleMemoryAction } = createMemoryActionHandlers({
    getDb: () => ({}),
    dataDir: tmpdir(),
    readMainConfig: () => ({}),
  })
  const result = await handleMemoryAction({
    action: 'core',
    op: 'add',
    project_id: ' ',
    element: 'x'.repeat(41),
    summary: 'y'.repeat(101),
    category: 'unknown',
  })
  assert.equal(result.isError, true)
  assert.match(result.text, /^core add: project_id required —/)
  assert.match(result.text, /element too long \(41\/40 chars, remove 1\)/)
  assert.match(result.text, /summary too long \(101\/100 chars, remove 1\)/)
  assert.match(result.text, /invalid category "unknown"/)
})

test('core add folds project_id "*" into the batched error', async () => {
  const { handleMemoryAction } = createMemoryActionHandlers({
    getDb: () => ({}),
    dataDir: tmpdir(),
    readMainConfig: () => ({}),
  })
  const result = await handleMemoryAction({
    action: 'core',
    op: 'add',
    project_id: '*',
    element: 'x'.repeat(41),
    summary: 'y'.repeat(101),
    category: 'unknown',
  })
  assert.equal(result.isError, true)
  assert.match(result.text, /^core add: project_id "\*" only valid for op="list"; element too long/)
  assert.match(result.text, /summary too long \(101\/100 chars, remove 1\)/)
  assert.match(result.text, /invalid category "unknown"/)
})

test('core add suppresses malformed cwd project hints', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-core-input-'))
  await mkdir(join(cwd, '.mixdog'))
  await writeFile(join(cwd, '.mixdog', 'project.id'), '/absolute/path\n')
  try {
    const { handleMemoryAction } = createMemoryActionHandlers({
      getDb: () => ({}),
      dataDir: cwd,
      readMainConfig: () => ({}),
    })
    const result = await handleMemoryAction({
      action: 'core',
      op: 'add',
      cwd,
      element: 'durable preference',
      summary: 'Callers prefer concise answers.',
      category: 'preference',
    })
    assert.equal(result.text, 'core add: project_id required — pass "common" for COMMON pool, or project slug like "owner/repo" for scoped pool')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('core edit by id succeeds without project_id', async () => {
  let call
  const { handleMemoryAction } = createMemoryActionHandlers({
    getDb: () => ({}),
    dataDir: tmpdir(),
    readMainConfig: () => ({}),
    editCoreImpl: async (dataDir, id, patch) => {
      call = { dataDir, id, patch }
      return { id: Number(id), element: patch.element, summary: patch.summary, category: patch.category }
    },
  })
  const result = await handleMemoryAction({
    action: 'core',
    op: 'edit',
    id: 7,
    element: 'reply style',
    summary: 'Use concise answers.',
    category: 'preference',
  })
  assert.equal(result.isError, undefined)
  assert.equal(result.text, 'core edited (id=7): [preference] reply style — Use concise answers.')
  assert.equal(call.id, 7)
  assert.equal(call.patch.project_id, undefined)
})
