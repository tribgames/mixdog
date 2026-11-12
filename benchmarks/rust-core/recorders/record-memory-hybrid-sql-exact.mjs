#!/usr/bin/env node
// Node's exact-term recall leg (src/runtime/memory/lib/recall-hybrid/hybrid-sql-exact.slow.test.mjs, 1 case) from the real
// `openDatabase` (memory.mjs: the bundled PostgreSQL cluster in a private PGDATA, never the user's memory service), the
// real `recallPlan`, `buildHybridQuery` and `buildExactTerms`: the rows the test inserts (mixed Korean/product casing,
// a non-ASCII case pair, NULL columns, `%` `_` `\`), then for every query the exact terms, the hybrid SQL text and
// params Node builds, and the rows the query returned, whole and in the returned order. The recorder stops the cluster and removes the
// private directory on every path (the cluster's processes are the supervisor's: stopPgForShutdown).
//
//   node benchmarks/rust-core/recorders/record-memory-hybrid-sql-exact.mjs --tree <dir>   (set MIXDOG_BENCH_TMP for the private root)
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { begin, finish, importFrom, exact, within } from './lib/mc-record.mjs';

const ctx = begin();
const directory = mkdtempSync(join(tmpdir(), 'mixdog-exact-leg-'));
process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime');
process.env.MIXDOG_DATA_DIR = directory;
const dir = 'src/runtime/memory/lib/';
const { openDatabase, closeDatabase } = await importFrom(ctx.tree, `${dir}memory.mjs`);
const { stopPgForShutdown } = await importFrom(ctx.tree, `${dir}pg/supervisor.mjs`);
const { buildHybridQuery } = await importFrom(ctx.tree, `${dir}recall-hybrid/hybrid-sql.mjs`);
const { recallPlan } = await importFrom(ctx.tree, `${dir}recall-hybrid/plan.mjs`);
const { buildExactTerms } = await importFrom(ctx.tree, `${dir}recall-scoring.mjs`);

const rows = [];
const queries = [];
let ctype = null;
try {
  const db = await within('opening the private memory database', openDatabase(directory, 384, { model: 'isolated-exact-test', dimensions: 384 }), 240_000);
  let seq = 0;
  const insert = async (label, content, element = null, summary = null) => {
    seq += 1;
    const { rows: out } = await db.query(
      `INSERT INTO entries(ts,role,content,source_ref,session_id,project_id,is_root,element,summary,category,status,last_seen_at)
       VALUES ($1,'assistant',$2,$3,'s','p',1,$4,$5,'fact','active',$1)
       RETURNING id, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT AS scored_at`,
      [seq * 1000, content, `exact:${seq}`, element, summary],
    );
    const id = Number(out[0].id);
    // The score trigger (entry-triggers.mjs:15) scores the row at the cluster's NOW() of this statement, read here.
    rows.push({ label, id, ts: seq * 1000, content, element, summary, source_ref: `exact:${seq}`, scoredAtMs: Number(out[0].scored_at) });
    return id;
  };
  const probe = async (query, literal) => {
    const exactTerms = buildExactTerms(query);
    const { sql, params } = buildHybridQuery(recallPlan(query));
    const { rows: out } = await db.query(sql, params);
    // The rows as the database returned them, whole and in the returned order. The statement's last SELECT has no ORDER BY (the
    // ORDER BYs it has are inside its legs): the order below is this cluster's physical/plan order, a tie rule a replay must not rely on.
    queries.push({ query, literal, exactTerms: exact(exactTerms), sql, params: exact(params), finalStatementHasOrderBy: /FROM combined c[\s\S]*ORDER BY/.test(sql), returned: exact(out) });
  };
  const koContent = await insert('ko content', '어제 CLAUDE코드 설정을 바꿨다');
  const koElement = await insert('ko element', '무관한 본문', 'Claude코드 정리');
  const koSummary = await insert('ko summary', '무관한 본문', null, '요약: claude코드 비교');
  const koOther = await insert('ko spaced (not a match)', 'claude 코드 띄어 씀');
  await probe('cLaUdE코드', 'claude코드');
  await insert('umlaut upper', 'DER ÄRGER WAR GROSS');
  await insert('umlaut lower', 'der ärger war gross');
  await insert('umlaut other', 'der arger war gross');
  const { rows: fold } = await db.query(`SELECT 'DER ÄRGER' ILIKE '%ärger%' AS folds`);
  ctype = { ilikeFoldsNonAscii: Boolean(fold[0].folds), reason: 'database ctype of the bundled cluster (C ctype folds ASCII only)' };
  await probe('Ärger', 'ärger');
  await insert('null only', 'nothing here', null, null);
  await insert('null with summary', 'nothing here', null, 'the nullterm lives in the summary');
  await probe('nullterm', 'nullterm');
  await insert('underscore', 'set my_var=1');
  await insert('underscore wildcard look-alike', 'set myXvar=1');
  await probe('my_var', 'my_var');
  await insert('percent', 'ratio a%b here');
  await insert('percent wildcard look-alike', 'ratio aXYZb here');
  await probe('a%b', 'a%b');
  await insert('backslash', 'path x\\y here');
  await insert('backslash other', 'path xy here');
  await probe('x\\y', 'x\\y');
  void [koContent, koElement, koSummary, koOther];
  await closeDatabase(directory);
} finally {
  // Cleanup runs on every path, including a failed stop: stop with a deadline, then remove once (no retry loop); a leftover fails the
  // recording and names the path.
  const problems = [];
  try { await within('stopping the private PostgreSQL cluster', stopPgForShutdown(), 120_000); } catch (error) { problems.push(`stop failed: ${error?.message ?? error}`); }
  try { rmSync(directory, { recursive: true, force: true }); } catch (error) { problems.push(`remove failed: ${error?.message ?? error}`); }
  if (existsSync(directory)) problems.push('the directory still exists');
  if (problems.length) throw new Error(`private cluster left behind at ${directory}: ${problems.join('; ')}`);
}

finish(ctx, {
  url: import.meta.url,
  set: 'memory-hybrid-sql-exact',
  golden: {
    domain: 'memory-hybrid-sql-exact',
    source: 'src/runtime/memory/lib/recall-hybrid/hybrid-sql-exact.slow.test.mjs',
    database: { project_id: 'p', session_id: 's', role: 'assistant', category: 'fact', status: 'active', is_root: 1, embeddingDims: 384, model: 'isolated-exact-test' },
    ctype,
    cases: [{ name: 'the exact-term recall leg matches literal substrings case-insensitively (test line 9)', rows, queries }],
  },
  extra: {
    entry: { runs: 'openDatabase/closeDatabase (memory.mjs) on a private bundled PostgreSQL cluster, stopPgForShutdown (pg/supervisor.mjs), recallPlan (recall-hybrid/plan.mjs), buildHybridQuery (recall-hybrid/hybrid-sql.mjs), buildExactTerms (recall-scoring.mjs)', notRun: 'embeddings: no vectors are inserted, so only the lexical/exact legs return rows (the dense leg has no candidates)' },
    replay: 'mixdog-services memory/recall/hybrid.rs search_relevant_hybrid (the `memory/recall` request, Recall::recall) on a private cluster (MIXDOG_PG_RUNTIME) holding the recorded rows, inserted in order before each probe as here, each scored by the schema\'s compute_entry_score at its recorded scoredAtMs (the trigger\'s expression at the clock it read). Compared per probe: the exact terms, the candidate statement the search sends at its send point (recall/store.rs read_query_pg: text byte for byte and every parameter), and the rows PostgreSQL answered it with, whole and in the returned order',
    exclusions: 'none',
    normalised: { 'private directory': 'temp, not recorded', 'ids': 'serial ids 1..N from a fresh cluster, in insertion order', scoredAtMs: 'the cluster clock the score trigger read at each insert (NOW()): wall-clock time, recorded' },
  },
});
process.exit(0);
