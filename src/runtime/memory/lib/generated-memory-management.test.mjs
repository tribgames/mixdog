import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { listManagedMemories, formatManagedMemories, excludeGeneratedMemory } from './generated-memory-management.mjs'
import { parseMemoryCoreRows } from '../../../tui/app/input-parsers.mjs'

test('listing includes both namespaces, injection state and a continuation without losing full summaries', async () => {
  const rows = [
    { source: 'curated', id: 1, project_id: 'mixdog', element: 'Preference', summary: 'Keep this.', status: 'active', injection_enabled: true, excluded: false },
    { source: 'generated', id: 1, project_id: null, element: 'History', summary: 'x'.repeat(300), status: 'active', injection_enabled: false, excluded: true },
    { source: 'generated', id: 2 },
  ]
  const page = await listManagedMemories({
    query: async () => ({ rows }),
    transaction: run => run({ query: async sql => ({
      rows: sql.includes('FROM core_entries') ? rows.filter(row => row.source === 'curated') : [],
    }) }),
  }, '*', { limit: 2, include_inactive: true })
  assert.equal(page.nextOffset, 2)
  const text = formatManagedMemories(page)
  assert.match(text, /id=1 source=curated/)
  assert.match(text, /generated_id=1 source=generated/)
  assert.match(text, /injection=disabled excluded=true/)
  assert.ok(text.includes('x'.repeat(300)))
  const ui = parseMemoryCoreRows(text)[0]
  assert.equal(ui._projectId, 'mixdog')
  assert.equal(ui._element, 'Preference')
  assert.equal(ui._summary, 'Keep this.')
  assert.equal(parseMemoryCoreRows(text)[1]._action, undefined)
})

test('listing defaults to injected memories, filtering before pagination and preserving scope', async () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    sqlite.exec(`
      CREATE TABLE core_entries (id INTEGER, project_id TEXT, element TEXT, summary TEXT, status TEXT);
      CREATE TABLE entries (id INTEGER, project_id TEXT, element TEXT, core_summary TEXT, status TEXT, is_root INTEGER);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO core_entries VALUES
        (1, 'mixdog', 'Archived', 'Old rule', 'archived'),
        (2, NULL, 'Common', 'Common preference', NULL),
        (3, 'mixdog', 'Active', 'Project preference', 'active'),
        (4, 'other', 'Other', 'Other preference', 'active');
      INSERT INTO entries VALUES
        (10, 'mixdog', 'Generated', 'Historical summary', 'active', 1);
    `)
    // Execute the production query; adapt only PostgreSQL parameter/cast syntax.
    const db = { query: async (sql, args = []) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
      const statement = sqlite.prepare(sql.replace(/::(?:text|boolean|jsonb)/g, '').replace(/\$(\d+)/g, ':p$1'))
      return { rows: statement.all(Object.fromEntries(args.map((value, i) =>
        [`p${i + 1}`, typeof value === 'boolean' ? Number(value) : value]))) }
    }, transaction: async run => {
      sqlite.exec('BEGIN')
      try { const result = await run(db); sqlite.exec('COMMIT'); return result }
      catch (error) { sqlite.exec('ROLLBACK'); throw error }
    } }
    const first = await listManagedMemories(db, 'mixdog', { limit: 1 })
    assert.deepEqual(first.entries.map(row => row.id), [1])
    assert.equal(first.nextOffset, 1)
    const second = await listManagedMemories(db, 'mixdog', { limit: 1, offset: first.nextOffset })
    assert.deepEqual(second.entries.map(row => row.id), [1])
    assert.equal(second.nextOffset, null)
    const projectOnly = await listManagedMemories(db, 'mixdog', { source: 'curated', scope_only: true })
    assert.deepEqual(projectOnly.entries.map(row => row.id), [1])
    const commonOnly = await listManagedMemories(db, null, { source: 'curated', scope_only: true })
    assert.deepEqual(commonOnly.entries.map(row => row.id), [1])
    const allProjects = await listManagedMemories(db, '*')
    assert.deepEqual(allProjects.entries.map(row => row.id), [1, 1, 1])
    const generated = await listManagedMemories(db, 'mixdog', { source: 'generated' })
    assert.deepEqual(generated.entries, [])
    const full = await listManagedMemories(db, 'mixdog', { include_inactive: true })
    assert.deepEqual(full.entries.map(row => row.id), [1, null, 1, 10])
    const history = await listManagedMemories(db, 'mixdog', { source: 'generated', include_inactive: true })
    assert.deepEqual(history.entries.map(row => row.id), [10])
    await assert.rejects(listManagedMemories(db, '*', { include_inactive: 'false' }), /must be a boolean/)
  } finally {
    sqlite.close()
  }
})

test('exclusion preserves the source record and creates a persistent management decision', async () => {
  const source = { id: 7, project_id: 'mixdog', core_summary: 'History', content: 'Original transcript', status: 'active', core_candidate_status: 'candidate' }
  const before = { ...source }
  let policy
  let writes = 0
  const tx = { query: async (_sql, args) => {
    if (args.length === 2 && args[0] === 7 && args[1] === 'mixdog') return { rows: [source] }
    if (typeof args[0] === 'string') policy = JSON.parse(args[1])
    writes++
    return { rows: [] }
  } }
  const result = await excludeGeneratedMemory({ transaction: fn => fn(tx) }, 7, 'mixdog', 'user-request', { now: 123 })
  assert.equal(result.applied, true)
  assert.equal(policy.excluded, true)
  assert.equal(policy.reason, 'user-request')
  assert.equal(writes, 2)
  assert.deepEqual(source, before)
})

test('missing/out-of-scope records cannot be excluded', async () => {
  const db = { transaction: fn => fn({ query: async () => ({ rows: [] }) }) }
  await assert.rejects(excludeGeneratedMemory(db, 7, 'other'), /resolved scope/)
  await assert.rejects(excludeGeneratedMemory(db, 7, '*'), /explicit project/)
})

test('a changed summary or in-flight promotion is not overwritten by a review', async () => {
  let row = { id: 7, core_summary: 'newer', core_candidate_status: 'candidate' }
  const db = { transaction: fn => fn({ query: async () => ({ rows: [row] }) }) }
  assert.equal((await excludeGeneratedMemory(db, 7, null, 'duplicate', { expectedSummary: 'older' })).applied, false)
  row = { ...row, core_candidate_status: 'promoting' }
  await assert.rejects(excludeGeneratedMemory(db, 7, null), /being promoted/)
})
