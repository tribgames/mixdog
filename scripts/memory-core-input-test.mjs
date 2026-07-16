import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeCoreInput } from '../src/runtime/memory/lib/core-memory-store.mjs'
import { createMemoryActionHandlers } from '../src/runtime/memory/lib/memory-action-handlers.mjs'
import { TOOL_DEFS as MEMORY_TOOL_DEFS } from '../src/runtime/memory/tool-defs.mjs'
import { parseMemoryCandidateRows, parseMemoryCoreRows } from '../src/tui/app/input-parsers.mjs'
import { memoryToolArgsForCaller } from '../src/session-runtime/runtime-core.mjs'

test('memory mutation schema omits category while recall keeps its internal filter', () => {
  const memoryTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'memory')
  const recallTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'recall')
  assert.equal(Object.hasOwn(memoryTool.inputSchema.properties, 'category'), false)
  assert.doesNotMatch(memoryTool.description, /category/i)
  assert.equal(Object.hasOwn(recallTool.inputSchema.properties, 'category'), true)
})

test('memory tool calls inherit the active caller cwd only when cwd is omitted', () => {
  assert.deepEqual(memoryToolArgsForCaller({ action: 'status' }, '/active/project'), {
    action: 'status',
    cwd: '/active/project',
  })
  const explicit = { action: 'status', cwd: '/explicit/project' }
  assert.equal(memoryToolArgsForCaller(explicit, '/active/project'), explicit)
})

test('core content aliases summary, derives an element, and accepts no category', () => {
  const content = 'A durable preference that callers should receive concise answers.'
  const input = normalizeCoreInput({ content }, {
    requireElement: true,
    requireSummary: true,
    requireCategory: false,
  })
  assert.equal(input.summary, content)
  assert.equal(input.element, content.slice(0, 40))
  assert.equal(input.category, 'fact')
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
    })
    assert.equal(result.isError, true)
    assert.equal(
      result.text,
      'core add: project_id required — pass "common" for COMMON pool, or project slug like "owner/repo" for scoped pool (cwd suggests "owner/repo"); element too long (41/40 chars, remove 1); summary too long (101/100 chars, remove 1)',
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
  })
  assert.equal(result.isError, true)
  assert.match(result.text, /^core add: project_id required —/)
  assert.match(result.text, /element too long \(41\/40 chars, remove 1\)/)
  assert.match(result.text, /summary too long \(101\/100 chars, remove 1\)/)
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
  })
  assert.equal(result.isError, true)
  assert.match(result.text, /^core add: project_id "\*" only valid for op="list"; element too long/)
  assert.match(result.text, /summary too long \(101\/100 chars, remove 1\)/)
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
      return { id: Number(id), element: patch.element, summary: patch.summary, category: 'preference' }
    },
  })
  const result = await handleMemoryAction({
    action: 'core',
    op: 'edit',
    id: 7,
    element: 'reply style',
    summary: 'Use concise answers.',
  })
  assert.equal(result.isError, undefined)
  assert.equal(result.text, 'core edited (id=7): reply style — Use concise answers.')
  assert.equal(call.id, 7)
  assert.equal(call.patch.project_id, undefined)
  assert.equal(call.patch.category, undefined)
})

test('category-free core and candidate rows remain selectable in the TUI', () => {
  const [core] = parseMemoryCoreRows('COMMON:\nid=7 reply style — Use concise answers.')
  assert.equal(core._id, 7)
  assert.equal(core._element, 'reply style')
  assert.equal(core._summary, 'Use concise answers.')
  assert.equal(Object.hasOwn(core, '_category'), false)

  const [candidate] = parseMemoryCandidateRows(
    'id=9 project=COMMON score=1.60 coding agent refs — Use C:\\Project\\refs. (durable)',
  )
  assert.equal(candidate._id, 9)
  assert.equal(candidate.label, '#9 coding agent refs')
  assert.equal(candidate._projectId, null)
})
