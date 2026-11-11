#!/usr/bin/env node
// Node's entry score (src/runtime/memory/lib/memory-score.test.mjs, 1 case) from the real `computeEntryScore`:
// every category of CATEGORY_GRADE at a spread of ages, plus an unknown category, the case-folded names and
// non-finite timestamps, as the SQL function the memory schema installs must give the same numbers.
//
//   node benchmarks/rust-core/recorders/record-memory-score.mjs --tree <dir>
import { begin, capture, finish, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const { CATEGORY_GRADE, computeEntryScore } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory-score.mjs');
const DAY = 86_400_000;
const NOW = 400 * DAY;
const probe = async (category, lastSeenAt, nowMs) => ({ input: { category, lastSeenAt, nowMs }, ...(await capture(() => computeEntryScore(category, lastSeenAt, nowMs))) });

const cases = [{ name: 'all generated categories age uniformly; unknown is null', grades: CATEGORY_GRADE, scores: [] }];
for (const category of Object.keys(CATEGORY_GRADE)) cases[0].scores.push(await probe(category, 0, NOW));
cases[0].scores.push(await probe('unknown', 0, NOW));
cases[0].scores.push(await probe('rule', NOW, NOW));
const more = [];
for (const [category, last, now] of [
  ['rule', 0, NOW], ['RULE', 0, NOW], ['Fact', 100 * DAY, NOW], ['task', NOW - 1, NOW], ['issue', NOW + DAY, NOW], ['goal', 0, 3650 * DAY],
  ['decision', '0', NOW], ['preference', '86400000', NOW], ['constraint', null, NOW], ['constraint', undefined, NOW], ['constraint', Number.NaN, NOW], ['constraint', 'x', NOW],
  ['rule', 0, Number.NaN], ['rule', 0, undefined], ['rule', 0, '34560000000'], [null, 0, NOW], [undefined, 0, NOW], ['', 0, NOW], [' rule', 0, NOW],
]) more.push(await probe(category, last, now));
cases.push({ name: 'case folding, string and non-finite timestamps, future last-seen', scores: more });

finish(ctx, {
  url: import.meta.url,
  set: 'memory-score',
  golden: { domain: 'memory-score', source: 'src/runtime/memory/lib/memory-score.test.mjs', cases },
  extra: {
    entry: { runs: 'computeEntryScore and CATEGORY_GRADE (memory-score.mjs)', notRun: 'the SQL function category_score_params/compute_entry_score the schema installs: Rust replays that one' },
    replay: "No pub Rust fn: the score is the SQL function compute_entry_score (native/core/crates/mixdog-services/src/memory/schema.rs:41) with the category table category_score_params (:31) and the trigger trg_entry_score_recalc (:115). A replay runs the same (category, last_seen_at, now) through that SQL function on a PG with the installed schema (or writes entries through SessionIngest::ingest_session, memory/ingest/mod.rs:133, and reads entries.score) and compares every score and the null answers exactly (f64 equal). Needs MIXDOG_PG_RUNTIME",
    exclusions: 'none',
    normalised: { none: 'no run-dependent value' },
  },
});
process.exit(0);
