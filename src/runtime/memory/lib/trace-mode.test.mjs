import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cleanupTraceWhenDisabled,
  traceEnabled,
  traceMarkerPath,
} from './trace-mode.mjs'

test('trace defaults off and a personal data marker enables it', () => {
  const dataDir = '/mixdog/personal-data'
  const marker = traceMarkerPath(dataDir)

  assert.equal(traceEnabled(dataDir, {
    env: {},
    markerExists: () => false,
  }), false)
  assert.equal(traceEnabled(dataDir, {
    env: {},
    markerExists: (path) => path === marker,
  }), true)
})

test('MIXDOG_TRACE explicitly overrides the personal marker', () => {
  const dataDir = '/mixdog/personal-data'
  const markerExists = () => true

  assert.equal(traceEnabled(dataDir, {
    env: { MIXDOG_TRACE: '0' },
    markerExists,
  }), false)
  assert.equal(traceEnabled(dataDir, {
    env: { MIXDOG_TRACE: 'on' },
    markerExists: () => false,
  }), true)
  assert.equal(traceEnabled(dataDir, {
    env: { MIXDOG_TRACE: 'invalid' },
    markerExists,
  }), false)
})

test('disabled trace cleanup drops only the trace schema and deduplicates work', async () => {
  const calls = []
  let ensureCalls = 0
  const ensurePg = async (_dataDir, options) => {
    ensureCalls += 1
    assert.deepEqual(options, { schema: 'memory' })
    return {
      db: {
        query: async (sql) => {
          calls.push(sql)
          if (sql.includes('pg_namespace')) return { rows: [{ present: true }] }
          return { rows: [] }
        },
      },
    }
  }
  const dataDir = `/mixdog/trace-cleanup-${process.pid}-${Date.now()}`

  const first = await cleanupTraceWhenDisabled(dataDir, { enabled: false, ensurePg })
  const second = await cleanupTraceWhenDisabled(dataDir, { enabled: false, ensurePg })

  assert.deepEqual(first, { disabled: true, dropped: true })
  assert.deepEqual(second, first)
  assert.equal(ensureCalls, 1)
  assert.equal(calls.filter((sql) => sql.includes('DROP SCHEMA trace CASCADE')).length, 1)
  assert.equal(calls.some((sql) => /\bmemory\b.*(?:DROP|DELETE)/is.test(sql)), false)
})

test('enabled trace never opens PostgreSQL for cleanup', async () => {
  const result = await cleanupTraceWhenDisabled('/mixdog/enabled', {
    enabled: true,
    ensurePg: async () => {
      throw new Error('must not open PostgreSQL')
    },
  })
  assert.deepEqual(result, { disabled: false, dropped: false })
})
