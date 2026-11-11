#!/usr/bin/env node
// Node's scoped core-memory indices (src/runtime/memory/lib/core-memory-index.test.mjs, 3 cases) from the real
// `syncCoreMemoryIndexes`, `indexedCoreRecord`, `resolveCoreMemoryIndex` (core-memory-index.mjs),
// `listManagedMemories`/`formatManagedMemories` (core-memory-management.mjs) and the public `memory` tool
// (`createMemoryActionHandlers(...).handleToolCall`, memory-action-handlers.mjs). The database is the test file's own
// stand-in: an in-memory SQLite (node:sqlite) with `core_entries` and `meta` behind `db.query` (it drops the PG casts,
// maps $n to named parameters and answers pg_advisory_xact_lock with no rows). Every statement is recorded (text and
// params, in order) with the meta and core_entries tables after each step. The TUI row parser the test also exercises
// (`parseMemoryCoreRows`, src/tui) is not recorded: the TUI is deleted; the formatted list text it parsed is recorded.
// Edit/delete implementations are the test file's stand-ins (they write to the same SQLite) and are recorded by call.
//
//   node --disable-warning=ExperimentalWarning benchmarks/rust-core/recorders/record-memory-core-index.mjs --tree <dir>
import { DatabaseSync } from 'node:sqlite';
import { begin, capture, finish, freezeClock, importFrom, exact } from './lib/mc-record.mjs';

const ctx = begin();
const CLOCK_MS = 1_800_000_000_000;
freezeClock(CLOCK_MS);
const dir = 'src/runtime/memory/lib/';
const { indexedCoreRecord, resolveCoreMemoryIndex, syncCoreMemoryIndexes } = await importFrom(ctx.tree, `${dir}core-memory-index.mjs`);
const { listManagedMemories, formatManagedMemories } = await importFrom(ctx.tree, `${dir}core-memory-management.mjs`);
const { createMemoryActionHandlers } = await importFrom(ctx.tree, `${dir}memory-action-handlers.mjs`);

function fixture() {
  const sql = new DatabaseSync(':memory:');
  const statements = [];
  sql.exec(`
    CREATE TABLE core_entries(id INTEGER PRIMARY KEY, project_id TEXT, status TEXT, element TEXT, summary TEXT, agent_id TEXT);
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO core_entries(id, project_id, status, element, summary) VALUES
      (81, NULL, 'active', 'Common', 'Common preference'),
      (150, 'alpha', 'active', 'First', 'First alpha memory'),
      (170, 'alpha', 'active', 'Second', 'Second alpha memory'),
      (200, 'beta', 'active', 'Beta', 'Beta memory');
  `);
  const db = {
    async query(statement, args = []) {
      statements.push({ sql: statement, params: exact(args) });
      if (statement.includes('pg_advisory_xact_lock')) return { rows: [] };
      const prepared = sql.prepare(statement.replace(/::(?:text|boolean|jsonb)/g, '').replace(/\$(\d+)/g, ':p$1'));
      const params = Object.fromEntries(args.map((value, i) => [`p${i + 1}`, typeof value === 'boolean' ? Number(value) : value]));
      return { rows: prepared.all(params) };
    },
    async transaction(run) {
      sql.exec('BEGIN');
      try { const result = await run(db); sql.exec('COMMIT'); return result; } catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const tables = () => ({ meta: sql.prepare('SELECT * FROM meta ORDER BY key').all().map((r) => ({ ...r })), core_entries: sql.prepare('SELECT * FROM core_entries ORDER BY id').all().map((r) => ({ ...r })) });
  return { sql, db, statements, tables };
}
const step = async (f, label, fn) => {
  const before = f.statements.length;
  const out = await capture(fn);
  return { label, ...out, statements: f.statements.slice(before), tables: f.tables() };
};

const cases = [];
{
  const f = fixture();
  const { sql, db } = f;
  const steps = [];
  const first = await syncCoreMemoryIndexes(db);
  steps.push({ label: 'first sync', result: exact(first), statements: f.statements.splice(0), tables: f.tables() });
  const rec = (row, index) => exact(indexedCoreRecord(row, index));
  const probe = (label, row, index) => ({ label, row, ...rec(row, index) });
  const common = indexedCoreRecord({ id: 81, project_id: null }, first);
  const alpha = indexedCoreRecord({ id: 150, project_id: 'alpha' }, first);
  const beta = indexedCoreRecord({ id: 200, project_id: 'beta' }, first);
  steps.push({ label: 'indexedCoreRecord after the first sync', probes: [probe('common 81', { id: 81, project_id: null }, first), probe('alpha 150', { id: 150, project_id: 'alpha' }, first), probe('beta 200', { id: 200, project_id: 'beta' }, first), probe('alpha 170', { id: 170, project_id: 'alpha' }, first), probe('unknown 999', { id: 999, project_id: 'alpha' }, first)] });
  steps.push(await step(f, 'sync again returns the same indices', () => syncCoreMemoryIndexes(db)));
  steps.push(await step(f, 'resolve alpha 1 with its revision', () => resolveCoreMemoryIndex(db, 'alpha', 1, alpha.index_revision)));
  steps.push(await step(f, "resolve beta 1 with alpha's revision", () => resolveCoreMemoryIndex(db, 'beta', 1, alpha.index_revision)));
  steps.push(await step(f, 'resolve alpha 1 without a revision', () => resolveCoreMemoryIndex(db, 'alpha', 1, undefined)));
  sql.exec('DELETE FROM core_entries WHERE id=150');
  const compacted = await syncCoreMemoryIndexes(db);
  const remaining = indexedCoreRecord({ id: 170, project_id: 'alpha' }, compacted);
  steps.push({ label: 'after deleting alpha 150: sync (compaction)', result: exact(compacted), remaining: exact(remaining), alphaRevisionChanged: remaining.index_revision !== alpha.index_revision, betaRevisionKept: indexedCoreRecord({ id: 200, project_id: 'beta' }, compacted).index_revision === beta.index_revision, statements: f.statements.splice(0), tables: f.tables() });
  steps.push(await step(f, 'resolve alpha 1 with the old revision', () => resolveCoreMemoryIndex(db, 'alpha', 1, alpha.index_revision)));
  steps.push(await step(f, 'resolve alpha 1 with the new revision', () => resolveCoreMemoryIndex(db, 'alpha', 1, remaining.index_revision)));
  sql.exec("INSERT INTO core_entries(id, project_id, status, element, summary) VALUES(201, 'alpha', 'active', 'New', 'New alpha memory')");
  const added = await syncCoreMemoryIndexes(db);
  steps.push({ label: 'after adding alpha 201: sync', result: exact(added), probe: rec({ id: 201, project_id: 'alpha' }, added), statements: f.statements.splice(0), tables: f.tables() });
  sql.exec("UPDATE core_entries SET project_id='alpha' WHERE id=81");
  const moved = await syncCoreMemoryIndexes(db);
  steps.push({ label: 'after moving common 81 to alpha: sync (append on move)', result: exact(moved), probes: [rec({ id: 81, project_id: 'alpha' }, moved), rec({ id: 170, project_id: 'alpha' }, moved)], statements: f.statements.splice(0), tables: f.tables() });
  steps.push(await step(f, 'resolve common 1 with the old common revision', () => resolveCoreMemoryIndex(db, null, 1, common.index_revision)));
  sql.exec("INSERT INTO core_entries(id, project_id, status, element, summary) VALUES(202, NULL, 'active', 'New common', 'New common memory')");
  const withCommon = await syncCoreMemoryIndexes(db);
  steps.push({ label: 'after adding common 202: sync', result: exact(withCommon), probe: rec({ id: 202, project_id: null }, withCommon), statements: f.statements.splice(0), tables: f.tables() });
  sql.exec("UPDATE core_entries SET status='archived' WHERE id=170");
  const archived = await syncCoreMemoryIndexes(db);
  steps.push({ label: 'after archiving alpha 170: sync', result: exact(archived), probes: [rec({ id: 201, project_id: 'alpha' }, archived), rec({ id: 170, project_id: 'alpha' }, archived)], statements: f.statements.splice(0), tables: f.tables(), summaryOf170: sql.prepare('SELECT summary FROM core_entries WHERE id=170').get().summary });
  cases.push({ name: 'real scoped indices persist, compact independently, append on move, and reject stale requests (test line 44)', steps });
  sql.close();
}
{
  const f = fixture();
  const { sql, db } = f;
  const steps = [];
  const page = await listManagedMemories(db, '*', { source: 'curated' });
  steps.push({ label: "list '*' curated", result: exact(page), formatted: formatManagedMemories(page), statements: f.statements.splice(0) });
  const resolves = [];
  for (const entry of page.entries) resolves.push({ projectId: entry.project_id ?? null, id: entry.id, ...(await capture(() => resolveCoreMemoryIndex(db, entry.project_id ?? null, entry.id, entry.index_revision))), expectRecordId: entry.record_id });
  steps.push({ label: "resolve every listed entry with its own revision (what a list consumer sends back)", resolves, statements: f.statements.splice(0) });
  const scoped = await listManagedMemories(db, 'alpha', { source: 'curated', scope_only: true, limit: 1 });
  steps.push({ label: 'alpha scope_only limit 1', result: exact(scoped), formatted: formatManagedMemories(scoped), statements: f.statements.splice(0) });
  const next = await listManagedMemories(db, 'alpha', { source: 'curated', scope_only: true, limit: 1, offset: scoped.nextOffset });
  steps.push({ label: 'alpha scope_only limit 1 at nextOffset', result: exact(next), formatted: formatManagedMemories(next), statements: f.statements.splice(0) });
  cases.push({ name: 'lists and TUI requests carry per-scope indices and their matching revisions (test line 94; the TUI parser is not recorded, its formatted input is)', steps });
  sql.close();
}
{
  const f = fixture();
  const { sql, db } = f;
  const writes = [];
  const toolCalls = [];
  const { handleToolCall } = createMemoryActionHandlers({
    getDb: () => db,
    dataDir: '/test-only',
    readMainConfig: () => ({}),
    refreshCoreMemoryFile: () => syncCoreMemoryIndexes(db),
    editCoreImpl: async (_dir, recordId, patch) => {
      const row = sql.prepare('SELECT * FROM core_entries WHERE id=?').get(recordId);
      toolCalls.push({ impl: 'editCoreImpl', recordId, patch: exact(patch), rowProjectId: row.project_id });
      if (row.project_id !== patch.expectedProjectId) throw new Error(`stand-in: row.project_id ${row.project_id} != expectedProjectId ${patch.expectedProjectId}`);
      writes.push(recordId);
      sql.prepare('UPDATE core_entries SET summary=?, project_id=? WHERE id=?').run(patch.summary, patch.targetProjectId, recordId);
      return sql.prepare('SELECT * FROM core_entries WHERE id=?').get(recordId);
    },
    deleteCoreImpl: async (_dir, recordId, options) => {
      const row = sql.prepare('SELECT * FROM core_entries WHERE id=?').get(recordId);
      toolCalls.push({ impl: 'deleteCoreImpl', recordId, options: exact(options), rowProjectId: row.project_id });
      if (row.project_id !== options.expectedProjectId) throw new Error(`stand-in: row.project_id ${row.project_id} != expectedProjectId ${options.expectedProjectId}`);
      writes.push(recordId);
      sql.prepare('DELETE FROM core_entries WHERE id=?').run(recordId);
      return row;
    },
  });
  const steps = [];
  const tool = async (label, args) => {
    const before = f.statements.length;
    const out = await capture(() => handleToolCall('memory', args));
    steps.push({ label, args: exact(args), ...out, writesSoFar: [...writes], statements: f.statements.slice(before), tables: f.tables() });
    return out.result;
  };
  const list = async (project_id) => {
    const r = await tool(`list ${project_id}`, { op: 'list', project_id, scope_only: true, source: 'curated', format: 'json' });
    return JSON.parse(r.content[0].text).entries;
  };
  const common = (await list('common'))[0];
  const alpha = (await list('alpha'))[0];
  await tool('edit with the old global id (common 81) is refused', { op: 'edit', project_id: 'common', id: 81, index_revision: common.index_revision, summary: 'Wrong' });
  await tool('delete alpha 1', { op: 'delete', project_id: 'alpha', id: 1, index_revision: alpha.index_revision });
  await tool('edit alpha 1 with the stale revision is refused', { op: 'edit', project_id: 'alpha', id: 1, index_revision: alpha.index_revision, summary: 'Wrong' });
  const remaining = (await list('alpha'))[0];
  await tool('move alpha 1 to beta', { op: 'edit', project_id: 'alpha', id: 1, index_revision: remaining.index_revision, target_project_id: 'beta', summary: 'Moved' });
  await list('beta');
  await list('common');
  await tool('edit without id', { op: 'edit', project_id: 'alpha', summary: 'x' });
  await tool('edit without revision', { op: 'edit', project_id: 'beta', id: 1, summary: 'x' });
  cases.push({ name: 'public mutations resolve scope and version before touching the stable record (test line 125)', steps, impls: toolCalls });
  sql.close();
}

finish(ctx, {
  url: import.meta.url,
  set: 'memory-core-index',
  flags: '--disable-warning=ExperimentalWarning ',
  golden: { domain: 'memory-core-index', source: 'src/runtime/memory/lib/core-memory-index.test.mjs', clock: { dateNowMs: CLOCK_MS, reason: 'virtual clock, never advanced' }, cases },
  extra: {
    entry: { runs: 'syncCoreMemoryIndexes, indexedCoreRecord, resolveCoreMemoryIndex (core-memory-index.mjs), listManagedMemories/formatManagedMemories (core-memory-management.mjs), createMemoryActionHandlers(...).handleToolCall("memory") (memory-action-handlers.mjs)', notRun: 'PostgreSQL (SQLite stand-in of the test file); the TUI row parser parseMemoryCoreRows; the real editCoreImpl/deleteCoreImpl (the test file\'s stand-ins write the SQLite table and are recorded by call)' },
    replay: 'mixdog-services memory: mem/core/index.rs sync/resolve, mem/core/list.rs list/format, mem/core/action.rs + store.rs edit/delete via the memory tool; compares every result (index maps, revisions, entries, formatted text, tool content + isError), the ordered statements and the tables after each step',
    exclusions: 'parseMemoryCoreRows (TUI, deleted) is not recorded; case 94 asserts it, the formatted text it parsed is recorded instead',
    normalised: { clock: 'Date.now() fixed at clock.dateNowMs' },
  },
});
process.exit(0);
