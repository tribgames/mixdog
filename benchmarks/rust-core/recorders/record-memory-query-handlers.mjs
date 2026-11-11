#!/usr/bin/env node
// Node's public recall paging and enrichment (src/runtime/memory/lib/query-handlers.integration.test.mjs, 3 cases) from
// the real `createQueryHandlers(...).handleSearch` (query-handlers.mjs). As in the test file, the hybrid candidate search
// (`searchRelevantHybrid`, memory-recall-store.mjs) is replaced at its module boundary by the scripted `db.search`, and
// `db.query` answers the browse statement ("WITH eligible AS") from the scripted rows; every search options object and
// every statement the handler sends is recorded in order. Date.now() is a fixed virtual clock (row timestamps derive
// from it) and the run is in UTC (the rendered text carries local time).
//
//   node --experimental-test-module-mocks benchmarks/rust-core/recorders/record-memory-query-handlers.mjs --tree <dir>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';
import { begin, capture, finish, freezeClock, importFrom, plain } from './lib/mc-record.mjs';

const ctx = begin();
const CLOCK_MS = Date.parse('2025-06-01T00:00:00Z');
freezeClock(CLOCK_MS);
const lib = (rel) => pathToFileURL(join(ctx.tree, 'src/runtime/memory/lib', rel)).href;
const store = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory-recall-store.mjs');
mock.module(lib('./memory-recall-store.mjs'), { namedExports: { ...store, searchRelevantHybrid: (db, query, options) => db.search(query, options) } });
const { createQueryHandlers } = await importFrom(ctx.tree, 'src/runtime/memory/lib/query-handlers.mjs');

function fixture(count = 600) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: i + 1, ts: Date.now() - i * 1000, is_root: 1, chunk_root: i + 1, role: 'user', project_id: null, session_id: 'test-session',
    category: 'fact', status: 'pending', element: `item-${i + 1}`,
    summary: `MARKER_${String(i + 1).padStart(4, '0')} needle`, content: `MARKER_${String(i + 1).padStart(4, '0')} needle`,
    duplicate_of: null, retrievalScore: 1, rrf: 1, _retrievalEvidence: 'lexical',
  }));
  const log = { searches: [], statements: [] };
  const db = {
    rows,
    async search(_query, options) {
      log.searches.push({ query: _query, options: plain(options) });
      return this.rows.slice(0, options.limit).map((row) => ({ ...row }));
    },
    async query(sql, args = []) {
      log.statements.push({ sql, params: plain(args) });
      if (sql.includes('WITH eligible AS')) {
        const ids = new Set(this.rows.map((row) => row.id));
        return { rows: this.rows.filter((row) => row.duplicate_of == null || !ids.has(row.duplicate_of)).slice(Number(args.at(-1)), Number(args.at(-1)) + Number(args.at(-2))).map((row) => ({ ...row })) };
      }
      return { rows: [] };
    },
    transaction: (run) => run(db),
  };
  const handlers = createQueryHandlers({ getDb: () => db, log: () => {}, resolveProjectScope: () => null, embeddingOnDemandCanStart: () => false, getTraceDb: () => null });
  return { db, log, ...handlers };
}

async function search(f, args) {
  const searches = f.log.searches.length;
  const statements = f.log.statements.length;
  return { args, ...(await capture(() => f.handleSearch(args))), searches: f.log.searches.slice(searches), statements: f.log.statements.slice(statements) };
}

const pageSteps = [];
{
  const f = fixture();
  for (const query of ['needle', '']) {
    for (const offset of [0, 99, 100, 499, 500]) {
      for (const limit of [1, 10, 100]) pageSteps.push(await search(f, { query, projectScope: 'all', offset, limit }));
    }
  }
  // Further boundary calls: beyond the last offset and over the caps.
  for (const args of [{ query: 'needle', projectScope: 'all', offset: 600, limit: 10 }, { query: 'needle', projectScope: 'all', offset: 0, limit: 101 }, { query: '', projectScope: 'all', offset: 501, limit: 1 }, { query: 'needle', projectScope: 'all', limit: 0 }]) {
    pageSteps.push(await search(f, args));
  }
}

const window = { query: 'needle', period: '2024-01-01~2024-01-31', projectScope: 'all', limit: 10 };
const aliasCase = await (async () => {
  const f = fixture(2);
  const ts = Date.parse('2024-01-15T00:00:00Z');
  Object.assign(f.db.rows[0], { ts, summary: 'LEGACY_ALIAS needle', content: 'LEGACY_ALIAS needle', duplicate_of: 2 });
  Object.assign(f.db.rows[1], { ts: ts + 1, summary: 'CANONICAL_RECORD needle', content: 'CANONICAL_RECORD needle' });
  f.db.search = async (_query, options) => { f.log.searches.push({ query: _query, options: plain(options) }); return [{ ...f.db.rows[options.rootOnly ? 1 : 0] }]; };
  return { rows: structuredClone(f.db.rows), step: await search(f, window) };
})();
const timeCase = await (async () => {
  const f = fixture(2);
  Object.assign(f.db.rows[0], { ts: Date.parse('2024-01-15T00:00:00Z'), summary: 'IN_WINDOW needle', content: 'IN_WINDOW needle', duplicate_of: 2 });
  Object.assign(f.db.rows[1], { ts: Date.parse('2025-01-15T00:00:00Z'), summary: 'OUT_OF_WINDOW needle', content: 'OUT_OF_WINDOW needle' });
  f.db.search = async (_query, options) => { f.log.searches.push({ query: _query, options: plain(options) }); return [{ ...f.db.rows[options.rootOnly ? 1 : 0] }]; };
  return { rows: structuredClone(f.db.rows), step: await search(f, window) };
})();

finish(ctx, {
  url: import.meta.url,
  set: 'memory-query-handlers',
  flags: '--experimental-test-module-mocks ',
  golden: {
    domain: 'memory-query-handlers',
    source: 'src/runtime/memory/lib/query-handlers.integration.test.mjs',
    clock: { dateNowMs: CLOCK_MS, reason: 'row timestamps are Date.now() - i * 1000' },
    cases: [
      { name: 'public recall preserves every supported page boundary, including the last offset', rows: 600, steps: pageSteps },
      { name: 'public historical enrichment cannot reintroduce an alias beside its representative', ...aliasCase },
      { name: 'public enrichment filters time before duplicate grouping', ...timeCase },
    ],
  },
  extra: {
    entry: { runs: 'createQueryHandlers(...).handleSearch (query-handlers.mjs) with its real planning, paging, enrichment, duplicate collapse and rendering (query-search-plan, query-ranking, history-duplicates, recall-format)', notRun: 'PostgreSQL and the hybrid retrieval: searchRelevantHybrid is replaced by db.search at the module boundary (as the test file does), and db.query answers only the browse statement from the scripted rows' },
    replay: 'mixdog-services memory: mem/recall search (plan.rs caps 100/500 and page_bounds, retrieve_candidates limit, expand_and_bound, page_rows) over a candidate seam that returns the scripted rows; compares the rendered text (whole, error flag included), the search options handed to the seam (limit, offset, rootOnly, period bounds) and the browse statements in order',
    exclusions: 'none: the whole text of every call is stored (several MB for the 100-row pages)',
    normalised: { 'row timestamps': 'Date.now() fixed at clock.dateNowMs; text rendered in UTC' },
  },
});
process.exit(0);
