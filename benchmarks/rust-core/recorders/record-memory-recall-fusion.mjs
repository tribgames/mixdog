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
    replay: "mixdog-services memory/recall/ranking.rs, the ranking step of Recall::recall (the `memory/recall` request): lane_ranks, rrf_score and rrf_score_with_k, evidence_kind, is_semantic_only, rank_candidates and rank_candidates_with_k (memory/replays/recall_fusion.rs). Compared: every row probe's laneRanks, rrf, rrfK10 (rrf_score_with_k at k 10) and evidence; every ranked probe whole in returned order, at the default k and the explicit k (rank_candidates_with_k); the evidence and semanticOnly probes. Not compared (reported by name in the replay): the probes whose rows no PostgreSQL row can carry, the rows typed by the core's Row: semanticOnly 3-5 (rows null, a string, a null row) and, in the last case, the row probes stringRanks, badRanks, nanId, row null, row undefined and the ranked probe 'string ids and ranks'",
    exclusions: 'the probes named under replay whose rows no PostgreSQL row can carry; the last case holds extra probes the test file does not run',
    normalised: { 'values': 'every value is stored through exact (lib/exact.mjs): an explicit undefined, NaN, -0, Date, Error are tagged; an omitted argument is absent' },
  },
});
process.exit(0);
