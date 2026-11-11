#!/usr/bin/env node
// Node's query ranking (src/runtime/memory/lib/query-ranking.test.mjs, 5 cases) from the real query-ranking.mjs and
// `interleaveRawRows` (recall-format.mjs): the rows of the test file plus further shapes of each function (other
// historical reserves and limits, windows with no matching member, core interleave of different lengths, coverage with
// no terms).
//
//   node benchmarks/rust-core/recorders/record-memory-query-ranking.mjs --tree <dir>
import { begin, capture, finish, importFrom, plain } from './lib/mc-record.mjs';

const ctx = begin();
const q = await importFrom(ctx.tree, 'src/runtime/memory/lib/query-ranking.mjs');
const { interleaveRawRows } = await importFrom(ctx.tree, 'src/runtime/memory/lib/recall-format.mjs');
const { boundRecallRowsToTemporal, mergeHistoricalRecallRows, rankLatestRecallRows, topicTermCoverage, uniqueRowsById } = q;

const call = async (label, input, fn) => ({ label, input: plain(input), ...(await capture(fn)) });

const query = 'latest BrowserPane memory result';
const latestRows = [
  { id: 1, ts: 100, content: 'BrowserPane memory result was 420 MB', retrievalScore: 0.02 },
  { id: 2, ts: 200, content: 'BrowserPane memory result is 310 MB', retrievalScore: 0.01 },
  { id: 3, ts: 300, content: query, retrievalScore: 0.04 },
  { id: 4, ts: 400, content: 'unrelated deployment result', retrievalScore: 0.05 },
];
const latest = [
  await call('test file rows', { query, rows: latestRows }, () => rankLatestRecallRows(latestRows, query)),
  await call('another query, same rows', { query: 'BrowserPane', rows: latestRows }, () => rankLatestRecallRows(latestRows, 'BrowserPane')),
  await call('Korean query and members', { query: '최신 메모리 결과', rows: [{ id: 1, ts: 1, content: '메모리 결과 100', retrievalScore: 0.1 }, { id: 2, ts: 2, content: 'x', members: [{ content: '최신 메모리 결과 200' }], retrievalScore: 0.2 }] }, () => rankLatestRecallRows([{ id: 1, ts: 1, content: '메모리 결과 100', retrievalScore: 0.1 }, { id: 2, ts: 2, content: 'x', members: [{ content: '최신 메모리 결과 200' }], retrievalScore: 0.2 }], '최신 메모리 결과')),
  await call('empty rows', { query, rows: [] }, () => rankLatestRecallRows([], query)),
  await call('empty query', { query: '', rows: latestRows }, () => rankLatestRecallRows(latestRows, '')),
];

const primary = [{ id: 1, element: 'primary one' }, { id: 2, element: 'primary two' }, { id: 3, element: 'primary three' }];
const roots = [{ id: 1, element: 'classified one', summary: 'root summary' }, { id: 4, element: 'historical root' }];
const merge = async (label, p, r, limit, options) => call(label, { primary: p, roots: r, limit, options }, () => {
  const merged = mergeHistoricalRecallRows(p, r, limit, options);
  return merged.map((row) => ({ ...row }));
});
const historical = [
  await merge('test file rows', primary, roots, 3, { includeMatchedRootSummary: true, rootReserve: 1 }),
  await merge('no summary option', primary, roots, 3, { rootReserve: 1 }),
  await merge('reserve 0', primary, roots, 3, { includeMatchedRootSummary: true, rootReserve: 0 }),
  await merge('reserve 2, limit 4', primary, [...roots, { id: 5, element: 'second root' }], 4, { includeMatchedRootSummary: true, rootReserve: 2 }),
  await merge('limit 1', primary, roots, 1, { rootReserve: 1 }),
  await merge('no roots', primary, [], 3, { rootReserve: 1 }),
  await merge('no primary', [], roots, 3, { rootReserve: 1 }),
  await merge('no options', primary, roots, 3, undefined),
];

const windowRows = [{ id: 10, ts: 50, members: [{ id: 11, ts: 150 }, { id: 12, ts: 250 }] }];
const bound = [
  await call('test file rows', { rows: windowRows, window: { startMs: 100, endMs: 200 } }, () => boundRecallRowsToTemporal(windowRows, { startMs: 100, endMs: 200 })),
  await call('root in window', { rows: windowRows, window: { startMs: 0, endMs: 100 } }, () => boundRecallRowsToTemporal(windowRows, { startMs: 0, endMs: 100 })),
  await call('no member in window and root outside', { rows: windowRows, window: { startMs: 300, endMs: 400 } }, () => boundRecallRowsToTemporal(windowRows, { startMs: 300, endMs: 400 })),
  await call('open-ended window', { rows: windowRows, window: { startMs: 200 } }, () => boundRecallRowsToTemporal(windowRows, { startMs: 200 })),
  await call('no window', { rows: windowRows, window: null }, () => boundRecallRowsToTemporal(windowRows, null)),
  await call('row without members', { rows: [{ id: 1, ts: 150 }, { id: 2, ts: 500 }], window: { startMs: 100, endMs: 200 } }, () => boundRecallRowsToTemporal([{ id: 1, ts: 150 }, { id: 2, ts: 500 }], { startMs: 100, endMs: 200 })),
];

const interleave = [];
for (const [hybrid, core] of [
  [[{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], [{ id: 'core:1' }]],
  [[{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], [{ id: 'core:1' }, { id: 'core:2' }]],
  [[{ id: 1 }], [{ id: 'core:1' }, { id: 'core:2' }]],
  [[], [{ id: 'core:1' }]],
  [[{ id: 1 }, { id: 2 }], []],
  [[{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }], [{ id: 'core:1' }, { id: 'core:2' }, { id: 'core:3' }]],
]) interleave.push(await call('interleaveRawRows', { hybrid, core }, () => interleaveRawRows(hybrid, core)));

const uniqueInput = [{ id: 2, content: 'second' }, { id: 1, content: 'first' }, { id: 2, content: 'duplicate' }, { id: '', content: 'dropped' }];
const uniq = [
  await call('test file rows', uniqueInput, () => uniqueRowsById(uniqueInput)),
  await call('null id, zero id, string ids', [{ id: null }, { id: 0 }, { id: '7' }, { id: 7 }, { id: 'a' }, { id: 'a' }], () => uniqueRowsById([{ id: null }, { id: 0 }, { id: '7' }, { id: 7 }, { id: 'a' }, { id: 'a' }])),
  await call('empty', [], () => uniqueRowsById([])),
];
const coverageInput = { content: 'alpha', members: [{ summary: 'beta gamma' }] };
const coverage = [
  await call('test file rows', { row: coverageInput, terms: ['alpha', 'gamma', 'missing'] }, () => topicTermCoverage(coverageInput, ['alpha', 'gamma', 'missing'])),
  await call('no terms', { row: coverageInput, terms: [] }, () => topicTermCoverage(coverageInput, [])),
  await call('case-insensitive match', { row: { content: 'Alpha BETA' }, terms: ['alpha', 'beta'] }, () => topicTermCoverage({ content: 'Alpha BETA' }, ['alpha', 'beta'])),
  await call('summary and element', { row: { summary: 'delta', element: 'epsilon' }, terms: ['delta', 'epsilon'] }, () => topicTermCoverage({ summary: 'delta', element: 'epsilon' }, ['delta', 'epsilon'])),
];

finish(ctx, {
  url: import.meta.url,
  set: 'memory-query-ranking',
  golden: {
    domain: 'memory-query-ranking',
    source: 'src/runtime/memory/lib/query-ranking.test.mjs',
    cases: [
      { name: 'latest recall ranks the newest topic-covered evidence and demotes query echo', probes: latest },
      { name: 'historical merge reserves novel root evidence without replacing the best hit', probes: historical },
      { name: 'temporal bounding keeps an out-of-window root when an in-window member matched', probes: bound },
      { name: 'core memory interleave preserves the leading hybrid result', probes: interleave },
      { name: 'uniqueRowsById keeps first-seen order and topicTermCoverage counts member text', unique: uniq, coverage },
    ],
  },
  extra: {
    entry: { runs: 'rankLatestRecallRows, mergeHistoricalRecallRows, boundRecallRowsToTemporal, uniqueRowsById, topicTermCoverage (query-ranking.mjs) and interleaveRawRows (recall-format.mjs)', notRun: 'the handlers that call them (query-handlers)' },
    replay: 'mixdog-services memory: mem/recall/ranking.rs (latest/historical/bound), mem/recall/format.rs interleave_raw_rows, mem/recall/mod.rs unique_rows_by_id; compares the returned rows in order (whole rows, including _historicalRootSummary on merged rows)',
    exclusions: 'each case holds the probes of the test file first, then further shapes',
    normalised: { 'undefined arguments': 'written as {"$undefined":true}' },
  },
});
process.exit(0);
