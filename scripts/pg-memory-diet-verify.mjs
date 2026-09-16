import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { profile, fingerprint, recallCases, readManifest } from './pg-memory-diet.mjs';
import { recallSubstringPredicate } from '../src/runtime/memory/lib/recall-substring-predicate.mjs';
import { prepareSessionIndexes, commitSessionIndexes } from '../src/runtime/memory/lib/pg/compact-indexes.mjs';

const workspace = resolve(process.argv[2]);
const manifest = await readManifest(workspace);
if (!manifest.prepared || manifest.port === manifest.sourcePort)
  throw new Error('A prepared isolated clone is required');
const c = new pg.Client({
  host: '127.0.0.1',
  port: manifest.port,
  database: 'mixdog',
  user: 'postgres',
  password: '',
  connectionTimeoutMillis: 5000,
});
const report = { checks: [], failures: [] };
const check = (name, actual, expected) => {
  try {
    assert.deepEqual(actual, expected);
    report.checks.push(name);
  } catch (error) {
    report.failures.push({ name, error: error.message.slice(0, 1800) });
  }
};
try {
  await c.connect();
  const dataDir = (await c.query('SHOW data_directory')).rows[0].data_directory;
  assert.equal(
    resolve(dataDir).toLowerCase(),
    resolve(manifest.cloneDir).toLowerCase(),
    'Refusing a non-clone database'
  );
  await c.query("SET timezone='UTC'; SET search_path=memory,public");
  const strings = [null, '', 'sqlite', 'SQLITE', 'sql_ite', '100%', 'a\\b', 'a_b', '메모리', ' x ', "a'b"];
  const terms = [null, '', '%', '%%', '_', '\\', 'a\\', 'sqlite', 'sql%', 'a_b', '메모리', "'", '%_', '\\%'];
  const combinations = await c.query(
    `
        WITH texts AS (SELECT * FROM unnest($1::text[]) WITH ORDINALITY AS t(value,id)),
             terms AS (SELECT * FROM unnest($2::text[]) WITH ORDINALITY AS q(term,id)),
             old_rows AS (SELECT t.id AS t,q.id AS q FROM texts t CROSS JOIN terms q
                WHERE coalesce(t.value,'') ILIKE '%' || q.term || '%'),
             new_rows AS (SELECT t.id AS t,q.id AS q FROM texts t CROSS JOIN terms q
                WHERE ${recallSubstringPredicate('t.value', 'q.term')})
        SELECT * FROM ((SELECT * FROM old_rows EXCEPT SELECT * FROM new_rows)
            UNION ALL (SELECT * FROM new_rows EXCEPT SELECT * FROM old_rows)) differences
    `,
    [strings, terms]
  );
  check('NULL, Unicode, empty terms and SQL wildcard equivalence', combinations.rows, []);
  const baseline = JSON.parse(await readFile(join(workspace, 'recall-baseline.json'), 'utf8'));
  const candidate = await recallCases(c, manifest.clock);
  for (let i = 0; i < baseline.length; i++)
    check(`recall:${baseline[i].query}`, candidate[i].result, baseline[i].result);
  report.recallTimes = candidate.map((entry, i) => ({
    query: entry.query,
    beforeMs: baseline[i].ms,
    afterMs: entry.ms,
  }));
  // Do not make a storage change when the search-result gate has failed.
  if (!report.failures.length) {
    const before = await profile(c);
    const sessionCases = [];
    for (const [schema, table, order] of [
      ['memory', 'entries', 'ts DESC,id DESC'],
      ['trace', 'trace_events', 'ts DESC,id DESC'],
      ['trace', 'agent_calls', 'iteration,id'],
      ['trace', 'agent_llm', 'iteration,id'],
    ]) {
      const ids = (
        await c.query(`SELECT session_id,COUNT(*) AS n FROM ${schema}.${table}
                WHERE session_id IS NOT NULL GROUP BY session_id ORDER BY COUNT(*) DESC LIMIT 3`)
      ).rows;
      for (const { session_id } of ids) {
        const sql = `SELECT id,ts,session_id FROM ${schema}.${table} WHERE session_id=$1 ORDER BY ${order} LIMIT 240`;
        const start = performance.now();
        const expected = (await c.query(sql, [session_id])).rows;
        sessionCases.push({ schema, table, sql, id: session_id, expected, ms: performance.now() - start });
      }
    }
    const prepared = await prepareSessionIndexes(c);
    await writeFile(join(workspace, 'candidate-indexes.json'), JSON.stringify(prepared, null, 2));
    await commitSessionIndexes(c, prepared);
    report.sessionTimes = [];
    for (const entry of sessionCases) {
      const start = performance.now();
      const rows = (await c.query(entry.sql, [entry.id])).rows;
      const ms = performance.now() - start;
      check(`session:${entry.schema}.${entry.table}:${entry.id}`, rows, entry.expected);
      report.sessionTimes.push({
        table: `${entry.schema}.${entry.table}`,
        beforeMs: Math.round(entry.ms),
        afterMs: Math.round(ms),
      });
    }
    const afterRecall = await recallCases(c, manifest.clock);
    for (let i = 0; i < baseline.length; i++)
      check(`post-index recall:${baseline[i].query}`, afterRecall[i].result, baseline[i].result);
    const original = JSON.parse(await readFile(join(workspace, 'original-data.json'), 'utf8'));
    check('all original table row counts and digests', await fingerprint(c), original);
    report.beforeProfile = before;
    report.afterProfile = await profile(c);
    await writeFile(join(workspace, 'candidate-profile.json'), JSON.stringify(report.afterProfile));
  }
  await writeFile(join(workspace, 'verification.json'), JSON.stringify(report, null, 2));
} finally {
  await c.end();
}
const output = JSON.stringify(
  {
    passed: report.failures.length === 0,
    checks: report.checks.length,
    failures: report.failures,
    recallTimes: report.recallTimes,
    sessionTimes: report.sessionTimes,
  },
  null,
  2
);
process.stdout.write(`${output}\n`, () => process.exit(report.failures.length ? 1 : 0));
