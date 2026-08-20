import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  readCoreMemoryFile,
  readSessionCoreMemoryPayload,
  refreshCoreMemoryFile,
  writeCoreMemoryFileSnapshot,
} from '../src/runtime/memory/lib/core-memory-file.mjs'
import { createCwdPlugins } from '../src/session-runtime/cwd-plugins.mjs'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mixdog-core-memory-'))
}

test('refresh migrates PG rows and session reads common plus project scope from file', async (t) => {
  const root = tempRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  mkdirSync(join(project, '.mixdog'), { recursive: true })
  writeFileSync(join(project, '.mixdog', 'project.id'), 'alpha\n')
  const db = {
    query: async (sql) => sql.includes('FROM core_entries')
      ? { rows: [
          { id: 1, summary: 'common rule', project_id: null, updated_at: 10 },
          { id: 2, summary: 'alpha rule', project_id: 'alpha', updated_at: 20 },
          { id: 3, summary: 'other rule', project_id: 'beta', updated_at: 30 },
        ] }
      : { rows: [
          { core_summary: 'common generated', project_id: null, score: 1, last_seen_at: 10 },
          { core_summary: 'alpha generated', project_id: 'alpha', score: 2, last_seen_at: 20 },
          { core_summary: 'other generated', project_id: 'beta', score: 3, last_seen_at: 30 },
        ] },
  }

  const migrated = await refreshCoreMemoryFile(db, root)
  const payload = readSessionCoreMemoryPayload(root, project)

  assert.equal(migrated.written, true)
  assert.deepEqual(payload.userLines, ['[id=1] common rule', '[id=2] alpha rule'])
  assert.deepEqual(payload.dbLines, ['alpha generated', 'common generated'])
})

test('atomic revision guard rejects an older snapshot', async (t) => {
  const root = tempRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal((await writeCoreMemoryFileSnapshot(root, {
    curated: [{ id: 1, summary: 'newer', project_id: null }],
  }, { revision: 2 })).written, true)
  assert.equal((await writeCoreMemoryFileSnapshot(root, {
    curated: [{ id: 1, summary: 'older', project_id: null }],
  }, { revision: 1 })).written, false)

  const file = readCoreMemoryFile(root)
  assert.equal(file.revision, 2)
  assert.equal(file.curated[0].summary, 'newer')
})

test('session core context reads the file without starting memory runtime', async (t) => {
  const root = tempRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const priorDataDir = process.env.MIXDOG_DATA_DIR
  const priorMemoryFeature = process.env.MIXDOG_FEATURE_MEMORY
  const priorBootCore = process.env.MIXDOG_BOOT_CORE_MEMORY
  process.env.MIXDOG_DATA_DIR = root
  process.env.MIXDOG_FEATURE_MEMORY = '1'
  process.env.MIXDOG_BOOT_CORE_MEMORY = '1'
  t.after(() => {
    if (priorDataDir === undefined) delete process.env.MIXDOG_DATA_DIR
    else process.env.MIXDOG_DATA_DIR = priorDataDir
    if (priorMemoryFeature === undefined) delete process.env.MIXDOG_FEATURE_MEMORY
    else process.env.MIXDOG_FEATURE_MEMORY = priorMemoryFeature
    if (priorBootCore === undefined) delete process.env.MIXDOG_BOOT_CORE_MEMORY
    else process.env.MIXDOG_BOOT_CORE_MEMORY = priorBootCore
  })
  await writeCoreMemoryFileSnapshot(root, {
    curated: [{ id: 1, summary: 'instant context', project_id: null }],
  })
  let memoryStarts = 0
  const plugins = createCwdPlugins({
    getCurrentCwd: () => root,
    getConfig: () => ({}),
    bootProfile: () => {},
    getMemoryModule: async () => {
      memoryStarts += 1
      throw new Error('must not start')
    },
    cfgMod: { getPluginData: () => root },
    STANDALONE_DATA_DIR: root,
    clean: (value) => String(value ?? '').trim(),
  })

  assert.equal(await plugins.loadCoreMemoryContext(), '- [id=1] instant context')
  assert.equal(memoryStarts, 0)
})
