#!/usr/bin/env node
// Node's recall history duplicates (src/runtime/memory/lib/history-duplicates.test.mjs, 8 cases) from the real
// `retrieveEntries` (memory-retrievers.mjs), `searchRelevantHybrid` / `preferLatestConceptRows` (memory-recall-store.mjs),
// `collapseHistoryDuplicates`, `buildRecallScopeFilter`, `assessChunkQuality`/`makeChunkQuality`. The database is the test
// file's own stand-in: an in-memory SQLite (node:sqlite) holding the `entries` fixture behind a `db.query` that
// translates the PG statements the handlers send and answers the hybrid candidate query with every root row
// ("The isolated PostgreSQL suite covers actual vector/FTS candidate SQL"). Every statement the handlers send is recorded
// (text and params, in order) with the ids/rows each call returned and the table before and after.
//
//   node --disable-warning=ExperimentalWarning benchmarks/rust-core/recorders/record-memory-history-duplicates.mjs --tree <dir>
import { DatabaseSync } from 'node:sqlite';
import { begin, capture, finish, freezeClock, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const CLOCK_MS = 1_700_000_000_000;
freezeClock(CLOCK_MS); // makeChunkQuality stamps verifiedAt
const dir = 'src/runtime/memory/lib/';
const { buildRecallScopeFilter } = await importFrom(ctx.tree, `${dir}memory-recall-scope-filter.mjs`);
const { retrieveEntries } = await importFrom(ctx.tree, `${dir}memory-retrievers.mjs`);
const { makeChunkQuality, assessChunkQuality } = await importFrom(ctx.tree, `${dir}memory-chunk-quality.mjs`);
const { collapseHistoryDuplicates } = await importFrom(ctx.tree, `${dir}history-duplicates.mjs`);
const { searchRelevantHybrid, preferLatestConceptRows } = await importFrom(ctx.tree, `${dir}memory-recall-store.mjs`);

// The test file's fixture, unchanged except that statements are logged.
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const statements = [];
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY, ts INTEGER, project_id TEXT, summary TEXT, content TEXT, element TEXT,
      is_root INTEGER, chunk_root INTEGER, status TEXT,
      concept_id INTEGER, supersedes_id INTEGER,
      role TEXT, source_ref TEXT, session_id TEXT, source_turn INTEGER, time_source TEXT,
      category TEXT, score REAL, last_seen_at INTEGER,
      duplicate_of INTEGER REFERENCES entries(id) ON DELETE SET NULL, chunk_quality TEXT
    );
    INSERT INTO entries(id,ts,project_id,summary,content,element,is_root,chunk_root,status,duplicate_of) VALUES
      (1,100,'project','Original summary','Original request','subject',1,1,'archived',NULL),
      (2,200,'project','Current summary','Current response','subject',1,2,'pending',NULL),
      (3,110,'project',NULL,'Original follow-up',NULL,0,1,'pending',NULL),
      (4,300,'other','Other project','Private request','subject',1,4,'active',NULL);
    UPDATE entries SET duplicate_of=2 WHERE id=1;
  `);
  const db = {
    async query(sql, args = []) {
      statements.push({ sql, params: args });
      if (sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('combined AS (')) {
        return { rows: sqlite.prepare('SELECT * FROM entries WHERE is_root=1 ORDER BY id').all().map((row, index) => ({ ...row, sparse_rank: index + 1, sparse_lex: 1 })) };
      }
      const params = {};
      let translated = sql.replace(/(\w+) = ANY\(\$(\d+)::bigint\[\]\)/g, (_all, column, number) => {
        const names = args[Number(number) - 1].map((value, i) => { const name = `a${number}_${i}`; params[name] = value; return `:${name}`; });
        return `${column} IN (${names.join(', ')})`;
      });
      translated = translated.replace(/::(?:text|boolean|jsonb|bigint)/g, '').replace(/\$(\d+)/g, (_all, number) => { params[`p${number}`] = args[Number(number) - 1]; return `:p${number}`; });
      return { rows: sqlite.prepare(translated).all(params) };
    },
    async transaction(run) {
      sqlite.exec('BEGIN');
      try { const result = await run(db); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, db, statements, rows: () => sqlite.prepare('SELECT * FROM entries ORDER BY id').all().map((r) => ({ ...r })) };
}

const ids = (rows) => rows.map((row) => row.id);
// One step: the call, what it returned (ids, or the whole value) and the statements it sent.
async function step(f, label, fn, project = (rows) => ({ rows, ids: ids(rows) })) {
  const before = f.statements.length;
  const out = await capture(async () => project(await fn()));
  return { label, ...out, statements: f.statements.slice(before) };
}
const initial = () => fixture();

const cases = [];
{
  const f = initial();
  const before = f.rows();
  const filter = buildRecallScopeFilter(1, { projectScope: 'project' });
  const matches = await f.db.query(`SELECT id FROM entries WHERE 1=1 ${filter.clause} ORDER BY id`, filter.params);
  const steps = [
    { label: 'scope filter selects every status of the project', filter, rows: matches.rows, ids: ids(matches.rows) },
    await step(f, 'retrieveEntries project, sort date', () => retrieveEntries(f.db, { projectScope: 'project', sort: 'date' })),
  ];
  cases.push({ name: 'records of every status are searchable and stored aliases stay read-only (test line 76)', before, steps, after: f.rows() });
}
for (const secondSession of ['session-a', 'session-b']) {
  const f = initial();
  f.sqlite.prepare('UPDATE entries SET session_id=?,role=?,content=? WHERE id IN (1,3)').run('session-a', 'user', 'The original request and its exact conditions. '.repeat(20));
  f.sqlite.prepare('UPDATE entries SET session_id=?,role=?,content=? WHERE id=2').run(secondSession, 'assistant', 'The same request remains pending, with its conditions. '.repeat(20));
  const assessments = [];
  for (const id of [1, 2]) {
    const root = f.rows().find((row) => row.id === id);
    const members = f.rows().filter((row) => row.chunk_root === id);
    root.chunk_quality = makeChunkQuality(root.summary, members);
    assessments.push({ root: id, memberIds: ids(members), ...(await capture(() => assessChunkQuality(root, members))) });
  }
  cases.push({ name: `stored aliases keep Cycle 1 summaries reusable (${secondSession}) (test line 115)`, secondSession, assessments, chunkRoots: f.rows().map((row) => row.chunk_root) });
}
{
  const f = initial();
  const common = { projectScope: 'project', sort: 'date' };
  const steps = [
    await step(f, 'retrieveEntries common', () => retrieveEntries(f.db, common)),
    await step(f, 'retrieveEntries ts_to 150', () => retrieveEntries(f.db, { ...common, ts_to: 150 })),
  ];
  const [old, current] = f.rows();
  steps.push({ label: 'old row content unchanged', content: f.sqlite.prepare('SELECT content FROM entries WHERE id=1').get().content });
  steps.push({ label: 'collapse [old, current]', rows: collapseHistoryDuplicates([old, current]), ids: ids(collapseHistoryDuplicates([old, current])) });
  steps.push({ label: 'collapse [old]', rows: collapseHistoryDuplicates([old]), ids: ids(collapseHistoryDuplicates([old])) });
  steps.push({ label: 'collapse [old, current in another project]', rows: collapseHistoryDuplicates([old, { ...current, project_id: 'other' }]), ids: ids(collapseHistoryDuplicates([old, { ...current, project_id: 'other' }])) });
  steps.push(await step(f, 'searchRelevantHybrid "request"', () => searchRelevantHybrid(f.db, 'request', common)));
  steps.push(await step(f, 'searchRelevantHybrid "request" ts_to 150', () => searchRelevantHybrid(f.db, 'request', { ...common, ts_to: 150 })));
  cases.push({ name: 'duplicate representatives collapse only inside the requested history window and project (test line 150)', steps });
}
{
  const f = initial();
  f.sqlite.exec('DELETE FROM entries WHERE id=2');
  const rows = f.rows();
  const steps = [
    { label: 'after deleting the representative', duplicateOfOfRow1: rows[0].duplicate_of, chunkRoots: rows.map((row) => row.chunk_root) },
    await step(f, 'retrieveEntries project, sort date', () => retrieveEntries(f.db, { projectScope: 'project', sort: 'date' })),
  ];
  cases.push({ name: 'deleting an old alias representative preserves the original chunks (test line 164)', steps });
}
{
  const f = initial();
  f.sqlite.exec('UPDATE entries SET score=5-id');
  const original = f.rows();
  const scope = { projectScope: 'all' };
  const steps = [
    await step(f, 'hybrid limit 2', () => searchRelevantHybrid(f.db, 'request', { ...scope, limit: 2 })),
    await step(f, 'hybrid limit 1', () => searchRelevantHybrid(f.db, 'request', { ...scope, limit: 1 })),
    await step(f, 'retrieveEntries limit 2', () => retrieveEntries(f.db, { ...scope, limit: 2 })),
  ];
  for (let offset = 0; offset < 3; offset++) steps.push(await step(f, `retrieveEntries limit 1 offset ${offset}`, () => retrieveEntries(f.db, { ...scope, limit: 1, offset })));
  cases.push({ name: 'duplicates do not consume hybrid output slots or browse-page offsets (test line 189)', steps, rowsUnchanged: JSON.stringify(f.rows()) === JSON.stringify(original) });
}
{
  const f = initial();
  f.sqlite.exec('UPDATE entries SET score=5-id');
  const insert = f.sqlite.prepare(`INSERT INTO entries(id,ts,project_id,summary,content,is_root,chunk_root,duplicate_of,score) VALUES (?,50,'project','Same account','Original duplicate source',1,?,2,100)`);
  for (let id = 5; id <= 30; id++) insert.run(id, id);
  const scope = { projectScope: 'all', limit: 2 };
  const steps = [
    await step(f, 'retrieveEntries limit 2', () => retrieveEntries(f.db, scope)),
    await step(f, 'retrieveEntries limit 2 offset 2', () => retrieveEntries(f.db, { ...scope, offset: 2 })),
    await step(f, 'hybrid limit 2', () => searchRelevantHybrid(f.db, 'request', scope)),
  ];
  cases.push({ name: 'a long duplicate prefix cannot starve distinct results or repeat later pages (test line 208)', insertedAliasIds: '5..30 (duplicate_of 2, ts 50, score 100)', steps });
}
{
  const f = initial();
  f.sqlite.exec(`UPDATE entries SET session_id='older' WHERE id IN (1,3); UPDATE entries SET session_id='newer' WHERE id=2`);
  const scope = { projectScope: 'project', limit: 1, session_id: 'older' };
  const steps = [
    await step(f, 'retrieveEntries session older limit 1', () => retrieveEntries(f.db, scope)),
    await step(f, 'retrieveEntries session older limit 1 offset 1', () => retrieveEntries(f.db, { ...scope, offset: 1 })),
  ];
  cases.push({ name: 'paging keeps an alias whose representative is outside the requested session (test line 220)', steps });
}
{
  const f = initial();
  f.sqlite.exec(`INSERT INTO entries(id,ts,project_id,content,is_root,chunk_root) VALUES (5,210,'project','Full selected-member source',0,2)`);
  const expanded = [];
  const query = f.db.query;
  f.db.query = async (sql, args = []) => { if (sql.includes('WHERE chunk_root = ANY')) expanded.push(args[0]); return query(sql, args); };
  const steps = [await step(f, 'hybrid limit 1 includeMembers', () => searchRelevantHybrid(f.db, 'request', { projectScope: 'all', limit: 1, includeMembers: true }), (rows) => ({ rows, ids: ids(rows), memberContents: rows[0].members.map((row) => row.content) }))];
  cases.push({ name: 'hybrid member expansion reads only selected distinct roots (test line 242)', steps, expandedRootLists: expanded });
}
{
  const old = { id: 1, ts: 100, concept_ids: [1], summary: 'Old conclusion' };
  const latest = { id: 2, ts: 200, matched_concept_id: 1, supersedes_id: 1, summary: 'Correction' };
  cases.push({
    name: 'previously stored lineage still selects the newer conclusion without a reviewer (test line 256)',
    probes: [
      { label: 'old with its correction', old, latest, ...(await capture(() => preferLatestConceptRows([old], [latest]))) },
      { label: 'old with no correction', ...(await capture(() => preferLatestConceptRows([old], []))) },
    ],
    oldUnchanged: JSON.stringify(old) === JSON.stringify({ id: 1, ts: 100, concept_ids: [1], summary: 'Old conclusion' }),
  });
}

finish(ctx, {
  url: import.meta.url,
  set: 'memory-history-duplicates',
  flags: '--disable-warning=ExperimentalWarning ',
  golden: { domain: 'memory-history-duplicates', source: 'src/runtime/memory/lib/history-duplicates.test.mjs', clock: { dateNowMs: CLOCK_MS, reason: 'verifiedAt of chunk_quality' }, cases },
  extra: {
    entry: { runs: 'retrieveEntries (memory-retrievers.mjs), searchRelevantHybrid and preferLatestConceptRows (memory-recall-store.mjs), collapseHistoryDuplicates, buildRecallScopeFilter, makeChunkQuality/assessChunkQuality', notRun: 'PostgreSQL: db.query is the test file\'s SQLite stand-in (it translates ANY($n::bigint[]) and casts, and answers the hybrid candidate CTE with every root row); candidate retrieval SQL is replayed by the recall goldens' },
    replay: "mixdog-services memory/recall/ranking.rs: pub fn collapse_history_duplicates (:414); memory/recall/browse.rs: pub async fn recall_session_rows (:696) and recall_core_rows (:860); all reached by the `memory/recall` request (Recall::recall, recall/mod.rs:240). A replay runs the same entries table through those calls and compares the returned rows whole, in order, with the statements sent",
    exclusions: 'the statements are those of Node\'s SQL; the golden records them for the replay author but the SQLite translation is the test\'s own',
    normalised: { verifiedAt: 'Date.now() fixed at clock.dateNowMs (virtual clock)' },
  },
});
process.exit(0);
