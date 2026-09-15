#!/usr/bin/env node
// Audit/simulate on a separate snapshot. This command NEVER updates the
// live DB, starts PG, migrates a schema or replaces the supplied input file.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { auditChunkEntries, collectChunkRoots } from '../src/runtime/memory/lib/memory-chunk-audit.mjs'
import {
  generateCycle1Chunks,
} from '../src/runtime/memory/lib/memory-chunk-quality.mjs'
import { compactHandoffRows } from '../src/runtime/memory/lib/compact-handoff.mjs'
import { renderEntryLines } from '../src/runtime/memory/lib/recall-format.mjs'
import { readServiceAdvert } from '../src/runtime/shared/service-discovery.mjs'

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    'simulate-limit': { type: 'string', default: '0' },
  },
})
const simulationLimit = Number(values['simulate-limit'])
if (!Number.isSafeInteger(simulationLimit) || simulationLimit < 0) throw new Error('simulate-limit must be a nonnegative integer')
const directory = await mkdtemp(join(tmpdir(), 'mixdog-chunk-quality-'))
console.log(`Artifacts: ${directory}`)
let snapshot
if (values.input) {
  snapshot = JSON.parse(await readFile(values.input, 'utf8'))
} else {
  const advert = readServiceAdvert('pg')
  if (!Number.isInteger(Number(advert?.pg_port)) || Number(advert.pg_port) < 1) throw new Error('No advertised PG port; live audit blocked')
  const { default: pg } = await import('pg')
  const client = new pg.Client({
    host: '127.0.0.1', port: Number(advert.pg_port), user: 'postgres',
    database: 'mixdog', password: '', connectionTimeoutMillis: 10000,
  })
  await client.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const { rows } = await client.query(`
      SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source,
             project_id, chunk_root, is_root, element, category, summary, status, error_count,
             to_jsonb(e)->'chunk_quality' AS chunk_quality
      FROM memory.entries e ORDER BY id`)
    snapshot = { capturedAt: new Date().toISOString(), entries: rows }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    await client.end()
  }
}
assert.ok(Array.isArray(snapshot.entries), 'snapshot.entries must be an array')
const sourceBytes = JSON.stringify(snapshot)
const sourceHash = createHash('sha256').update(sourceBytes).digest('hex')
await writeFile(join(directory, 'snapshot.json'), sourceBytes, { flag: 'wx' })
const working = structuredClone(snapshot)
const before = auditChunkEntries(snapshot.entries)
const outcomes = []
let blocked = false
const renderOptions = { chronologicalOrder: true, compactTimestamps: true, pendingMarks: false, maxBodyChars: null }
function assertCoverage(projection, expectedRows) {
  const represented = new Set()
  for (const row of projection) {
    const ids = row._compactBody ? row._compactMemberIds : [String(row.id)]
    for (const id of ids) {
      assert.equal(represented.has(String(id)), false, `duplicate projected source ${id}`)
      represented.add(String(id))
    }
  }
  assert.deepEqual([...represented].sort(), expectedRows.map(entry => String(entry.id)).sort())
  return represented.size
}
if (simulationLimit) {
  const { callAgentDispatch } = await import('../src/runtime/memory/lib/agent-ipc.mjs')
  const { resolveMaintenancePreset } = await import('../src/runtime/shared/llm/index.mjs')
  const options = {
    callLlm: callAgentDispatch,
    request: { agent: 'cycle1-agent', taskType: 'maintenance', preset: resolveMaintenancePreset('memory'), timeout: 180000, cwd: null },
  }
  for (const root of collectChunkRoots(working.entries).slice(0, simulationLimit)) {
    const generated = await generateCycle1Chunks(root.members, options)
    const rawIds = new Set(generated.rawRowIds.map(String))
    const projected = compactHandoffRows([
      ...generated.chunks.map(chunk => ({
        ...chunk.members[0], is_root: 1, members: chunk.members,
        summary: chunk.summary, element: chunk.element, chunk_quality: chunk.quality,
      })),
      ...root.members.filter(member => rawIds.has(String(member.id))).map(member => ({ ...member, is_root: 0 })),
    ])
    const outcome = {
      id: root.id, inputRows: root.members.length,
      stats: generated.stats, chunks: generated.chunks.length, rawRowIds: generated.rawRowIds,
      errors: generated.invalidChunks, projectionCoverage: assertCoverage(projected, root.members),
      text: renderEntryLines(projected, renderOptions),
    }
    if (generated.invalidChunks.some(invalid => invalid.reason === 'llm_error')) blocked = true
    outcomes.push(outcome)
    if (blocked) break
  }
}
// Independent integrity checks: the source snapshot is unchanged; no source
// identity, content, chronology, membership or status is rewritten in the copy.
assert.equal(createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), sourceHash)
assert.deepEqual(working.entries.map(({ id, content, ts, role, chunk_root, status }) => [id, content, ts, role, chunk_root, status]),
  snapshot.entries.map(({ id, content, ts, role, chunk_root, status }) => [id, content, ts, role, chunk_root, status]))
const after = auditChunkEntries(working.entries)
const roots = collectChunkRoots(working.entries)
const rootIds = new Set(roots.map(root => String(root.id)))
const standalone = working.entries.filter(entry => !rootIds.has(String(entry.chunk_root)))
const projection = compactHandoffRows([...roots, ...standalone])
const projectionCoverage = assertCoverage(projection, working.entries)
const report = {
  capturedAt: snapshot.capturedAt, sourceHash, before, after, outcomes, blocked,
  integrity: { sourceUnchanged: true, sourceRowsUnchanged: true, projectionCoverage },
}
working.simulations = outcomes
await writeFile(join(directory, 'working.json'), JSON.stringify(working), { flag: 'wx' })
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
console.log(JSON.stringify({
  directory, audit: { ...before, chunks: undefined },
  outcomes: outcomes.map(outcome => ({ ...outcome, text: undefined })),
  integrity: report.integrity, blocked,
}, null, 2))
if (blocked) process.exitCode = 1
