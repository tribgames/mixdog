import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveMaintenancePreset } from '../src/runtime/shared/llm/index.mjs'
import { sonnetCascade } from '../src/runtime/memory/lib/memory-cycle2-gate.mjs'
import { runPhaseMerge } from '../src/runtime/memory/lib/memory-cycle2-mutations.mjs'
import { invokeCycle3Maintenance } from '../src/runtime/memory/lib/memory-cycle3.mjs'

test('cycle2 cascade uses the memory maintenance route', async () => {
  const expected = resolveMaintenancePreset('memory')
  let received
  await sonnetCascade(
    [{ id: 1, status: 'pending', verb: 'active', category: 'fact', element: 'x', summary: 'y' }],
    '',
    {
      callLlm: (opts) => {
        received = opts
        return '1|keep'
      },
    },
  )
  assert.deepEqual(received.preset, expected)
  assert.equal(received.mode, 'cycle2-cascade')
})

test('cycle2 cascade preserves an explicit test override', async () => {
  let received
  await sonnetCascade(
    [{ id: 1, status: 'pending', verb: 'active', category: 'fact', element: 'x', summary: 'y' }],
    '',
    {
      cascadePreset: 'test-route',
      callLlm: (opts) => {
        received = opts
        return '1|keep'
      },
    },
  )
  assert.equal(received.preset, 'test-route')
})

test('cycle2 phase merge judge dispatches through the memory maintenance route', async () => {
  const expected = resolveMaintenancePreset('memory')
  let received
  const db = {
    query: async () => ({ rows: [] }),
  }
  db.query = async (sql) => {
    if (sql.includes('WITH active AS')) {
      return {
        rows: [{
          a_id: 1, a_category: 'fact', a_summary: 'a', a_score: 1, a_last_seen_at: 1, a_status: 'active',
          b_id: 2, b_category: 'fact', b_summary: 'b', b_score: 1, b_last_seen_at: 1, b_status: 'active',
          sim: 0.8,
        }],
      }
    }
    return { rows: [] }
  }
  const result = await runPhaseMerge(db, {
    callLlm: (opts) => {
      received = opts
      return 'distinct'
    },
  })
  assert.equal(result.llm_calls, 1)
  assert.deepEqual(received.preset, expected)
  assert.equal(received.mode, 'cycle2-phase_merge_judge')
})

test('cycle2 phase merge preserves an explicit test override', async () => {
  let received
  const db = {
    query: async (sql) => (sql.includes('WITH active AS')
      ? { rows: [{ a_id: 1, a_category: 'fact', a_summary: 'a', a_score: 1, a_last_seen_at: 1, a_status: 'active', b_id: 2, b_category: 'fact', b_summary: 'b', b_score: 1, b_last_seen_at: 1, b_status: 'active', sim: 0.8 }] }
      : { rows: [] }),
  }
  await runPhaseMerge(db, {
    preset: 'test-route',
    callLlm: (opts) => {
      received = opts
      return 'distinct'
    },
  })
  assert.equal(received.preset, 'test-route')
})

test('cycle3 dispatches through the memory maintenance route', async () => {
  const expected = resolveMaintenancePreset('memory')
  let received
  await invokeCycle3Maintenance('test prompt', {
    callLlm: (opts) => {
      received = opts
      return '1|keep'
    },
  })
  assert.deepEqual(received.preset, expected)
  assert.equal(received.agent, 'cycle3-agent')
  assert.equal(received.mode, 'cycle3-review')
})

test('cycle3 preserves an explicit test override', async () => {
  let received
  await invokeCycle3Maintenance('test prompt', {
    preset: 'test-route',
    callLlm: (opts) => {
      received = opts
      return '1|keep'
    },
  })
  assert.equal(received.preset, 'test-route')
})
