import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  installPoolErrorHandler,
  isPgConnectionLossError,
} from '../src/runtime/memory/lib/pg/adapter.mjs'
import { startPg } from '../src/runtime/memory/lib/pg/process.mjs'

test('PG startup uses the portable SQL probe and initializes before the macOS marker', () => {
  const source = readFileSync(
    new URL('../src/runtime/memory/lib/pg/process.mjs', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(source, /pgBin\(runtimeDir,\s*'pg_isready'\)/)
  assert.match(source, /await healthcheckPg\(\{ port: info\.port \}\)/)
  assert.match(source, /await healthcheckPg\(\{ port \}\)/)
  assert.match(source, /if \(process\.platform === 'linux'\) \{\s*lines\.push\('effective_io_concurrency = 32'\)/)
  assert.match(source, /'max_connections = 32'/)
  assert.match(source, /'jit = off'/)
  assert.doesNotMatch(source, /shared_buffers\s*=/)
  const initIndex = source.indexOf('spawnSync(initdb')
  const markerIndex = source.indexOf("join(pgdataDir, '.metadata_never_index')")
  assert.ok(initIndex >= 0 && markerIndex > initIndex)
})

test('bundled PG memory paths do not require the optional pg_trgm extension', () => {
  const adapter = readFileSync(
    new URL('../src/runtime/memory/lib/pg/adapter.mjs', import.meta.url),
    'utf8',
  )
  const recall = readFileSync(
    new URL('../src/runtime/memory/lib/memory-recall-store.mjs', import.meta.url),
    'utf8',
  )
  const memory = readFileSync(
    new URL('../src/runtime/memory/lib/memory.mjs', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(adapter, /CREATE EXTENSION IF NOT EXISTS pg_trgm|set_limit\(/)
  assert.doesNotMatch(recall, /\bsimilarity\s*\(|\b(?:content|element|summary)\s+%\s+\$3/)
  assert.doesNotMatch(memory, /gin_trgm_ops/)
})

test('checked-out pg clients always retain an error listener', () => {
  const priorQuiet = process.env.MIXDOG_QUIET_MEMORY_LOG
  process.env.MIXDOG_QUIET_MEMORY_LOG = '1'
  try {
    const pool = new EventEmitter()
    const client = new EventEmitter()
    installPoolErrorHandler(pool, 'test-pool')
    pool.emit('connect', client)
    pool.emit('connect', client)

    assert.equal(client.listenerCount('error'), 1)
    assert.doesNotThrow(() => {
      client.emit('error', new Error('Connection terminated unexpectedly'))
    })
  } finally {
    if (priorQuiet == null) delete process.env.MIXDOG_QUIET_MEMORY_LOG
    else process.env.MIXDOG_QUIET_MEMORY_LOG = priorQuiet
  }
})

test('postgres connection-loss classifier covers reset and server termination', () => {
  assert.equal(isPgConnectionLossError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true)
  assert.equal(isPgConnectionLossError(new Error('Connection terminated unexpectedly')), true)
  assert.equal(isPgConnectionLossError(Object.assign(new Error('admin shutdown'), { code: '57P01' })), true)
  assert.equal(isPgConnectionLossError(new Error('duplicate key value violates unique constraint')), false)
})

test('startPg refuses a second start while postmaster.pid owner is alive but not ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-pg-recovery-'))
  const runtimeDir = join(root, 'runtime')
  const pgdataDir = join(root, 'pgdata')
  const blocker = createServer((socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', resolve)
  })
  const address = blocker.address()
  const blockedPort = typeof address === 'object' && address ? address.port : 0
  mkdirSync(runtimeDir, { recursive: true })
  mkdirSync(pgdataDir, { recursive: true })
  writeFileSync(
    join(pgdataDir, 'postmaster.pid'),
    `${process.pid}\n${pgdataDir}\n${Math.floor(Date.now() / 1000)}\n${blockedPort}\n\n127.0.0.1\n`,
  )
  try {
    await assert.rejects(
      startPg({ runtimeDir, pgdataDir, existingWaitMs: 20 }),
      /is alive but not ready; refusing concurrent start/,
    )
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})
