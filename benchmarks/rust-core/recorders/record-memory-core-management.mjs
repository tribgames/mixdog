#!/usr/bin/env node
// Node's curated core-memory listing (src/runtime/memory/lib/core-memory-management.test.mjs, 1 case "standing memory
// lists curated records by scope, page and activity") from the real `listManagedMemories` / `formatManagedMemories`
// (core-memory-management.mjs) and the public `core` list action (`createMemoryActionHandlers(...).handleMemoryAction`,
// memory-action-handlers.mjs) over real project directories (`.mixdog/project.id`). The database is the test file's own
// stand-in: in-memory SQLite (node:sqlite) with `core_entries` and `meta` behind `db.query` (PG casts dropped, $n named,
// pg_advisory_xact_lock answered with no rows and counted). Every statement is recorded (text, params, in order). The
// TUI row parser the test also calls (`parseMemoryCoreRows`) is not recorded: the TUI is deleted; the formatted text it
// parsed is recorded. Temp project paths are written as <root>/<name>.
//
//   node --disable-warning=ExperimentalWarning benchmarks/rust-core/recorders/record-memory-core-management.mjs --tree <dir>
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { begin, capture, finish, freezeClock, importFrom, exact } from './lib/mc-record.mjs';

const ctx = begin();
const CLOCK_MS = 1_800_000_000_000;
freezeClock(CLOCK_MS);
const dir = 'src/runtime/memory/lib/';
const { listManagedMemories, formatManagedMemories } = await importFrom(ctx.tree, `${dir}core-memory-management.mjs`);
const { parseMemoryCoreRows } = await importFrom(ctx.tree, 'src/tui/app/input-parsers.mjs');
// The property the deleted TUI parser proved: the ids, scope, summary and index revision of every entry come back out of the
// formatted text. Recorded as format -> parse -> the whole parsed rows, plus the comparison with the listed entries.
const roundTrip = (formatted, entries) => {
  const parsed = parseMemoryCoreRows(formatted);
  return { parsed: exact(parsed), perEntry: entries.map((entry, i) => ({ id: parsed[i]?._id === entry.id, projectId: parsed[i]?._projectId === (entry.project_id ?? null), summary: parsed[i]?._summary === entry.summary, indexRevision: parsed[i]?._indexRevision === (entry.index_revision === undefined ? undefined : String(entry.index_revision)), listed: { id: entry.id, project_id: entry.project_id ?? null, summary: entry.summary, index_revision: entry.index_revision ?? null } })), rowCount: { parsed: parsed.length, listed: entries.length } };
};
const { createMemoryActionHandlers } = await importFrom(ctx.tree, `${dir}memory-action-handlers.mjs`);

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-project-memory-')));
const projectPaths = ['renamed-folder', 'other-folder', 'empty-folder'].map((name) => join(root, name));
for (const [index, projectId] of ['mixdog', 'other', 'empty'].entries()) {
  mkdirSync(join(projectPaths[index], '.mixdog'), { recursive: true });
  writeFileSync(join(projectPaths[index], '.mixdog', 'project.id'), projectId);
}
const scrub = (value) => {
  const text = JSON.stringify(value);
  const forms = [root, root.replaceAll('\\', '\\\\'), root.replaceAll('\\', '\\\\\\\\'), root.replaceAll('\\', '/')];
  return JSON.parse(forms.reduce((acc, form) => acc.split(form).join('<root>'), text));
};

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`
  CREATE TABLE core_entries (id INTEGER, project_id TEXT, element TEXT, summary TEXT, status TEXT, agent_id TEXT);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO core_entries(id, project_id, element, summary, status) VALUES
    (1, 'mixdog', 'Archived', 'Old rule', 'archived'),
    (2, NULL, 'Common', 'Common preference', NULL),
    (3, 'mixdog', 'Active', 'Project preference', 'active'),
    (4, 'other', 'Other', 'Other preference', 'active');
`);
const statements = [];
let indexReads = 0;
const db = {
  query: async (sql, args = []) => {
    statements.push({ sql, params: exact(args) });
    if (sql.includes('pg_advisory_xact_lock')) { indexReads++; return { rows: [] }; }
    const statement = sqlite.prepare(sql.replace(/::(?:text|boolean|jsonb)/g, '').replace(/\$(\d+)/g, ':p$1'));
    return { rows: statement.all(Object.fromEntries(args.map((value, i) => [`p${i + 1}`, typeof value === 'boolean' ? Number(value) : value]))) };
  },
  transaction: async (run) => {
    sqlite.exec('BEGIN');
    try { const result = await run(db); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};

const steps = [];
const step = async (label, args, fn, extra = () => ({})) => {
  const before = statements.length;
  indexReads = 0;
  const out = await capture(fn);
  steps.push({ label, args: scrub(exact(args)), ...scrub(out), ...extra(out), indexReads, statements: statements.slice(before) });
  return out;
};
const list = (label, scope, options) => step(label, { scope, options }, () => listManagedMemories(db, scope, options), (out) => (out.result ? { formatted: formatManagedMemories(out.result), roundTrip: roundTrip(formatManagedMemories(out.result), out.result.entries) } : {}));

const first = await list("'mixdog' limit 1", 'mixdog', { limit: 1 });
await list("'mixdog' limit 1 at nextOffset", 'mixdog', { limit: 1, offset: first.result.nextOffset });
await list("'mixdog' include_inactive", 'mixdog', { include_inactive: true });
await list("'mixdog' scope_only", 'mixdog', { scope_only: true });
const { handleMemoryAction } = createMemoryActionHandlers({ getDb: () => db, dataDir: root, readMainConfig: () => ({}) });
const action = { action: 'core', op: 'list', project_id: '*', project_paths: projectPaths, format: 'json', limit: 100 };
await step("core list '*' with three project paths (JSON)", action, () => handleMemoryAction(action));
for (const project_paths of ['not-an-array', [null], ['']]) await list(`'*' project_paths ${JSON.stringify(project_paths)}`, '*', { project_paths });
await list("'mixdog' with project_paths (not an all-project list)", 'mixdog', { project_paths: projectPaths });
await list("'*' include_inactive 'false'", '*', { include_inactive: 'false' });
// Further shapes: the text form of the core list, other scopes, offsets past the end.
await list("'*' default options", '*', {});
await list("'common' scope", 'common', {});
await list("'other' limit 1 offset 5", 'other', { limit: 1, offset: 5 });
const textAction = { action: 'core', op: 'list', project_id: 'mixdog', project_paths: [projectPaths[0]] };
await step("core list 'mixdog' with one project path (text)", textAction, () => handleMemoryAction(textAction));
sqlite.close();
rmSync(root, { recursive: true, force: true });

finish(ctx, {
  url: import.meta.url,
  set: 'memory-core-management',
  flags: '--disable-warning=ExperimentalWarning ',
  golden: {
    domain: 'memory-core-management',
    source: 'src/runtime/memory/lib/core-memory-management.test.mjs',
    clock: { dateNowMs: CLOCK_MS, reason: 'virtual clock, never advanced' },
    projectFolders: [{ folder: 'renamed-folder', projectId: 'mixdog' }, { folder: 'other-folder', projectId: 'other' }, { folder: 'empty-folder', projectId: 'empty' }],
    table: [{ id: 1, project_id: 'mixdog', element: 'Archived', summary: 'Old rule', status: 'archived' }, { id: 2, project_id: null, element: 'Common', summary: 'Common preference', status: null }, { id: 3, project_id: 'mixdog', element: 'Active', summary: 'Project preference', status: 'active' }, { id: 4, project_id: 'other', element: 'Other', summary: 'Other preference', status: 'active' }],
    cases: [{ name: 'standing memory lists curated records by scope, page and activity (test line 11; the steps after the first eight are further shapes)', steps }],
  },
  extra: {
    entry: { runs: 'listManagedMemories and formatManagedMemories (core-memory-management.mjs); createMemoryActionHandlers(...).handleMemoryAction({action:"core", op:"list"}) (memory-action-handlers.mjs) over real .mixdog/project.id directories', notRun: 'PostgreSQL (SQLite stand-in of the test file)' },
    replay: 'mixdog-services memory: mem/core/list.rs list + format and mem/core/action.rs list with project_paths (project id from each path\'s .mixdog/project.id), over the same four rows; compares entries, nextOffset, projectScopes, formatted text, error text, the pg_advisory_xact_lock count per call (indexReads) and the ordered statements',
    exclusions: 'none: the TUI parser parseMemoryCoreRows (test line 77) is recorded as a Node round trip, `roundTrip` in every step that formats a list: the formatted text, the whole parsed rows (_id, _projectId, _summary, _element, _indexRevision, value, label, meta...) and per entry whether id, project, summary and index revision come back equal. The TUI is deleted in Rust; the Rust side proves the same property by parsing its own formatted text with whatever reads it there (the app-server list result is the structured source) and compares the same fields',
    normalised: { 'temp project root': 'every occurrence (exact, JSON-escaped, forward slashes) written as <root>; the replay creates its own folders with the stated project ids' },
  },
});
process.exit(0);
