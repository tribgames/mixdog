#!/usr/bin/env node
// Node's recall fusion (src/runtime/memory/lib/recall-fusion.test.mjs, 4 cases) from the real recall-fusion.mjs: the
// rows of the test file plus further rank/similarity shapes, with every function's answer: lane ranks, RRF score
// (default k and an explicit k), evidence kind, the ranked order with its scores, and isSemanticOnlyRecall.
//
//   node benchmarks/rust-core/recorders/record-memory-recall-fusion.mjs --tree <dir>
import { begin, capture, finish, importFrom, exact } from './lib/mc-record.mjs';

const ctx = begin();
const m = await importFrom(ctx.tree, 'src/runtime/memory/lib/recall-fusion.mjs');
const { isSemanticOnlyRecall, rankRecallCandidates, recallEvidenceKind, recallLaneRanks, recallRrfScore } = m;

const rows = {
  denseOnly: { id: 1, dense_rank: 1, dense_sim: 0.8 },
  lexicalOnly: { id: 2, sparse_rank: 1 },
  both: { id: 3, dense_rank: 2, sparse_rank: 2 },
  oneLexicalHit: { id: 1, sparse_rank: 4 },
  threeLexicalHits: { id: 2, sparse_rank: 4, trgm_rank: 8, exact_rank: 12 },
  negativeSim: { id: 1, dense_rank: 1, dense_sim: -1 },
  nanSim: { id: 2, dense_rank: 2, dense_sim: Number.NaN },
  goodSim: { id: 3, dense_rank: 3, dense_sim: 0.8 },
  zeroSim: { id: 4, dense_rank: 1, dense_sim: 0 },
  stringRanks: { id: '5', dense_rank: '2', dense_sim: '0.5', sparse_rank: '3' },
  badRanks: { id: 6, dense_rank: 0, sparse_rank: -1, trgm_rank: 1.5, exact_rank: 'x' },
  exactOnly: { id: 7, exact_rank: 2 },
  trgmOnly: { id: 8, trgm_rank: 1 },
  noId: { dense_rank: 1, dense_sim: 0.4 },
  nanId: { id: 'abc', sparse_rank: 1 },
  empty: {},
};
const rowProbes = [];
for (const [name, row] of Object.entries(rows)) {
  rowProbes.push({
    name,
    row: exact(row),
    laneRanks: (await capture(() => recallLaneRanks(row))),
    rrf: (await capture(() => recallRrfScore(row))),
    rrfK10: (await capture(() => recallRrfScore(row, 10))),
    evidence: (await capture(() => recallEvidenceKind(row))),
  });
}
for (const value of [null, undefined]) {
  rowProbes.push({ name: `row ${value}`, row: exact(value), laneRanks: await capture(() => recallLaneRanks(value)), rrf: await capture(() => recallRrfScore(value)), evidence: await capture(() => recallEvidenceKind(value)) });
}
const rankProbes = [];
for (const [name, list, k] of [
  ['dense, lexical and both', [rows.denseOnly, rows.lexicalOnly, rows.both]],
  ['invalid dense similarity abstains', [rows.negativeSim, rows.nanSim, rows.goodSim]],
  ['ties by id', [rows.lexicalOnly, rows.denseOnly, rows.exactOnly, rows.trgmOnly]],
  ['string ids and ranks', [rows.stringRanks, rows.badRanks, rows.noId, rows.nanId, rows.zeroSim]],
  ['explicit k', [rows.denseOnly, rows.lexicalOnly, rows.both], 10],
  ['null list', null],
  ['empty list', []],
]) {
  rankProbes.push({ name, rows: exact(list), k: k ?? 'default', explicitK: k !== undefined, ...(await capture(() => rankRecallCandidates(list, k))) });
}
const semanticProbes = [];
for (const list of [
  [{ _retrievalEvidence: 'semantic' }, { _retrievalEvidence: 'semantic' }],
  [{ _retrievalEvidence: 'semantic' }, { _retrievalEvidence: 'lexical' }],
  [], null, 'x', [null], [{ _retrievalEvidence: 'semantic' }],
]) semanticProbes.push({ rows: exact(list), ...(await capture(() => isSemanticOnlyRecall(list))) });

finish(ctx, {
  url: import.meta.url,
  set: 'memory-recall-fusion',
  golden: {
    domain: 'memory-recall-fusion',
    source: 'src/runtime/memory/lib/recall-fusion.test.mjs',
    cases: [
      { name: 'recall fusion gives dense and lexical retrieval one equal RRF lane each', ranked: rankProbes[0], rows: rowProbes.filter((p) => ['denseOnly', 'lexicalOnly', 'both'].includes(p.name)) },
      { name: 'multiple lexical candidate generators do not multiply lexical weight', rows: rowProbes.filter((p) => ['oneLexicalHit', 'threeLexicalHits'].includes(p.name)) },
      { name: 'fixed RRF abstains only from invalid or non-positive semantic evidence', ranked: rankProbes[1], rows: rowProbes.filter((p) => ['negativeSim', 'nanSim', 'goodSim'].includes(p.name)) },
      { name: 'semantic-only retrieval is explicit without changing RRF ordering', evidence: rowProbes.filter((p) => ['denseOnly', 'lexicalOnly'].includes(p.name)).map((p) => ({ name: p.name, evidence: p.evidence })), semanticOnly: semanticProbes },
      { name: 'further shapes (beyond the test file)', rows: rowProbes, ranked: rankProbes.slice(2) },
    ],
  },
  extra: {
    entry: { runs: 'recallLaneRanks, recallRrfScore, recallEvidenceKind, isSemanticOnlyRecall, rankRecallCandidates (recall-fusion.mjs)', notRun: 'nothing beyond the module' },
    replay: 'the public call is the `memory/recall` request (mixdog-services memory/service.rs:273 -> Recall::recall, recall/mod.rs:240 -> search_relevant_hybrid, recall/hybrid.rs:743), whose ranking step is rank_candidates / rrf_score / evidence_kind (recall/ranking.rs:27,59); Node reaches the same step from memory-recall-store.mjs:76 (rankRecallCandidates(rows), default k only). The recording holds the whole ranked candidates (every field, in returned order); a replay feeds the same lane ranks through a recall over a database holding rows with those ranks, or through the ranking functions in a crate test, and compares scores exactly (f64) and the order. EXPLICIT-k PROBES (rrfK10, the `explicit k` ranking): Rust rrf_score has no k parameter (ranking.rs:27) and no Node production call passes one (only memory-recall-store.mjs:76 with the default 60), so no public call reaches them: they are listed as needing a Rust change (add k) only if the Rust side wants parity with the test file; a replay without the parameter skips them by the `explicitK`/`rrfK10` marker. Rows with string ids/ranks, negative or fractional ranks are JS-coercion shapes: a replay with typed rows replays the numeric ones',
    exclusions: 'the last case holds extra probes the test file does not run; explicit-k probes need a Rust change (see replay)',
    normalised: { 'non-finite numbers': 'NaN is written as {"$number":"NaN"}; undefined as {"$undefined":true}' },
  },
});
process.exit(0);
