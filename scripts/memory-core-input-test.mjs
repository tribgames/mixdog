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
  assert.match(memoryTool.description, /action=core with op/)
  // `op` is required for action=core through its own description + the handler
  // (the schema's anyOf branches only restated `required: ['action']`).
  assert.match(memoryTool.inputSchema.properties.op.description, /required for action=core/i)
  assert.deepEqual(memoryTool.inputSchema.required, ['action'])
  assert.equal(Object.hasOwn(memoryTool.inputSchema.properties.element, 'maxLength'), false)
  assert.equal(Object.hasOwn(memoryTool.inputSchema.properties.summary, 'maxLength'), false)
  assert.match(memoryTool.inputSchema.properties.project_id.description, /core pool/i)
  assert.equal(Object.hasOwn(recallTool.inputSchema.properties, 'category'), true)
})

test('unknown memory actions return the public wire shape', async () => {
  const { handleMemoryAction } = createMemoryActionHandlers({
    getDb: () => ({}),
    dataDir: tmpdir(),
    readMainConfig: () => ({}),
  })
  const result = await handleMemoryAction({ action: 'add' })
  assert.equal(result.isError, true)
  assert.match(result.text, /valid: core, status.*verbs belong in op/)
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

test('core add accepts long text, infers the cwd project, and queues cleanup', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-core-input-'))
  await mkdir(join(cwd, '.mixdog'))
  await writeFile(join(cwd, '.mixdog', 'project.id'), 'owner/repo\n')
  try {
    let addCall
    const queued = []
    const { handleMemoryAction } = createMemoryActionHandlers({
      getDb: () => ({}),
      dataDir: cwd,
      readMainConfig: () => ({}),
      addCoreImpl: async (dataDir, input, projectId) => {
        addCall = { dataDir, input, projectId }
        return { id: 1, element: input.element, summary: input.summary }
      },
      requestCycle3Review: async (reason) => { queued.push(reason); return true },
    })
    const element = 'x'.repeat(140)
    const summary = 'y'.repeat(500)
    const result = await handleMemoryAction({
      action: 'core',
      op: 'add',
      cwd,
      element,
      summary,
    })
    assert.equal(result.isError, undefined)
    assert.equal(addCall.projectId, 'owner/repo')
    assert.equal(addCall.input.element, element)
    assert.equal(addCall.input.summary, summary)
    assert.deepEqual(queued, ['core-add'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('core add treats a blank project override as automatic COMMON fallback', async () => {
  let projectIdSeen = 'unset'
  const { handleMemoryAction } = createMemoryActionHandlers({
    getDb: () => ({}),
    dataDir: tmpdir(),
    readMainConfig: () => ({}),
    addCoreImpl: async (_dataDir, input, projectId) => {
      projectIdSeen = projectId
      return { id: 1, element: input.element, summary: input.summary }
    },
  })
  const result = await handleMemoryAction({
    action: 'core',
    op: 'add',
    cwd: tmpdir(),
    project_id: ' ',
    element: 'x'.repeat(140),
    summary: 'y'.repeat(500),
  })
  assert.equal(result.isError, undefined)
  assert.equal(projectIdSeen, null)
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
    element: 'x'.repeat(140),
    summary: 'y'.repeat(500),
  })
  assert.equal(result.isError, true)
  assert.equal(result.text, 'core add: project_id "*" only valid for op="list"')
})

test('core add honors the project marker without requiring a project argument', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-core-input-'))
  await mkdir(join(cwd, '.mixdog'))
  await writeFile(join(cwd, '.mixdog', 'project.id'), '/absolute/path\n')
  try {
    const { handleMemoryAction } = createMemoryActionHandlers({
      getDb: () => ({}),
      dataDir: cwd,
      readMainConfig: () => ({}),
      addCoreImpl: async (_dataDir, input) => ({
        id: 1,
        element: input.element,
        summary: input.summary,
      }),
    })
    const result = await handleMemoryAction({
      action: 'core',
      op: 'add',
      cwd,
      element: 'durable preference',
      summary: 'Callers prefer concise answers.',
    })
    assert.equal(result.isError, undefined)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('core edit by id succeeds without project_id', async () => {
  let call
  const queued = []
  const { handleMemoryAction } = createMemoryActionHandlers({
    getDb: () => ({}),
    dataDir: tmpdir(),
    readMainConfig: () => ({}),
    editCoreImpl: async (dataDir, id, patch) => {
      call = { dataDir, id, patch }
      return { id: Number(id), element: patch.element, summary: patch.summary, category: 'preference' }
    },
    requestCycle3Review: async (reason) => { queued.push(reason); return true },
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
  assert.deepEqual(queued, ['core-edit'])
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
