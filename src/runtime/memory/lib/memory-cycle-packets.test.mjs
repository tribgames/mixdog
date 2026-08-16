import test from 'node:test'
import assert from 'node:assert/strict'
import { packCycle1Windows } from './memory-cycle1.mjs'
import { packUnifiedGatePackets } from './memory-cycle2-gate.mjs'
import { periodicCycleDue } from './cycle-scheduler.mjs'

test('cycle1 packets cap each agent at 50 rows and each cycle at four agents', () => {
  const rowsBySession = new Map([
    ['a', Array.from({ length: 130 }, (_, i) => ({ id: 130 - i }))],
    ['b', Array.from({ length: 130 }, (_, i) => ({ id: 260 - i }))],
  ])
  const packets = packCycle1Windows(rowsBySession, 100, 10)
  assert.equal(packets.length, 4)
  assert.ok(packets.every(packet => packet.length <= 50))
  assert.equal(packets.reduce((sum, packet) => sum + packet.length, 0), 180)
})

test('cycle2 counts roots and lineage together inside the 50-material packet cap', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }))
  const candidates = new Map(rows.map(row => [
    row.id,
    Array.from({ length: 6 }, (_, i) => ({ older_id: row.id * 100 + i })),
  ]))
  const packed = packUnifiedGatePackets(rows, candidates, { materialCap: 50, maxPackets: 4 })
  assert.equal(packed.packets.length, 4)
  assert.ok(packed.packets.every(packet => packet.materialCount <= 50))
  assert.equal(packed.packets.reduce((sum, packet) => sum + packet.rows.length, 0), 28)
  assert.equal(packed.deferredIds.length, 22)
})

test('cycle2 can place 50 roots without lineage in one disposable agent packet', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }))
  const packed = packUnifiedGatePackets(rows, new Map())
  assert.equal(packed.packets.length, 1)
  assert.equal(packed.packets[0].materialCount, 50)
  assert.equal(packed.deferredIds.length, 0)
})

test('periodic cycles do not catch up immediately when the runtime starts', () => {
  const startedAt = 1_000_000
  assert.equal(periodicCycleDue(0, startedAt, 600_000, startedAt + 599_999), false)
  assert.equal(periodicCycleDue(0, startedAt, 600_000, startedAt + 600_000), true)
})
