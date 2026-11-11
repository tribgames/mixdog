#!/usr/bin/env node
// Node's recall source rendering (src/runtime/memory/lib/recall-source.test.mjs): all six cases (ID recall bodies 72, member /
// session expansion 79, RAW opt-in 90, out-of-period root 100, grouped layouts 111, body bound and compact projection 120) from the real
// `createQueryHandlers(...).handleSearch` (query-handlers.mjs), `renderEntryLines`, `renderSessionGroupedLines`
// (recall-format.mjs) and `compactHandoffRows` (compact-handoff.mjs). As in the test file the hybrid search is replaced at its module boundary by the scripted `db.search`, and
// `db.query` answers by SQL text from the three scripted rows; search options and statements are recorded in order.
// Virtual clock: Date.now() is fixed; the run is in UTC.
//
//   node --experimental-test-module-mocks benchmarks/rust-core/recorders/record-memory-recall-source.mjs --tree <dir>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';
import { begin, capture, finish, freezeClock, importFrom, exact } from './lib/mc-record.mjs';

const ctx = begin();
const CLOCK_MS = Date.parse('2025-06-01T00:00:00Z');
freezeClock(CLOCK_MS);
const lib = (rel) => pathToFileURL(join(ctx.tree, 'src/runtime/memory/lib', rel)).href;
const { renderEntryLines, renderSessionGroupedLines } = await importFrom(ctx.tree, 'src/runtime/memory/lib/recall-format.mjs');
const { compactHandoffRows } = await importFrom(ctx.tree, 'src/runtime/memory/lib/compact-handoff.mjs');
mock.module(lib('./memory-recall-store.mjs'), { namedExports: { searchRelevantHybrid: (db, query, options) => db.search(query, options) } });
const { createQueryHandlers } = await importFrom(ctx.tree, 'src/runtime/memory/lib/query-handlers.mjs');

const body = (label) => `\`\`\`js\nconst ${label} = 7319;\n\`\`\`\nhttps://example.com/${label}\n| ${label} | required |`;
const root = { id: 1, ts: Date.now() - 2000, role: 'user', is_root: 1, chunk_root: 1, session_id: 'source-session', element: 'decision', summary: 'Compact summary only.', content: body('ROOT_SOURCE') };
const member = { id: 2, ts: root.ts + 1, role: 'assistant', is_root: 0, chunk_root: 1, session_id: root.session_id, content: body('MEMBER_SOURCE') };
const raw = { id: 3, ts: root.ts + 2, role: 'user', is_root: 0, chunk_root: null, session_id: root.session_id, content: body('RAW_SOURCE') };

function handlers(rows = [root, member, raw]) {
  const [rootRow, memberRow, rawRow] = rows;
  const log = { searches: [], statements: [] };
  const db = {
    async search(query, options) {
      log.searches.push({ query, options: exact(options) });
      return [{ ...rootRow, ...(options.includeMembers ? { members: [{ ...memberRow }] } : {}) }, { ...rawRow }];
    },
    async query(sql, params = []) {
      log.statements.push({ sql, params: exact(params) });
      if (sql.includes('FROM entries WHERE id = ANY')) return { rows: rows.filter((row) => params[0].includes(row.id)).map((row) => ({ ...row })) };
      if (sql.includes('WHERE chunk_root = ANY')) {
        const selected = sql.includes('is_root = 0') ? [memberRow] : [rootRow, memberRow];
        return { rows: selected.map((row) => ({ ...row })) };
      }
      if (sql.includes('id <> ALL')) return { rows: [] };
      if (sql.includes('WHERE session_id = $1')) return { rows: [{ ...rootRow }, { ...rawRow }] };
      return { rows: [] };
    },
    transaction: (run) => run(db),
  };
  const h = createQueryHandlers({ getDb: () => db, log: () => {}, resolveProjectScope: () => 'all', embeddingOnDemandCanStart: () => false, getTraceDb: () => null });
  return { ...h, log };
}
const search = async (h, args) => ({ args, ...(await capture(() => h.handleSearch(args))), searches: h.log.searches.splice(0), statements: h.log.statements.splice(0) });
const rowsOf = (rows) => rows.map((r) => ({ ...r }));

const expansion = [];
for (const args of [{ query: 'source evidence', period: 'all', includeMembers: true }, { sessionId: root.session_id, includeMembers: true }, { sessionId: root.session_id }, { query: 'source evidence', period: 'all' }, { id: [2] }]) {
  expansion.push(await search(handlers(), args));
}
const oldRoot = { ...root, ts: Date.now() - 2 * 60 * 60 * 1000 };
// Cases 72 and 90 (previously listed as covered by recall goldens of the Rust side: those are not recordings of this tree).
const idRecall = [await search(handlers(), { id: [1, 2, 3] })];
const rawOptIn = [];
const rawHandlers = handlers();
rawOptIn.push(await search(rawHandlers, { query: 'source evidence', period: 'all' }));
rawOptIn.push(await search(rawHandlers, { query: 'source evidence', period: 'all', includeRaw: true }));
const period = [];
for (const [label, rows, args] of [
  ['in-window member hit, root 2 h old, period 30m (the test)', [oldRoot, member, raw], { query: 'source evidence', period: '30m', includeMembers: true }],
  ['same without includeMembers', [oldRoot, member, raw], { query: 'source evidence', period: '30m' }],
  ['period wide enough for the root', [oldRoot, member, raw], { query: 'source evidence', period: '3h', includeMembers: true }],
]) period.push({ label, rows: rowsOf(rows), ...(await search(handlers(rows), args)) });

const layouts = [];
for (const rows of [[raw], [raw, { ...raw, id: 4, session_id: 'other-session' }]]) {
  for (const spanHeaders of [false, true]) {
    for (const preserveSource of [true, false]) {
      layouts.push({ rows: rowsOf(rows), options: { spanHeaders, preserveSource }, ...(await capture(() => renderSessionGroupedLines(rows, { spanHeaders, preserveSource }))) });
    }
  }
}
layouts.push({ rows: rowsOf([root, member, raw]), options: { spanHeaders: true, preserveSource: true }, ...(await capture(() => renderSessionGroupedLines([root, member, raw], { spanHeaders: true, preserveSource: true }))) });
layouts.push({ rows: [], options: {}, ...(await capture(() => renderSessionGroupedLines([], {}))) });

const large = { ...raw, content: `${'x'.repeat(8000)}AFTER_BODY_BOUND` };
const bound = [];
const render = async (label, rows, options) => bound.push({ label, rows: rowsOf(rows), options, ...(await capture(() => renderEntryLines(rows, options))) });
await render('large raw body, preserveSource (bound applies)', [large], { preserveSource: true });
await render('compact-body root renders its summary', [{ ...root, _compactBody: true }]);
await render('compact handoff of a large raw row, no bound', compactHandoffRows([large]), { maxBodyChars: null });
await render('compact handoff of a raw row', compactHandoffRows([raw]));
await render('large raw body, default options', [large]);
await render('large raw body, maxBodyChars 100', [large], { maxBodyChars: 100 });
await render('root, member and raw rows, preserveSource', [root, member, raw], { preserveSource: true });

finish(ctx, {
  url: import.meta.url,
  set: 'memory-recall-source',
  flags: '--experimental-test-module-mocks ',
  golden: {
    domain: 'memory-recall-source',
    source: 'src/runtime/memory/lib/recall-source.test.mjs',
    clock: { dateNowMs: CLOCK_MS, reason: 'row timestamps derive from Date.now()' },
    rows: { root, member, raw },
    cases: [
      { name: 'ID recall preserves original root, member and RAW bodies without duplicating named members (test line 72)', searches: idRecall },
      { name: 'explicit member search and session expansion keep code, URLs and tables (test line 79)', searches: expansion },
      { name: 'RAW opt-in preserves raw text while the ordinary root result stays a summary (test line 90)', searches: rawOptIn },
      { name: 'an in-window member hit cannot reintroduce the original root body from outside the requested period (test line 100)', searches: period },
      { name: 'grouped source rendering carries explicit options through flat, multi-session and span layouts (test line 111)', layouts },
      { name: 'source opt-in keeps the body bound and does not change Compact summary/RAW projection (test line 120)', renders: bound },
    ],
  },
  extra: {
    entry: { runs: 'createQueryHandlers(...).handleSearch (query-handlers.mjs), renderEntryLines and renderSessionGroupedLines (recall-format.mjs), compactHandoffRows (compact-handoff.mjs)', notRun: 'PostgreSQL and hybrid retrieval: searchRelevantHybrid is replaced by db.search at the module boundary and db.query answers by SQL text (as the test file does)' },
    replay: "mixdog-services memory/recall/format.rs: pub fn render_entry_lines (:220); reached by the `memory/recall` request (Recall::recall, recall/mod.rs:240). A replay renders each recorded row set with the recorded options and compares the text exactly",
    exclusions: 'none: all six cases of the file are recorded',
    normalised: { 'row timestamps': 'Date.now() fixed at clock.dateNowMs; rendered text in UTC' },
  },
});
process.exit(0);
