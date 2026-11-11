#!/usr/bin/env node
// Node's entry score (src/runtime/memory/lib/memory-score.test.mjs, 1 case) from the real `computeEntryScore`:
// every category of CATEGORY_GRADE at a spread of ages, plus an unknown category, the case-folded names and
// non-finite timestamps.
// The score the product STORES is not this function's: every write of entries.score goes through the row trigger
// trg_entry_score_recalc (memory-schema/entry-triggers.mjs:15), which calls the SQL compute_entry_score
// (memory-schema/score-params.mjs:46) with entries.category (TEXT) and COALESCE(last_seen_at, ts) / NOW() (BIGINT); the
// manage actions' JavaScript score (manage-actions.mjs:39,92) is written in an UPDATE that also sets `category`, so the
// trigger replaces it. So for every probe whose arguments the trigger can pass (a category string or null, integer or
// null timestamps) the recorder also runs Node's own compute_entry_score on Node's opened memory database (openDatabase,
// memory.mjs, a private bundled PostgreSQL cluster) and records what it answers as `stored` (`{score}`: REAL, as node-pg
// parses it). A probe with an argument no BIGINT/TEXT column can hold (a string or NaN timestamp) gets
// `stored: {noSqlArgument}` naming it.
//
//   node benchmarks/rust-core/recorders/record-memory-score.mjs --tree <dir>
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { begin, capture, finish, importFrom, within } from './lib/mc-record.mjs';

const ctx = begin();
const directory = mkdtempSync(join(tmpdir(), 'mixdog-score-'));
process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime');
process.env.MIXDOG_DATA_DIR = directory;
const { CATEGORY_GRADE, computeEntryScore } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory-score.mjs');
const { openDatabase, closeDatabase } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory.mjs');
const { stopPgForShutdown } = await importFrom(ctx.tree, 'src/runtime/memory/lib/pg/supervisor.mjs');
const DAY = 86_400_000;
const NOW = 400 * DAY;
const probes = [];
const probe = async (category, lastSeenAt, nowMs) => {
  const out = { input: { category, lastSeenAt, nowMs }, ...(await capture(() => computeEntryScore(category, lastSeenAt, nowMs))) };
  probes.push(out);
  return out;
};
const sqlTimestamp = (value) => (value == null ? { ok: null } : Number.isInteger(value) ? { ok: value } : { bad: typeof value === 'number' ? String(value) : `the ${typeof value} ${JSON.stringify(value)}` });

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

// Node's product score for the same probes: its own compute_entry_score on its own installed schema.
try {
  const db = await within('opening the private memory database', openDatabase(directory, 384, { model: 'isolated-score-test', dimensions: 384 }), 240_000);
  for (const out of probes) {
    const { category, lastSeenAt, nowMs } = out.input;
    const last = sqlTimestamp(lastSeenAt);
    const now = sqlTimestamp(nowMs);
    const bad = [last.bad && `lastSeenAt is ${last.bad}`, now.bad && `nowMs is ${now.bad}`].filter(Boolean);
    if (bad.length) { out.stored = { noSqlArgument: `${bad.join('; ')}: no BIGINT column holds it` }; continue; }
    const { rows } = await db.query('SELECT compute_entry_score($1::text, $2::bigint, $3::bigint) AS score', [category ?? null, last.ok, now.ok]);
    out.stored = { score: rows[0].score };
  }
  await closeDatabase(directory);
} finally {
  const problems = [];
  try { await within('stopping the private PostgreSQL cluster', stopPgForShutdown(), 120_000); } catch (error) { problems.push(`stop failed: ${error?.message ?? error}`); }
  try { rmSync(directory, { recursive: true, force: true }); } catch (error) { problems.push(`remove failed: ${error?.message ?? error}`); }
  if (existsSync(directory)) problems.push('the directory still exists');
  if (problems.length) throw new Error(`private cluster left behind at ${directory}: ${problems.join('; ')}`);
}

finish(ctx, {
  url: import.meta.url,
  set: 'memory-score',
  golden: { domain: 'memory-score', source: 'src/runtime/memory/lib/memory-score.test.mjs', cases },
  extra: {
    entry: { runs: 'computeEntryScore and CATEGORY_GRADE (memory-score.mjs: what the test asserts, `result`); compute_entry_score (memory-schema/score-params.mjs:46) on Node\'s opened memory database (openDatabase, memory.mjs; a private bundled PostgreSQL cluster) for every probe the row trigger can pass (`stored`)', notRun: 'the row trigger itself (it reads NOW(), the wall clock): its arguments are passed explicitly' },
    replay: "The product's score is SQL in Node and in the core: the trigger trg_entry_score_recalc (core native/core/crates/mixdog-services/src/memory/schema.rs:115, Node entry-triggers.mjs:15) calls compute_entry_score (core schema.rs:41, Node score-params.mjs:46) on every write of entries.score; Node's JavaScript computeEntryScore (`result`) is replaced by that trigger in the same UPDATE (manage-actions.mjs:39,92 set `category`) and has no core counterpart. A replay (mixdog-services memory/replays/score.rs) runs the core's compute_entry_score on a private cluster with the core's installed schema (needs MIXDOG_PG_RUNTIME) over each probe's input and compares `stored` whole: the score as REAL (f32 equal to node-pg's parsed number) or null, and every `noSqlArgument` probe is one whose input the replay's argument mapping also refuses",
    exclusions: 'none',
    normalised: { none: 'no run-dependent value' },
  },
});
process.exit(0);
