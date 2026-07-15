import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  installPoolErrorHandler,
  isPgConnectionLossError,
} from '../src/runtime/memory/lib/pg/adapter.mjs'
import { startPg } from '../src/runtime/memory/lib/pg/process.mjs'

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
  mkdirSync(runtimeDir, { recursive: true })
  mkdirSync(pgdataDir, { recursive: true })
  writeFileSync(
    join(pgdataDir, 'postmaster.pid'),
    `${process.pid}\n${pgdataDir}\n${Math.floor(Date.now() / 1000)}\n55432\n\n127.0.0.1\n`,
  )
  try {
    await assert.rejects(
      startPg({ runtimeDir, pgdataDir, existingWaitMs: 20 }),
      /is alive but not ready; refusing concurrent start/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
