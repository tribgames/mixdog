#!/usr/bin/env node
// Node's core-memory file (scripts/core-memory-file-test.mjs): case 18 ("refresh migrates PG rows and session reads common
// plus project scope from file") and case 57 ("atomic revision guard rejects an older snapshot") from the real
// `refreshCoreMemoryFile`, `readSessionCoreMemoryPayload`, `readCoreMemoryFile`, `writeCoreMemoryFileSnapshot`
// (core-memory-file.mjs) over a real data directory. The database is the test file's scripted `db.query` / `db.transaction`
// (it answers the core_entries and the generated-entries selects with fixed rows); every statement is recorded (text,
// params, in order), and after each step every file in the data directory (path, bytes). Case 91 (session core context
// reads the file without starting the memory runtime) is covered by mem/core/context_tests.rs
// `the_block_matches_what_node_injects` and not recorded again. Virtual clock: Date.now()/new Date() fixed.
//
//   node benchmarks/rust-core/recorders/record-memory-core-file.mjs --tree <dir>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { begin, capture, finish, freezeClock, importFrom, plain } from './lib/mc-record.mjs';

const ctx = begin();
const CLOCK_MS = 1_800_000_000_000;
freezeClock(CLOCK_MS);
const { readCoreMemoryFile, readSessionCoreMemoryPayload, refreshCoreMemoryFile, writeCoreMemoryFileSnapshot } = await importFrom(ctx.tree, 'src/runtime/memory/lib/core-memory-file.mjs');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-core-memory-')));
let n = 0;
const tempRoot = () => { const dir = join(base, `r${n++}`); mkdirSync(dir, { recursive: true }); return dir; };
const files = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: relative(dir, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  return out;
};

const cases = [];
{
  const root = tempRoot();
  const project = join(root, 'project');
  mkdirSync(join(project, '.mixdog'), { recursive: true });
  writeFileSync(join(project, '.mixdog', 'project.id'), 'alpha\n');
  const statements = [];
  const coreRows = [{ id: 1, summary: 'common rule', project_id: null, updated_at: 10 }, { id: 2, summary: 'alpha rule', project_id: 'alpha', updated_at: 20 }, { id: 3, summary: 'other rule', project_id: 'beta', updated_at: 30 }];
  const generatedRows = [{ core_summary: 'common generated', project_id: null, score: 1, last_seen_at: 10 }, { core_summary: 'alpha generated', project_id: 'alpha', score: 2, last_seen_at: 20 }, { core_summary: 'other generated', project_id: 'beta', score: 3, last_seen_at: 30 }];
  const db = { query: async (sql, params) => { statements.push({ sql, params: plain(params ?? null) }); return sql.includes('FROM core_entries') ? { rows: coreRows } : { rows: generatedRows }; } };
  db.transaction = (run) => run({ query: async (sql, params) => { statements.push({ sql, params: plain(params ?? null), inTransaction: true }); return sql.includes('FROM core_entries') ? { rows: coreRows } : { rows: [] }; } });
  const steps = [];
  const migrated = await capture(() => refreshCoreMemoryFile(db, root));
  steps.push({ label: 'refreshCoreMemoryFile(db, dataDir)', ...migrated, statements: statements.splice(0), files: files(root).filter((f) => f.path === 'core-memory.json') });
  steps.push({ label: 'readSessionCoreMemoryPayload(dataDir, project cwd with project.id alpha)', ...(await capture(() => readSessionCoreMemoryPayload(root, project))) });
  steps.push({ label: 'readSessionCoreMemoryPayload(dataDir, a cwd without project.id)', ...(await capture(() => readSessionCoreMemoryPayload(root, join(root, 'no-project')))) });
  steps.push({ label: 'readCoreMemoryFile(dataDir)', ...(await capture(() => readCoreMemoryFile(root))), generatedIsUndefined: readCoreMemoryFile(root).generated === undefined });
  steps.push({ label: 'refreshCoreMemoryFile again (same rows)', ...(await capture(() => refreshCoreMemoryFile(db, root))), statements: statements.splice(0), files: files(root).filter((f) => f.path === 'core-memory.json') });
  cases.push({ name: 'refresh migrates PG rows and session reads common plus project scope from file (test line 18)', projectId: 'alpha', coreRows, generatedRows, steps });
}
{
  const root = tempRoot();
  const steps = [];
  const write = async (label, snapshot, options) => steps.push({ label, snapshot, options: options ?? null, ...(await capture(() => writeCoreMemoryFileSnapshot(root, snapshot, options))), files: files(root) });
  await write('revision 2 snapshot "newer"', { curated: [{ id: 1, summary: 'newer', project_id: null }] }, { revision: 2 });
  await write('revision 1 snapshot "older" is rejected', { curated: [{ id: 1, summary: 'older', project_id: null }] }, { revision: 1 });
  steps.push({ label: 'readCoreMemoryFile(dataDir)', ...(await capture(() => readCoreMemoryFile(root))) });
  await write('same revision 2 again', { curated: [{ id: 1, summary: 'same revision', project_id: null }] }, { revision: 2 });
  await write('revision 3', { curated: [{ id: 1, summary: 'newest', project_id: 'alpha', agent_id: 'bot' }, { id: 2, summary: '  spaced   out  ', project_id: ' ' }, { id: 3, summary: '' }] }, { revision: 3 });
  await write('no options (unguarded write)', { curated: [{ id: 9, summary: 'unguarded' }] });
  steps.push({ label: 'readCoreMemoryFile(dataDir)', ...(await capture(() => readCoreMemoryFile(root))) });
  cases.push({ name: 'atomic revision guard rejects an older snapshot (test line 57; later steps are further shapes)', steps });
}
rmSync(base, { recursive: true, force: true });

finish(ctx, {
  url: import.meta.url,
  set: 'memory-core-file',
  golden: { domain: 'memory-core-file', source: 'scripts/core-memory-file-test.mjs', clock: { dateNowMs: CLOCK_MS, reason: 'updatedAt the file stamps' }, cases },
  extra: {
    entry: { runs: 'refreshCoreMemoryFile, writeCoreMemoryFileSnapshot, readCoreMemoryFile, readSessionCoreMemoryPayload (core-memory-file.mjs) over a real temp data directory, with the real atomic-file writer and project-id resolver', notRun: 'PostgreSQL (the test file\'s scripted db answers the two selects with fixed rows); case 91 (createCwdPlugins.loadCoreMemoryContext without the memory runtime): covered by mem/core/context_tests.rs the_block_matches_what_node_injects' },
    replay: 'mixdog-services memory: mem/core/snapshot.rs refresh / write (revision guard) / read and session_payload, over the same rows and a temp data dir; compares each result, the statements and the exact bytes of core-memory.json after each step',
    exclusions: 'case 91 is covered (mem/core/context_tests.rs) and not recorded again',
    normalised: { 'temp data dir': 'paths in the golden are relative to the data dir', clock: 'Date.now() fixed at clock.dateNowMs' },
  },
});
process.exit(0);
